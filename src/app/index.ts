import "./boot.ts";
import "../dashboard/index.ts";
import { go, readerUrl } from "./boot.ts";
import { autoCheck, skipVersion } from "./update.ts";
import { localStorage } from "../sync/storage.ts";
import { ARCHIVES_KEY, type ArchiveManifest } from "../archive/types.ts";
import { cachedBlob } from "../archive/cache.ts";
import { hostnameOf } from "../lib/url.ts";

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
hint.after(savedSection);
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
