import { localStorage } from "../sync/storage.ts";
import { bumpUiUsage, isUiEvent, normalizeUiUsage, type UiUsageLog } from "../lib/uiUsage.ts";
import { serialize } from "./store.ts";

/**
 * 界面埋点的落盘。记什么、为什么只记次数，见 lib/uiUsage.ts。
 *
 * 和别的诊断记录同一条规矩：只存本机，不进同步（sync/storage.ts 只认它自己那几个键），
 * 不进数据导出，随设置页的「诊断日志」一起复制、下载。
 *
 * 有一处不一样：「清空日志」**不**清它。清日志常是排查的第一步——清掉、复现、导出一份干净的；
 * 而这份计数要攒几个星期才看得出东西，每查一次翻译问题就归零的话永远攒不起来。
 * 它自己过 90 天滚掉，「清空全部记录」时随其他记录一起没（store.ts 的 clearData 是白名单）。
 */

export const KEY_UI_USAGE = "uiUsage";

const local = (): chrome.storage.StorageArea => localStorage();

export async function getUiUsage(): Promise<UiUsageLog> {
  const got = await local().get(KEY_UI_USAGE);
  return normalizeUiUsage(got[KEY_UI_USAGE]);
}

/** 落盘失败吞掉：埋点是附属品，不能反过来让页面上的按钮报错。 */
export async function recordUiUsage(names: readonly unknown[], now = Date.now()): Promise<void> {
  // 一条认识的都没有就不写：一次写入是整库读改写，不值得为一批废名字跑一趟
  if (!names.some(isUiEvent)) return;
  try {
    await serialize(async () => {
      await local().set({ [KEY_UI_USAGE]: bumpUiUsage(await getUiUsage(), names, now) });
    });
  } catch {
    /* 见上 */
  }
}
