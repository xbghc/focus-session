import type { ContentToBg } from "../../types.ts";

/** 发完就不管的一条消息。后台可能正在重启；投递失败不该影响页面。 */
export const send = (msg: ContentToBg): void => {
  try {
    void chrome.runtime.sendMessage(msg)?.catch?.(() => undefined);
  } catch {
    /* 扩展已被卸载/重载 */
  }
};
