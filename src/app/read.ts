import "./boot.ts";
import { Readability } from "@mozilla/readability";
import type { ReaderFetch, Snippet } from "../types.ts";
import { go, navigation, readerUrl, shim } from "./boot.ts";
import { hostHooks, inApp, native } from "./native.ts";
import { sanitizeArticle } from "./sanitize.ts";
import { extractFromContainer } from "../content/paragraphs.ts";
import { cancelRegion } from "../content/screenshot.ts";
import { startTracking, type TrackController } from "../content/track.ts";
import { formatEstimate } from "../lib/readingTime.ts";
import { fillMeta } from "../lib/speak.ts";
import { hostnameOf, normalizeUrl } from "../lib/url.ts";
import { decodeWith, hasBom, pickCharset } from "../lib/charset.ts";
import { recordFetch } from "../background/appLog.ts";
import { READER_PREFIX } from "../background/store.ts";
import { localStorage } from "../sync/storage.ts";
import { loadArchivedArticle, hydrateArchiveImages } from "../archive/reader.ts";
import type { ArchiveManifest } from "../archive/types.ts";
import { getBook, hydrateBookImages } from "../books/local.ts";
import { chapterId, parseChapterId, type Book, type BookChapterContent } from "../books/types.ts";

/**
 * 阅读器：抓一篇网页的正文、洗干净、排成适合手机看的样子，然后把扩展在网页上做的
 * 那一整套（session、段落停留、划词翻译、读完角标、跳回上次位置）原样跑在这份正文上。
 *
 * 正文只抓一次，存在 `rh:<articleId>` 下：再次打开秒开、断网也能看。
 *
 * 书里的一章走的是同一条路，只是正文不从网上抓，导入那会儿就已经躺在同一个键下了
 * （见 books/import.ts）。往下的一切——段落、划词、读完角标、跳回上次位置——不区分两者。
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 存下来的正文。 */
interface CachedArticle {
  /** 用户给的地址（分享过来的、粘贴的），缓存按它查。 */
  url: string;
  /**
   * 跟完重定向之后的地址。文章记录按**它**归一化：分享出来的链接常带一跳
   * （短链、跳转页），电脑上的扩展看到的是落地之后的地址，两边要合到同一条记录就得用同一个。
   * `m.` 子域这类同文异址仍然合不到一起，只能认了。
   */
  finalUrl: string;
  title: string;
  /** 洗过的正文 HTML。 */
  html: string;
  savedTs: number;
  archiveManifest?: ArchiveManifest;
  /** 书里的一章。带着它的图片清单，打开时按清单从本机的资源库里取。 */
  book?: BookChapterContent["book"];
}

const cacheKey = (articleId: string): string => READER_PREFIX + articleId;

/** 抓网页时报的 UA，宿主没设的话就用这个。桌面版 UA 拿到的页面往往更完整。 */
const ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 抓一页回来，解码、抽正文、洗干净。
 *
 * 成功失败都往诊断日志里记一条现场（编码是谁定的、掉了多少字节、抽出多长）：
 * 手机上没有控制台，不记的话出了岔子只剩界面上那一句话。
 */
