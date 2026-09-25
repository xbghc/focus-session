import type { AnyMessage, ContentToBg, PopupToBg } from "../../types.ts";

/*
 * 后台的消息分发。
 *
 * 每个功能插件交一张「消息类型 → 处理函数」的表，这里按类型转过去。两道检查：
 *   - 编译期：发往后台的每种消息都得有人认领，漏了 createRouter 那一行就报错，
 *     错误里的 missing 字段列出是哪几种；
 *   - 运行时：同一种消息不许两家都认——后登记的悄悄盖掉先登记的，是最难查的那种错。
 *
 * 只认 chrome.storage / chrome.tabs.create 这类能被 App 垫片提供的 API，
 * 不碰 onMessage / onConnect——那些注册点在各宿主自己的入口里（background/index.ts、app/boot.ts）。
 */

/** 发往后台的消息。发往页面的（page:state 之类）不经过这里。 */
export type BgMessage = ContentToBg | PopupToBg;
export type BgMessageType = BgMessage["type"];

/** 发消息的一方。扩展里是 chrome.runtime.MessageSender，App 里由垫片造一个带 tab id 的。 */
export interface Sender {
  tab?: { id?: number; windowId?: number };
  url?: string;
}

export type Handler<T extends BgMessageType> = (msg: Extract<BgMessage, { type: T }>, sender: Sender) => unknown;
export type HandlerMap = { [T in BgMessageType]?: Handler<T> };

type KeysOf<U> = U extends unknown ? keyof U : never;
type Missing<M> = Exclude<BgMessageType, KeysOf<M[keyof M]>>;

export type Router = (msg: AnyMessage, sender: Sender) => Promise<unknown>;

/** `maps` 的键是功能名，只用来在重复登记时说清是谁和谁撞了。 */
export function createRouter<M extends Record<string, HandlerMap>>(
  maps: M & ([Missing<M>] extends [never] ? unknown : { missing: Missing<M> }),
): Router {
  const table = new Map<string, (msg: unknown, sender: Sender) => unknown>();
  const owner = new Map<string, string>();
  for (const [feature, map] of Object.entries(maps as Record<string, HandlerMap>)) {
    for (const [type, fn] of Object.entries(map)) {
      const taken = owner.get(type);
      if (taken !== undefined) throw new Error(`消息 ${type} 被 ${taken} 和 ${feature} 重复登记`);
      owner.set(type, feature);
      table.set(type, fn as (msg: unknown, sender: Sender) => unknown);
    }
  }
  return async (msg, sender) => {
    const fn = typeof msg?.type === "string" ? table.get(msg.type) : undefined;
    return fn ? await fn(msg, sender) : { ok: false, error: "unknown message" };
  };
}
