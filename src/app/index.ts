import "./boot.ts";
import "../dashboard/index.ts";
import { go, readerUrl } from "./boot.ts";
import { autoCheck, skipVersion } from "./update.ts";
import { localStorage } from "../sync/storage.ts";
import { ARCHIVES_KEY, type ArchiveManifest } from "../archive/types.ts";
import { cachedBlob } from "../archive/cache.ts";
import { hostnameOf } from "../lib/url.ts";
import type { Article } from "../types.ts";
import { formatDuration } from "../lib/stats.ts";
import { importEpub } from "../books/import.ts";
import { coverUrl, deleteBook, getBook, importHash, listBooks, localSink, saveBook } from "../books/local.ts";
import { canOpenBooks, openEpub, pickEpub } from "../books/native.ts";
import { chapterId, nextChapter, type Book } from "../books/types.ts";

/**
 * App 首页 = 扩展的 dashboard（文章 / 复习 / 生词本），外加一个"文章从哪来"的入口：
 * 粘贴地址，或者从别的 App 分享过来（宿主把分享的文本放在 ?share= 里）。
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 从一段文本里挑出第一个网址：分享过来的往往是"标题 + 链接"。 */
function pickUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>"']+/i.exec(text);
  return m ? m[0].replace(/[),.;!?]+$/, "") : null;
}

const hint = $("add-hint");

// Saved articles need an entry even before their first reading session exists.
const savedSection = document.createElement("details");
savedSection.open = true;
savedSection.hidden = true;
savedSection.className = "blacklist-section";
const savedSummary = document.createElement("summary");
savedSummary.textContent = "插件保存的文章";
const savedList = document.createElement("div");
savedList.className = "list";
savedSection.append(savedSummary, savedList);
document.getElementById("book-section")?.after(savedSection);
let archiveRender = 0;
async function renderSavedArticles(): Promise<void> {
  const turn = ++archiveRender;
  const data = await localStorage().get(ARCHIVES_KEY);
  const archives = Object.values((data[ARCHIVES_KEY] ?? {}) as Record<string, ArchiveManifest>)
    .sort((a, b) => b.createdTs - a.createdTs);
  const fragment = document.createDocumentFragment();
  for (const archive of archives) {
    const item = document.createElement("div");
    item.className = "card";
    const title = document.createElement("div");
    title.className = "title";
    const link = document.createElement("a");
    link.href = readerUrl(archive.url);
    link.textContent = archive.title || archive.url;
    title.append(link);
    const meta = document.createElement("p");
    meta.className = "muted small";
    const available = await cachedBlob(archive.htmlHash).then(Boolean, () => false);
    meta.textContent = `${hostnameOf(archive.url)} · ${available ? "正文已下载" : "打开以下载正文和图片"}`;
    if (archive.missingResources?.length) meta.textContent += ` · ${archive.missingResources.length} 项资源未保存`;
    item.append(title, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      if (!confirm(`删除「${archive.title || archive.url}」及其存档、阅读记录和文章回顾？划词与生词卡保留，删除会同步到其他设备。`)) return;
      remove.disabled = true;
      void chrome.runtime.sendMessage({ type: "articles:delete", articleIds: [archive.articleId] }).then(async (result: { ok?: boolean; error?: string }) => {
        if (!result?.ok) throw new Error(result?.error || "删除失败");
        await renderSavedArticles();
      }).catch((err: unknown) => { remove.disabled = false; meta.textContent = err instanceof Error ? err.message : String(err); });
    });
    item.append(remove);
    fragment.append(item);
  }
  if (turn !== archiveRender) return;
  savedList.replaceChildren(fragment);
  savedSection.hidden = archives.length === 0;
  savedSummary.textContent = `插件保存的文章（${archives.length}）`;
}
void renderSavedArticles();
window.addEventListener("focus-sync-updated", () => { void renderSavedArticles(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[ARCHIVES_KEY]) void renderSavedArticles();
});

$("add").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = pickUrl($<HTMLInputElement>("add-url").value);
  if (!url) {
    hint.hidden = false;
    hint.textContent = "没认出网址，得是 http(s):// 开头的地址。";
    return;
  }
  location.href = readerUrl(url);
});

