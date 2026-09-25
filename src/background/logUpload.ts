import { localStorage } from "../sync/storage.ts";
import { hashText } from "../lib/hash.ts";
import { getLlmLog, getLlmTimings } from "./llmLog.ts";
import { getAppErrors, getFetchLog } from "./appLog.ts";
import { getTranslationTraces } from "../features/translation/translationLog.ts";
import { uiPlatform, type UiPlatform } from "./uiUsage.ts";
import { updateLocalOnly } from "./store.ts";

/**
 * 诊断日志的上传：设置页「诊断日志」里的那几份（模型调用失败的现场、调用耗时、翻译链路轨迹、
 * 阅读器抓取、没接住的错误），启用了设备同步时传到同一台服务器，在那边用管理命令 `logs` 看。
 * 哪台设备上翻译出了错，不用再让人去导出文件。
 *
 * 和界面埋点一样**不是同步记录**：别的设备用不着读它，服务器上 30 天过期。没启用同步的设备什么都不传。
 * 这几份本来就是有上限的滚动窗口（10 + 50 + 100 + 30 + 30 条），这里只记「哪些已经传过」的指纹，
 * 每轮只传新增的和被改写过的（翻译轨迹会按 id 原地改写，服务器按 id 覆盖）。
 */

export const KEY_LOG_UPLOAD = "logUpload";

/** 没传成：十分钟后再试。 */
export const LOG_RETRY_MS = 10 * 60_000;
/** 服务器没有这个接口（比客户端旧）：一天问一次就够了。 */
export const LOG_UNSUPPORTED_MS = 24 * 60 * 60_000;

export type LogKind = "failure" | "timing" | "translation" | "fetch" | "error";
interface LogUploadState { sent: string[]; nextUploadAt: number }
export interface LogUpload {
  deviceId: string;
  platform: UiPlatform;
  version: string;
  entries: Array<{ kind: LogKind; entry: unknown }>;
}

const local = (): chrome.storage.StorageArea => localStorage();

function normalize(v: unknown): LogUploadState {
  const r = (v && typeof v === "object" ? v : {}) as Partial<LogUploadState>;
  return {
    sent: Array.isArray(r.sent) ? r.sent.filter((s): s is string => typeof s === "string") : [],
    nextUploadAt: typeof r.nextUploadAt === "number" && Number.isFinite(r.nextUploadAt) ? r.nextUploadAt : 0,
  };
}

/** 一条日志的指纹。只用来认「传过没有」，碰撞的代价是漏传一条，长度一起算进去再压一压。 */
function fingerprint(kind: LogKind, entry: unknown): string {
  const json = JSON.stringify(entry);
  return `${kind}:${hashText(json)}:${json.length}`;
}

async function collect(): Promise<Array<{ kind: LogKind; entry: unknown; id: string }>> {
  const [failures, timings, translations, fetches, errors] = await Promise.all([
    getLlmLog(), getLlmTimings(), getTranslationTraces(), getFetchLog(), getAppErrors(),
  ]);
  const all: Array<[LogKind, readonly unknown[]]> = [
    ["failure", failures], ["timing", timings], ["translation", translations], ["fetch", fetches], ["error", errors],
  ];
  return all.flatMap(([kind, list]) => list.map((entry) => ({ kind, entry, id: fingerprint(kind, entry) })));
}

function version(): string {
  try {
    return chrome.runtime.getManifest().version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * 把还没传的传上去。由同步引擎在一轮成功之后调（见 sync/engine.ts），`post` 是它带着 Token 的请求。
 *
 * 永不抛错，也不改同步状态：日志传不上去不是「同步失败」。
 * 传成之后，「传过的」只留还在本机日志里的那些——滚出窗口的指纹没用了，清空日志之后也就跟着清空。
 */
export async function uploadLogs(post: (body: LogUpload) => Promise<unknown>, deviceId: string, now = Date.now()): Promise<void> {
  try {
    const state = normalize((await local().get(KEY_LOG_UPLOAD))[KEY_LOG_UPLOAD]);
    if (now < state.nextUploadAt) return;
    const current = await collect();
    const sent = new Set(state.sent);
    const pending = current.filter((item) => !sent.has(item.id));
    if (pending.length === 0) return;
    let next: LogUploadState;
    try {
      await post({ deviceId, platform: uiPlatform(), version: version(), entries: pending.map(({ kind, entry }) => ({ kind, entry })) });
      next = { sent: current.map((item) => item.id), nextUploadAt: 0 };
    } catch (err) {
      const status = (err as { status?: number }).status;
      next = { sent: state.sent, nextUploadAt: now + (status === 404 ? LOG_UNSUPPORTED_MS : LOG_RETRY_MS) };
    }
    await updateLocalOnly([KEY_LOG_UPLOAD], () => ({ [KEY_LOG_UPLOAD]: next }));
  } catch {
    /* 见上 */
  }
}
