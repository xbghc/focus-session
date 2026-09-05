import type { Snippet } from "../types.ts";
import { normalizeUrl, hostnameOf } from "../lib/url.ts";
import { fillMeta } from "../lib/speak.ts";

/**
 * 侧边栏：只显示**当前标签页这篇文章**的划词，边读边回看。
 * 跟随标签页切换与页内导航；完整的生词本和复习在 dashboard 里。
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function currentTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function render(): Promise<void> {
  const tab = await currentTab();
  const list = $("list");
  list.textContent = "";

  const url = tab?.url;
  if (!url || !/^https?:/.test(url)) {
    $("where").textContent = "";
    list.append(el("div", "empty", "当前标签页不是网页。"));
    return;
  }

  const articleId = normalizeUrl(url);
  $("where").textContent = tab.title || hostnameOf(url);

  const res = (await chrome.runtime.sendMessage({ type: "snippets:list", articleId })) as {
    snippets: Snippet[];
  };
  const snippets = res?.snippets ?? [];

  if (snippets.length === 0) {
    list.append(el("div", "empty", "这篇文章还没有划词。\n在正文里选中一段英文就会自动翻译。"));
    return;
  }

  for (const s of snippets) {
    const item = el("div", "item");
    item.append(el("div", "t", s.text));
    const meta = el("div", "m");
    if (fillMeta(meta, { phonetic: s.phonetic, pos: s.pos, word: s.text })) item.append(meta);
    item.append(el("div", "tr", s.translation));
    if (s.contextNote) item.append(el("div", "n", s.contextNote));
    if (s.usage) item.append(el("div", "u", s.usage));
    if (s.vocab.length > 0) {
      const box = el("div", "vocab");
      for (const v of s.vocab) {
        const one = el("div", "v");
        const head = el("div");
        head.append(el("span", "vw", v.word));
        const m = el("span", "vm");
        if (fillMeta(m, { phonetic: v.phonetic, pos: v.pos, word: v.word })) head.append(m);
        one.append(head, el("div", "vd", v.meaning));
        if (v.note) one.append(el("div", "vn", v.note));
        box.append(one);
      }
      item.append(box);
    }
    list.append(item);
  }
}

$("refresh").addEventListener("click", () => void render());
$("open-dash").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

// 跟随当前标签：切换标签、页内跳转、以及后台写入新划词后都要刷新
chrome.tabs.onActivated.addListener(() => void render());
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.url && tab.active) void render();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["snippets"]) void render();
});

void render();
