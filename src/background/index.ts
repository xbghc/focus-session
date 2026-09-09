import type { AnyMessage, BgToContent, OcrReply, PopupToContent } from "../types.ts";
import { PORT_TRANSLATE } from "../types.ts";
import { normalizeUrl } from "../lib/url.ts";
import { attachTranslatePort, boot, getOpen, handle, recoverOpen } from "./handle.ts";
import { setOcrBackend } from "./ocr.ts";

/*
 * service worker 的入口：只负责把 chrome 的各个注册点接到 handle.ts 上。
 * 消息处理本体在 handle.ts——安卓 App 也用它，只是接线的方式不同（见 src/app/shim.ts）。
 *
 * MV3 的 SW 起不了 Worker，content script 起的 Worker 又受宿主页 CSP 管。
 * 识别因此交给扩展自己的 offscreen document，wasm 与训练数据也随扩展离线提供。
 */

let offscreen: Promise<void> | null = null;
function ensureOffscreen(): Promise<void> {
  offscreen ??= chrome.offscreen.createDocument({
    url: "ocr.html",
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: "在 Worker 里跑 Tesseract 做截图文字识别",
  }).catch((err: unknown) => {
    // SW 重启会丢掉 promise，文档却仍在；Chrome 114 还没有 getContexts 可查。
    if (/already exists|only a single offscreen document/i.test(String(err))) return;
    offscreen = null;
    throw err;
  });
  return offscreen;
}

setOcrBackend({
  async recognize(png): Promise<OcrReply> {
    await ensureOffscreen();
    return await chrome.runtime.sendMessage({ target: "offscreen", type: "ocr:recognize", png });
  },
  async warm() {
    await ensureOffscreen();
    const reply = await chrome.runtime.sendMessage({ target: "offscreen", type: "ocr:warm" });
    if (!reply.ok) throw new Error(reply.error);
  },
});

boot();

chrome.runtime.onMessage.addListener((msg: AnyMessage & { target?: string }, sender, sendResponse) => {
  if (msg?.target === "offscreen") return false;
  // 必须显式 return true 保持通道打开；Chrome 不认返回 Promise 的写法。
  handle(msg, sender).then(sendResponse, (err: unknown) => {
    // 写入失败（多数是超出存储配额）不能无声无息
    console.warn("[focus-session] 消息处理失败", msg, err);
    sendResponse({ ok: false, error: String(err) });
  });
  return true;
});

async function screenshotTranslate(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) {
      await chrome.tabs.sendMessage(tab.id, { type: "page:screenshot" } satisfies PopupToContent);
    }
  } catch {
    /* 商店页、扩展页或尚未注入的页面没有 content script，正常。 */
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "screenshot-translate") void screenshotTranslate();
});
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "screenshot-translate") void screenshotTranslate();
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "screenshot-translate",
    title: "截图翻译",
    contexts: ["page", "image", "selection"],
  });
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
