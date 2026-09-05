import type { AnyMessage } from "../types.ts";
import { PORT_TRANSLATE } from "../types.ts";
import { attachTranslatePort, boot as bootBackground, handle } from "../background/handle.ts";
import { idbBackend, installChromeShim, type ChromeShim } from "./shim.ts";
import { installNative } from "./native.ts";

/**
 * App 每个页面的第一件事：把 chrome.* 垫片和宿主桥装好。
 *
 * 必须是各页面入口的**第一个 import**——dashboard/index.ts、options/index.ts 在模块顶层
 * 就开始发消息，那时 chrome 得已经在了。
 */

/** 阅读器页面的地址。 */
export const readerUrl = (url: string): string => `read.html?u=${encodeURIComponent(url)}`;

/** 是不是站外的网页地址（而不是 App 自己的页面）。 */
export function isExternal(href: string): boolean {
  try {
    const u = new URL(href, location.href);
    return /^https?:$/.test(u.protocol) && u.origin !== location.origin;
  } catch {
    return false;
  }
}

/**
 * 换页前要做的事。阅读器把「停掉追踪」挂在这里：session:end 是 pagehide 时才发的，
 * 而那时 IndexedDB 的事务多半赶不上换页——先停、再 flush、最后才动 location。
 */
export const navigation = { beforeLeave: async (): Promise<void> => undefined };

let leaving = false;

/** 所有换页的唯一出口：后台的 tabs.create / openOptionsPage、站外链接、window.open 都走这里。 */
export async function go(url: string): Promise<void> {
  if (leaving) return;
  leaving = true;
  try {
    await navigation.beforeLeave();
    await shim.flush();
  } catch (err) {
    console.warn("[focus-session] 换页前的收尾出错，照常换页", err);
  }
  location.href = url;
}

export const shim: ChromeShim = installChromeShim({
  storage: idbBackend(),
  handle: (msg, sender) => handle(msg as AnyMessage, sender),
  connect: (name, port) => {
    if (name === PORT_TRANSLATE) attachTranslatePort(port);
  },
  version: __APP_VERSION__,
  navigate: (url) => void go(url),
});

installNative();

/*
 * 网页链接一律进阅读器：文章卡片上的标题、回顾里的「打开原文」、正文里的链接。
 * 扩展里这些是 target=_blank / window.open 开新标签页，App 里没有标签页这回事。
 */
window.open = ((url?: string | URL) => {
  if (url) void go(readerUrl(String(url)));
  return null;
}) as typeof window.open;

document.addEventListener(
  "click",
  (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const a = target?.closest("a[href]");
    if (!(a instanceof HTMLAnchorElement) || !isExternal(a.href)) return;
    e.preventDefault();
    void go(readerUrl(a.href));
  },
  true,
);

bootBackground();
