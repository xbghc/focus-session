import { localStorage } from "../sync/storage.ts";
import { bumpUiUsage, isUiEvent, normalizeUiUsage, settleUiUpload, type UiUsageLog } from "../lib/uiUsage.ts";
import { updateLocalOnly } from "./store.ts";

/**
 * 界面埋点的落盘和上传。记什么、为什么只记次数，见 lib/uiUsage.ts。
 *
 * 计数**不是同步记录**：计数器没法像记录那样「后写的赢」地合并，别的设备也用不着读它。
 * 它在本机只是 storage 里的一个键（sync/storage.ts 只认它自己那几个键，这个键不进 outbox），
 * 启用了设备同步时另走一个接口 POST /v1/usage 传到同一台服务器，在那边用管理命令 `usage` 汇总分析。
 * 没启用同步的设备什么都不往外发，计数只留在本机、随设置页的「诊断日志」一起看和导出。
 *
 * 「清空日志」**不**清它。清日志常是排查的第一步——清掉、复现、导出一份干净的；
 * 而这份计数要攒几个星期才看得出东西，每查一次翻译问题就归零的话永远攒不起来。
 * 它自己过 90 天滚掉，「清空全部记录」时随其他记录一起没（那之后设备号也换了，不会和服务器上的旧数打架）。
 */

export const KEY_UI_USAGE = "uiUsage";

/** 传成之后隔这么久再传下一回。分析看的是几周的分布，不需要实时。 */
export const UPLOAD_EVERY_MS = 10 * 60_000;
/** 没传成：一小时后再试。 */
export const UPLOAD_RETRY_MS = 60 * 60_000;
/** 服务器没有这个接口（比客户端旧）：一天问一次就够了，不该每小时往它的日志里添一条 404。 */
export const UPLOAD_UNSUPPORTED_MS = 24 * 60 * 60_000;

export type UiPlatform = "extension" | "app";
let platform: UiPlatform = "extension";
/** App 启动时说一声自己是谁（见 app/boot.ts）。两边的首页是同一份代码，但手指和鼠标的用法得分开看。 */
export function setUiPlatform(value: UiPlatform): void { platform = value; }
export const uiPlatform = (): UiPlatform => platform;

const local = (): chrome.storage.StorageArea => localStorage();

export async function getUiUsage(): Promise<UiUsageLog> {
  const got = await local().get(KEY_UI_USAGE);
  return normalizeUiUsage(got[KEY_UI_USAGE]);
}

/**
 * 读改写。走本机专用的直写（store.ts 的 `updateLocalOnly`），不走 localStorage().set：那条路每写一次都会排一轮同步，
 * 而这个键不进同步——点几下按钮不该换来几轮空转的请求。上传搭平时每分钟那一轮的车，不用谁来催。
 */
async function mutate(change: (log: UiUsageLog) => UiUsageLog): Promise<void> {
  await updateLocalOnly([KEY_UI_USAGE], (v) => ({ [KEY_UI_USAGE]: change(normalizeUiUsage(v[KEY_UI_USAGE])) }));
}

/** 落盘失败吞掉：埋点是附属品，不能反过来让页面上的按钮报错。 */
export async function recordUiUsage(names: readonly unknown[], now = Date.now()): Promise<void> {
  // 一条认识的都没有就不写：一次写入是整库读改写，不值得为一批废名字跑一趟
  if (!names.some(isUiEvent)) return;
  try {
    await mutate((log) => bumpUiUsage(log, names, now));
  } catch {
    /* 见上 */
  }
}

/** 发给 POST /v1/usage 的东西。每天传的是**当天的累计数**而不是增量：重发、重试都无害，服务器留大的那个。 */
export interface UiUsageUpload { deviceId: string; platform: UiPlatform; days: UiUsageLog["days"] }

/**
 * 把还没传的那几天传上去。由同步引擎在一轮成功之后调（见 sync/engine.ts），`post` 是它带着 Token 的请求。
 *
 * 永不抛错，也不改同步状态：计数传不上去不是「同步失败」，不该让设置页亮红灯。
 * 没传成就记一个「下回什么时候再试」，攒着的那几天原样留着。
 */
export async function uploadUiUsage(post: (body: UiUsageUpload) => Promise<unknown>, deviceId: string, now = Date.now()): Promise<void> {
  try {
    const log = await getUiUsage();
    if (log.pending.length === 0 || now < log.nextUploadAt) return;
    const days = Object.fromEntries(log.pending.map((day) => [day, log.days[day]!]));
    let wait = UPLOAD_EVERY_MS;
    let sent: UiUsageLog["days"] = days;
    try {
      await post({ deviceId, platform, days });
    } catch (err) {
      wait = (err as { status?: number }).status === 404 ? UPLOAD_UNSUPPORTED_MS : UPLOAD_RETRY_MS;
      sent = {};
    }
    await mutate((current) => settleUiUpload(current, sent, now + wait));
  } catch {
    /* 见上 */
  }
}
