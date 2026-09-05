import type { PageState } from "../types.ts";
import { startTracking } from "./track.ts";

/*
 * content script 的入口：只做扩展特有的三件事——只跟踪顶层的 HTML 文档、
 * 回答 popup 的「当前页状态」询问、把追踪本体（track.ts）挂到这个网页上。
 */

/**
 * popup 每次询问都现算，而不是回放一份缓存快照——
 * 否则读进度只在 session 开始/结束时更新，读到一半打开 popup 会看到旧数字。
 */
let provideState: () => PageState = () => ({ tracked: false, reason: "初始化中" });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if ((msg as { type?: string } | null)?.type !== "page:state") return false;
  sendResponse(provideState());
  return false; // 同步应答，无需保持通道
});

async function main(): Promise<void> {
  if (window.top !== window) return; // 只跟踪顶层文档
  if (document.contentType && document.contentType !== "text/html") {
    provideState = () => ({ tracked: false, reason: "非 HTML 文档" });
    return;
  }
  const ctl = await startTracking({ url: location.href, focus: "window" });
  provideState = () => ctl.state();
}

void main().catch((err: unknown) => {
  provideState = () => ({ tracked: false, reason: `初始化失败：${String(err)}` });
});