const shared = new URLSearchParams(location.search).get("share");
if (shared) {
  const url = pickUrl(shared);
  if (url) location.replace(readerUrl(url));
  else {
    hint.hidden = false;
    hint.textContent = "分享过来的内容里没有网址。";
  }
}

/* ==================== 书架 ==================== */

/*
 * 书和文章摆在同一个分栏里：读完一章和读完一篇文章是同一件事，只是书多一层目录。
 * 章的阅读记录、划词、复习都由下面那一层自己管，这儿只负责"哪本书、第几节、读到哪了"。
 */

const bookRow = $("book-row");
const bookSection = $("book-section");
const bookStatus = $("book-status");
const bookList = $("book-list");
/** 封面的临时地址，重画前逐个回收。 */
let coverUrls: string[] = [];
let openBookId = new URLSearchParams(location.search).get("book") ?? "";
let importing = false;
let shelfDrawn = false;

const say = (text: string): void => { bookStatus.textContent = text; };

function chapterRow(book: Book, index: number, title: string, words: number, done: boolean): HTMLElement {
  const item = document.createElement("div");
  item.className = "card chapter-row";
  const link = document.createElement("a");
  link.href = readerUrl(chapterId(book.id, index));
  link.textContent = `${index + 1}. ${title}`;
  const meta = document.createElement("span");
  meta.className = "muted small";
  meta.textContent = `${words} 字${done ? " · 已读完" : ""}`;
  item.append(link, meta);
  return item;
}

async function renderBooks(): Promise<void> {
  const books = await listBooks();
  const res = (await chrome.runtime.sendMessage({ type: "articles:list" })) as { articles?: Article[] };
  const finished = new Set((res.articles ?? []).filter(a => a.finished).map(a => a.id));
  const records = new Map((res.articles ?? []).map(a => [a.id, a]));
  for (const url of coverUrls) URL.revokeObjectURL(url);
  coverUrls = [];

  const fragment = document.createDocumentFragment();
  for (const book of books) {
    const done = new Set(book.chapters.filter(c => finished.has(chapterId(book.id, c.index))).map(c => c.index));
    const card = document.createElement("div");
    card.className = "card book-card";

    const row = document.createElement("div");
    row.className = "row1";
    const cover = await coverUrl(book);
    if (cover) {
      coverUrls.push(cover);
      const img = document.createElement("img");
      img.className = "book-cover";
      img.src = cover;
      img.alt = "";
      row.append(img);
    }
    const title = document.createElement("div");
    title.className = "title";
    const open = document.createElement("a");
    open.href = readerUrl(chapterId(book.id, nextChapter(book, done)));
    open.textContent = book.title;
    title.append(open);
    const pill = document.createElement("span");
    pill.className = `pill${done.size === book.chapters.length ? " done" : ""}`;
    pill.textContent = `${done.size}/${book.chapters.length}`;
    row.append(title, pill);

    const sub = document.createElement("div");
    sub.className = "sub";
    const words = book.chapters.reduce((n, c) => n + c.words, 0);
    // 读了多久、读了多少，从每一节的记录现算，书本身不存进度
    const tracked = book.chapters.flatMap(c => records.get(chapterId(book.id, c.index)) ?? []);
    const read = tracked.reduce((n, a) => n + a.wordsRead, 0);
    const ms = tracked.reduce((n, a) => n + a.totalMs, 0);
    for (const part of [book.author, `${book.chapters.length} 节`, `约 ${words.toLocaleString("zh-CN")} 字`,
      ms > 0 ? `已读 ${read.toLocaleString("zh-CN")} 字 · ${formatDuration(ms)}` : "还没读过",
      book.missingResources > 0 ? `${book.missingResources} 张图未保存` : ""]) {
      if (part) sub.append(Object.assign(document.createElement("span"), { textContent: part }));
    }

    const toc = document.createElement("details");
    toc.className = "book-toc";
    const summary = document.createElement("summary");
    summary.textContent = "目录";
    const chapters = document.createElement("div");
    chapters.className = "list";
    toc.append(summary, chapters);
    // 一本书上千节的话，展开时才画：书架本身不该为没人看的目录卡住
    const fill = (): void => {
      if (chapters.childElementCount > 0) return;
      const list = document.createDocumentFragment();
      for (const c of book.chapters) list.append(chapterRow(book, c.index, c.title, c.words, done.has(c.index)));
      chapters.append(list);
    };
    toc.addEventListener("toggle", () => { if (toc.open) fill(); });
    if (book.id === openBookId) { toc.open = true; fill(); }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      if (!confirm(`删除《${book.title}》？这本书的正文、图片和每一节的阅读记录都会清掉，划词与生词卡保留。`)) return;
      remove.disabled = true;
      void deleteBook(book.id)
        .then(() => renderBooks())
        .catch((err: unknown) => { remove.disabled = false; say(err instanceof Error ? err.message : String(err)); });
    });

    card.append(row, sub, toc, remove);
    fragment.append(card);
  }
  bookList.replaceChildren(fragment);
  bookSection.hidden = books.length === 0;
  if (books.length > 0) {
    // 只在第一次画的时候展开：用户收起来之后，一次同步或一次导入不该把它又掀开
    if (!shelfDrawn) (bookSection as HTMLDetailsElement).open = true;
    shelfDrawn = true;
    $("book-summary").textContent = `我的书（${books.length}）`;
  }
}

