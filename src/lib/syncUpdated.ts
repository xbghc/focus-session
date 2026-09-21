import type { BgToPage } from "../types.ts";

/**
 * 「同步刚让本机数据变了样」的订阅，给开着的页面用：另一台设备上刚读的文章、刚划的词，拉到之后页面跟着重画。
 *
 * 两种宿主两条路（发的那头见 sync/storage.ts 的 notifyProjection）：App 里是 window 事件，
 * 扩展里是 service worker 的 runtime 广播。监听器**不应答**——runtime 的总线是共用的，
 * 应答会抢走真正处理方的结果（同 ocr/index.ts）。
 */
export function onSyncUpdated(fn: () => void): void {
  window.addEventListener("focus-sync-updated", () => fn());
  // App 的垫片和测试里的假 chrome 未必有 onMessage
  chrome.runtime.onMessage?.addListener((msg: Partial<BgToPage> | undefined) => {
    if (msg?.type === "sync:updated") fn();
    return false;
  });
}
