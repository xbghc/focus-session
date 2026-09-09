import type { PageState } from "../types.ts";
import { createPageHost } from "./host.ts";
import { startTracking } from "./track.ts";

/*
 * content script 的入口：只做扩展特有的三件事——只跟踪顶层的 HTML 文档、
 * 回答 popup 的「当前页状态」询问、把追踪本体（track.ts）挂到这个网页上。
 *
 * 「挂上」这件事不止一次：页内换文章时后台会推来新地址，由 host.ts 收掉旧的一轮、
 * 按新地址再起一轮；从 bfcache 回来（后退/前进）时文档原样端回来、这个脚本不会再跑，
 * 也要请 host.ts 重起。这里只负责把两种通知转过去。
 */

/**
 * popup 每次询问都现算，而不是回放一份缓存快照——
 * 否则读进度只在 session 开始/结束时更新，读到一半打开 popup 会看到旧数字。
 */
let provideState: () => PageState = () => ({ tracked: false, reason: "初始化中" });
/** 三个截图入口共用这条接线；只让顶层 HTML 文档响应。 */
let screenshot: () => void = () => undefined;
/** popup 的「本页启用划词翻译」。追踪器还没就绪时点到就是空操作——那时 popup 也拿不到按钮。 */
let translateHere: () => void = () => undefined;
/** 后台通知的同文档导航。不在跟踪的文档（iframe、非 HTML）上什么都不做。 */
let urlChanged: (url: string) => void = () => undefined;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const m = msg as { type?: string; url?: string } | null;
  const type = m?.type;
  if (type === "page:screenshot") {
    screenshot();
    return false;
  }
  if (type === "page:url-changed") {
    urlChanged(m?.url ?? location.href);
    return false; // 后台是发完就不管的，不必应答
  }
  if (type === "page:translate-here") translateHere();
  else if (type !== "page:state") return false;
  // 两种询问都回一份现算的状态：开启之后 popup 要立刻把按钮换成「已开启」
  sendResponse(provideState());
  return false; // 同步应答，无需保持通道
});

function main(): void {
  if (window.top !== window) return; // 只跟踪顶层文档
  if (document.contentType && document.contentType !== "text/html") {
    provideState = () => ({ tracked: false, reason: "非 HTML 文档" });
    return;
  }
  const host = createPageHost((url, signal) => startTracking({ url, focus: "window", signal }));
  provideState = () => host.state();
  translateHere = () => host.translateHere();
  screenshot = () => host.screenshot();
  urlChanged = (url) => host.urlChanged(url);
  host.start(location.href);
  /*
   * 后退/前进回到这一页：pagehide 时那一轮已经收摊（见 track.ts 的 finish），
   * 而 bfcache 端回来的是同一个文档，content script 不会重新跑一遍——不在这里
   * 重起，这一页就再也不计时、划词也不翻译了。后台推来的 page:url-changed 救不了：
   * 地址压根没变，host.ts 会认成「还是这一篇」。
   *
   * persisted 必须判：头一次加载也发 pageshow，那时 host.start 才刚跑完。
   */
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) host.restored(location.href);
  });
}

main();
