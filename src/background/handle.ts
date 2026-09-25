import { createRouter } from "../core/background/router.ts";
import { bootCore, coreHandlers } from "../core/background/handlers.ts";
import { bootReading, readingHandlers } from "../features/reading/background.ts";
import { translationHandlers } from "../features/translation/background.ts";

/**
 * 后台消息处理的组装：各功能插件交上自己那张表，core/background/router.ts 按类型转过去。
 *
 * 有**两个宿主**：扩展的 service worker（index.ts 把它挂到 chrome.runtime.onMessage 上），
 * 以及安卓 App 的页面（src/app/shim.ts 把 chrome.runtime.sendMessage 直接接到这个函数上）。
 */

export const handle = createRouter({
  core: coreHandlers,
  reading: readingHandlers,
  translation: translationHandlers,
});

/** 启动路径上的补课。不 await：没人等它，做不完下次醒来会再来一遍。 */
export function boot(): void {
  bootCore();
  bootReading();
}

export type { Sender } from "../core/background/router.ts";
