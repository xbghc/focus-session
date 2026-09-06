import type { AnyMessage, BgToContent } from "../types.ts";
import { PORT_TRANSLATE } from "../types.ts";
import { normalizeUrl } from "../lib/url.ts";
import { attachTranslatePort, boot, getOpen, handle, recoverOpen } from "./handle.ts";

/*
 * service worker 的入口：只负责把 chrome 的各个注册点接到 handle.ts 上。
 * 消息处理本体在 handle.ts——安卓 App 也用它，只是接线的方式不同（见 src/app/shim.ts）。
 */

boot();

chrome.runtime.onMessage.addListener((msg: AnyMessage, sender, sendResponse) => {
  // 必须显式 return true 保持通道打开；Chrome 不认返回 Promise 的写法。
  handle(msg, sender).then(sendResponse, (err: unknown) => {
    // 写入失败（多数是超出存储配额）不能无声无息
    console.warn("[focus-session] 消息处理失败", msg, err);
    sendResponse({ ok: false, error: String(err) });
  });
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_TRANSLATE) return;
  attachTranslatePort(port);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void recoverOpen(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  // changeInfo.url 在**页面根本没有重新加载**时也会触发：点目录锚点（#section）、
  // history.pushState 都算。此时 content script 还在正常计时，若无脑补记就会
  // 把同一段阅读记两次——长文加目录锚点恰好是这个工具最常见的使用场景。
  // 只有当新地址不再是同一篇文章时才兜底。
  void (async () => {
    const o = (await getOpen())[String(tabId)];
    if (o && normalizeUrl(changeInfo.url!) !== o.articleId) await recoverOpen(tabId);
  })();
  /*
   * 页内导航（SPA 路由）不触发 pagehide，content script 察觉不到自己已经不在
   * 原来那篇上了：读完角标会一直挂在右下角，之后开的 session 也全记到旧文章名下。
   *
   * 这一条**不能**跟着上面的 open 记录走。读完之后 session 早就因走神结束、
   * 记录已被删掉，而角标还挂着——那正是这个通知最该送到的时候。
   * 是不是真换了一篇由页面自己判（口径同为 normalizeUrl），这里只管报地址。
   */
  try {
    void chrome.tabs
      .sendMessage(tabId, { type: "page:url-changed", url: changeInfo.url } satisfies BgToContent)
      // 那一页没有 content script（扩展页、商店页、还没注入完）时会拒绝，正常
      ?.catch?.(() => undefined);
  } catch {
    /* 扩展正在重载 */
  }
});
