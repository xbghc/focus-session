import "./boot.ts";
import "../dashboard/index.ts";
import { go, readerUrl } from "./boot.ts";
import { autoCheck, skipVersion } from "./update.ts";

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