/**
 * 导入一个 EPUB。`uri` 来自系统的"用别的应用打开"，没有就自己弹文件选择器。
 *
 * 同一个文件再导一次不会重来一遍：书的 id 就是文件内容的哈希，已经在书架上的直接打开，
 * 上次读到哪还在哪。
 */
async function importBook(uri?: string): Promise<void> {
  if (importing) return;
  importing = true;
  $<HTMLButtonElement>("import-book").disabled = true;
  try {
    say("正在打开文件…");
    const picked = uri ? { uri, name: "" } : await pickEpub();
    if (!picked) { say(""); return; }
    const handle = await openEpub(picked.uri);
    try {
      const existing = await getBook(handle.hash);
      const book = existing ?? await importEpub(
        { names: handle.names, bytes: handle.bytes },
        handle.hash,
        picked.name || "未命名的书.epub",
        {
          parse: (text, mime) => new DOMParser().parseFromString(text, mime),
          doc: document,
          hash: importHash,
          sink: localSink(),
          onProgress: (done, total) => say(`正在导入…${done}/${total} 节`),
        },
      );
      if (!existing) await saveBook(book);
      openBookId = book.id;
      await renderBooks();
      say(existing ? `《${book.title}》已经在书架上了` : `《${book.title}》导入完成，共 ${book.chapters.length} 节`);
    } finally {
      handle.close();
    }
  } catch (err) {
    say(`导入失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    importing = false;
    $<HTMLButtonElement>("import-book").disabled = false;
  }
}

if (canOpenBooks()) {
  bookRow.hidden = false;
  $("import-book").addEventListener("click", () => void importBook());
}
void renderBooks();
window.addEventListener("focus-sync-updated", () => { void renderBooks(); });

// 从文件管理器里点开一个 EPUB：宿主把 content:// 地址放在 ?epub= 里送过来
const sharedBook = new URLSearchParams(location.search).get("epub");
if (sharedBook) void importBook(sharedBook);

/*
 * 开 App 时问一次有没有新版本（一天最多一次，设置页能关，详见 update.ts）。
 *
 * 只在页首挂一条能划掉的横幅，不弹窗：来这儿是为了读文章，
 * 「有新版本」永远不比手头这篇要紧。真要更新在设置页里点。
 */
void (async () => {
  const update = await autoCheck();
  if (!update) return;
  const bar = document.createElement("div");
  bar.className = "update-bar";
  const text = document.createElement("span");
  text.textContent = `有新版本 ${update.version}`;
  const open = document.createElement("a");
  open.href = "options.html#update";
  open.textContent = "去更新";
  open.addEventListener("click", (e) => {
    e.preventDefault();
    void go("options.html#update");
  });
  const no = document.createElement("button");
  no.type = "button";
  no.className = "mini";
  no.textContent = "不用了";
  no.addEventListener("click", () => {
    // 只跳过这一个版本；下一个照常提示
    skipVersion(update.version);
    bar.remove();
  });
  bar.append(text, open, no);
  document.querySelector("header")?.after(bar);
})();