async function fetchAndExtract(url: string): Promise<CachedArticle> {
  const started = Date.now();
  const log: ReaderFetch = {
    ts: started,
    url,
    finalUrl: null,
    status: null,
    contentType: null,
    charset: null,
    charsetFrom: null,
    bytes: null,
    bom: false,
    fellBack: false,
    replacementChars: null,
    title: null,
    chars: null,
    error: null,
    ms: 0,
  };
  try {
    const res = await fetch(url, { headers: { Accept: ACCEPT } });
    log.status = res.status;
    log.contentType = res.headers.get("content-type");
    if (!res.ok) throw new Error(`网页返回了 HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    log.bytes = bytes.length;
    log.bom = hasBom(bytes);
    const pick = pickCharset(log.contentType, bytes);
    log.charset = pick.charset;
    log.charsetFrom = pick.from;
    const decoded = decodeWith(bytes, pick.charset);
    log.fellBack = decoded.fellBack;
    log.replacementChars = decoded.replacementChars;
    // 宿主跟随重定向后把最终地址放在这个头里；相对链接要按它补全
    const finalUrl = res.headers.get("x-fs-final-url") || res.url || url;
    log.finalUrl = finalUrl;

    const doc = new DOMParser().parseFromString(decoded.text, "text/html");
    const base = doc.createElement("base");
    base.href = finalUrl;
    doc.head.prepend(base);
    const parsed = new Readability(doc.cloneNode(true) as Document).parse();
    const article: CachedArticle = {
      url,
      finalUrl,
      title: (parsed?.title || doc.title || url).replace(/\s+/g, " ").trim(),
      html: sanitizeArticle(parsed?.content || doc.body.innerHTML, finalUrl),
      savedTs: Date.now(),
    };
    log.title = article.title;
    log.chars = article.html.length;
    return article;
  } catch (err) {
    log.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    log.ms = Date.now() - started;
    // 不 await：这一条记不下来也不该拖住正文显示
    void recordFetch(log);
  }
}

function showStatus(text: string, retry?: () => void): void {
  const box = $("article");
  box.textContent = "";
  const p = el("p", "status", text);
  box.append(p);
  if (retry) {
    const btn = el("button", "mini", "重试");
    btn.addEventListener("click", retry);
    p.append(el("br"), btn);
  }
}

let ctl: TrackController | null = null;
let leaving = false;

// 后台发起的换页（读完角标的「回顾这篇」、浮层里的「去设置」）也要先结算最后一段
navigation.beforeLeave = async () => {
  ctl?.stop("unload");
};

/** 返回键：把最后一段结算掉、等写入落盘，再让宿主回退，否则这一段阅读就丢了。 */
async function leave(): Promise<void> {
  if (leaving) return;
  leaving = true;
  ctl?.stop("unload");
  await shim.flush();
  const bridge = native();
  if (bridge?.navigateBack) bridge.navigateBack();
  else if (history.length > 1) history.back();
  else location.href = "index.html";
}

/** 顶栏第二行最左边那一格：网页显示域名，书显示书名和这是第几节。 */
let sourceLabel = "";

function renderMeta(url: string): void {
  const st = ctl?.state();
  $<HTMLButtonElement>("translate-here").disabled = st?.translateHere !== "available";
  $("translate-here").title = st?.translateHere === "on" ? "本页划词翻译已开启" : "启用本页划词翻译";
  const parts = [sourceLabel || hostnameOf(url)];
  if (st?.tracked) {
    const tracked = st.trackedWords ?? 0;
    const read = st.wordsRead ?? 0;
    const pct = tracked > 0 ? Math.min(100, Math.round((read / tracked) * 100)) : 0;
    parts.push(`已读 ${pct}%`);
    const est = st.estimate;
    if (est && est.words > 0) parts.push("还需" + formatEstimate(est.ms));
    else if (tracked > 0 && read >= tracked) parts.push("已读完");
    if (st.activeSince) parts.push("计时中");
  } else if (st?.reason) {
    parts.push(st.reason);
  }
  $("rmeta").textContent = parts.join(" · ");
}

/* ==================== 本文生词 ==================== */

async function loadWords(articleId: string): Promise<Snippet[]> {
  const res = (await chrome.runtime.sendMessage({ type: "snippets:list", articleId })) as { snippets?: Snippet[] };
  return res?.snippets ?? [];
}

function renderWords(list: Snippet[]): void {
  const box = $("sheet-list");
  box.textContent = "";
  if (list.length === 0) {
    box.append(el("div", "empty", "这篇还没有翻译记录。单击英文单词翻译该词，双击翻译当前句子。"));
    return;
  }
  for (const s of list) {
    const item = el("div", "item");
    item.append(el("div", "t", s.text));
    const meta = el("div", "m");
    if (fillMeta(meta, { phonetic: s.phonetic, pos: s.pos, word: s.text })) item.append(meta);
    item.append(el("div", "tr", s.translation));
    if (s.contextNote) item.append(el("div", "n", s.contextNote));
    if (s.usage) item.append(el("div", "u", s.usage));
    if (s.vocab.length > 0) {
      const vocab = el("div", "vocab");
      for (const v of s.vocab) {
        const one = el("div", "v");
        const head = el("div");
        head.append(el("span", "vw", v.word));
        const m = el("span", "vm");
        if (fillMeta(m, { phonetic: v.phonetic, pos: v.pos, word: v.word })) head.append(m);
        one.append(head, el("div", "vd", v.meaning));
        if (v.note) one.append(el("div", "vn", v.note));
        vocab.append(one);
      }
      item.append(vocab);
    }
    box.append(item);
  }
}

/* ==================== 启动 ==================== */

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const url = params.get("u")?.trim() ?? "";
  $("back").addEventListener("click", () => void leave());
  $("shot").addEventListener("click", () => ctl?.screenshot());
  $("translate-here").addEventListener("click", () => { ctl?.translateHere(); renderMeta(url); });

  /* 本文生词那张单子的开合。返回键要先问它，所以在 beforeBack 之前就备好。 */
  const sheet = $("sheet");
  const backdrop = $("sheet-backdrop");
  const setSheet = (open: boolean): void => {
    sheet.hidden = !open;
    backdrop.hidden = !open;
  };
  backdrop.addEventListener("click", () => setSheet(false));

  hostHooks.beforeBack = () => {
    if (cancelRegion()) return true;
    // 单子开着时先收单子：手机上"返回"关掉的是最上面那一层，不是整个页面
    if (!sheet.hidden) {
      setSheet(false);
      return true;
    }
    void leave();
    return true;
  };

  /** 这一页是书里的一章还是一个网址。 */
  const chapter = parseChapterId(url);
  if (!/^https?:\/\//i.test(url) && !chapter) {
    $("rtitle").textContent = "没有文章";
    showStatus("地址不对。从首页粘贴一个网页地址，或者从浏览器把网页分享到这个 App。");
    return;
  }
  $("rmeta").textContent = hostnameOf(url);

  // 缓存按用户给的地址查：抓之前还不知道它会跳到哪
  const key = cacheKey(normalizeUrl(url));
  const refresh = params.get("refresh") === "1";
  let cached = (await localStorage().get(key))[key] as CachedArticle | undefined;
  let book: Book | null = null;
  if (chapter) {
    // 书的正文导入时就存好了，这儿不联网也不重抓：找不到只能是这本书被删了或没导完
    book = await getBook(chapter.bookId);
    if (!cached?.book || !book) {
      $("rtitle").textContent = "这一章不在本机";
      showStatus("这本书没有导入完整，或者已经被删掉了。回首页重新导入这个 EPUB 就能接着读。");
      return;
    }
    sourceLabel = `${book.title} · 第 ${chapter.index + 1}/${book.chapters.length} 节`;
    $("rmeta").textContent = sourceLabel;
  }
  let archiveError: unknown;
  let archived = false;
  try {
    const saved = chapter ? null : await loadArchivedArticle(url);
    if (saved) {
      cached = saved;
      archived = true;
      await localStorage().set({ [key]: cached });
    }
  } catch (err) {
    archiveError = err;
    // Keep the last downloaded version readable while a newer version is unavailable.
    archived = !!cached?.archiveManifest;
  }
  if (archiveError && !cached) {
    $("rtitle").textContent = hostnameOf(url);
    showStatus(`文章已存档，但尚未下载到此设备：${archiveError instanceof Error ? archiveError.message : String(archiveError)}`, () => location.reload());
    return;
  }
  if (!chapter && !archived && !archiveError && (!cached || refresh)) {
    $("rtitle").textContent = hostnameOf(url);
    showStatus(refresh ? "正在重新抓取正文…" : "正在抓取正文…");
    try {
      cached = await fetchAndExtract(url);
      await localStorage().set({ [key]: cached });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      $("rtitle").textContent = hostnameOf(url);
      showStatus(
        inApp() ? `抓不到这一页：${msg}` : `抓不到这一页：${msg}（在普通浏览器里调试时跨域请求会被拦，得装进 App 里试）`,
        () => location.reload(),
      );
      return;
    }
  }
  if (!cached) return;

  // 老缓存（没有 finalUrl 的）退回用户给的地址
  const pageUrl = cached.finalUrl || url;
  const articleId = normalizeUrl(pageUrl);
  document.title = cached.title;
  $("rtitle").textContent = cached.title;
  const box = $("article");
  const heading = el("h1", "atitle", cached.title);
  const byline = el("div", "aline");
  if (book) {
    byline.append(el("span", undefined, book.title));
    if (book.author) byline.append(el("span", undefined, book.author));
  } else {
    const link = el("a", undefined, hostnameOf(pageUrl));
    link.href = pageUrl;
    byline.append(link);
  }
  byline.append(el("span", undefined, new Date(cached.savedTs).toLocaleDateString("zh-CN")));
  // 洗过的 HTML，见 sanitize.ts；正文来自任意网站，这一步不能省
  box.innerHTML = "";
  box.append(heading, byline);
  const body = el("div", "body");
  body.innerHTML = sanitizeArticle(cached.html, pageUrl, document, !!cached.archiveManifest || !!cached.book);
  if (cached.book) {
    const resources = await hydrateBookImages(body, cached.book.resources);
    window.addEventListener("pagehide", resources.release, { once: true });
  }
  if (cached.archiveManifest) {
    const status = el("span", undefined, "插件存档 · 正在准备图片…");
    byline.append(status);
    const hydration = hydrateArchiveImages(body, cached.archiveManifest);
    box.append(body);
    const resources = await hydration;
    window.addEventListener("pagehide", resources.release, { once: true });
    status.textContent = resources.missing > 0
      ? `插件存档 · ${resources.missing} 项资源未保存或未下载`
      : "插件存档 · 可离线阅读";
    if (archiveError) status.textContent += " · 当前显示此前下载的版本";
  }
  box.append(body);

  /* 章末的翻页。书里没有"下一页"这一说，读完一节要能直接进下一节，也要能回目录。 */
  if (book && chapter) {
    const current = book;
    const nav = el("div", "chapter-nav");
    const jump = (to: number, label: string): void => {
      const btn = el("button", "mini", label);
      btn.addEventListener("click", () => void go(readerUrl(chapterId(current.id, to))));
      nav.append(btn);
    };
    if (chapter.index > 0) jump(chapter.index - 1, "‹ 上一节");
    const toc = el("button", "mini", "目录");
    toc.addEventListener("click", () => void go(`index.html?book=${encodeURIComponent(current.id)}`));
    nav.append(toc);
    if (chapter.index + 1 < current.chapters.length) jump(chapter.index + 1, "下一节 ›");
    box.append(nav);
  }

  const title = cached.title;
  ctl = await startTracking({
    tapRoot: body,
    url: pageUrl,
    approvedArticle: !!cached.archiveManifest || !!cached.book,
    focus: "assume",
    extract: () => extractFromContainer(body, title),
    onPending: pending => { ctl = pending; renderMeta(pageUrl); },
  });
  hostHooks.visibility = (v) => ctl?.setVisible(v);
  renderMeta(pageUrl);
  setInterval(() => renderMeta(pageUrl), 2_000);

  /* ---- 本文生词 ---- */
  const badge = $("words-n");
  const refreshCount = async (): Promise<Snippet[]> => {
    const list = await loadWords(articleId);
    badge.textContent = list.length > 0 ? String(list.length) : "";
    return list;
  };
  void refreshCount();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["snippets"]) void refreshCount();
  });
  $("words").addEventListener("click", async () => {
    renderWords(await refreshCount());
    setSheet(true);
  });
  $("sheet-close").addEventListener("click", () => setSheet(false));
  // 书的正文来自本机的文件，没有"重抓"这回事
  $("refetch").hidden = !!chapter;
  $("refetch").addEventListener("click", () => {
    void (async () => {
      ctl?.stop("unload");
      await shim.flush();
      location.replace(readerUrl(url) + "&refresh=1");
    })();
  });
}

void main().catch((err: unknown) => {
  showStatus(`阅读器出错了：${err instanceof Error ? err.message : String(err)}`);
});
