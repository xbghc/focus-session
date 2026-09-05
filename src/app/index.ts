import "./boot.ts";
import "../dashboard/index.ts";
import { readerUrl } from "./boot.ts";

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
