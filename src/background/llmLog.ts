import { localStorage } from "../sync/storage.ts";
import type { LlmConfig, LlmFailure, LlmLogBundle, LlmTiming } from "../types.ts";
import { type CallTiming, LlmError, type RawUsage } from "../lib/llm.ts";
import { KEY_APP_ERROR, KEY_READER_FETCH, getAppErrors, getFetchLog } from "./appLog.ts";
import { KEY_USAGE, bumpUsage, getLlmConfig } from "../core/background/llm.ts";
import { serialize, updateLocalOnly } from "./store.ts";
import { getTranslationTraces, KEY_TRANSLATION_TRACE } from "../features/translation/translationLog.ts";
import { getUiUsage } from "./uiUsage.ts";

/**
 * LLM 调用失败的现场记录，给设置页的「诊断日志」用。
 *
 * 浮层只显示 200 字，service worker 的控制台又得在出错**之前**就开着守着——
 * 出了问题往往什么都没留下。这里把每次失败落到 storage.local，随时能导出。
 * 只存本机；不进数据导出（那份文件常被随手分享）；「清空全部记录」时随其他记录
 * 一起清掉——store.ts 的 clearData 是白名单，只留 settings 与 llm。
 */

export const KEY_LLM_LOG = "llmLog";

/** 只留最近这些条：诊断看的是最近几次，不是历史。 */
export const MAX_LOG_ENTRIES = 10;

/**
 * 单条原文上限。max_tokens 最高可设 8192，中文输出约 1.5 字/token，
 * 极限 12K 字左右，留些余量。10 条 × (原文 + 选区 + 上下文) 最坏约 600KB，
 * 在 storage.local 约 10MB 的配额里可以接受。
 */
export const MAX_RAW_CHARS = 16_000;

/** 请求里字符串字段的上限。上下文在设置里最多 2000 字符，选区硬上限 1955，超出的本身就是异常。 */
export const MAX_FIELD_CHARS = 2_000;

const local = (): chrome.storage.StorageArea => localStorage();

export async function getLlmLog(): Promise<LlmFailure[]> {
  const got = await local().get(KEY_LLM_LOG);
  const v = got[KEY_LLM_LOG];
  return Array.isArray(v) ? (v as LlmFailure[]) : [];
}

/** 超长的截掉尾部并留个标记，别让一条坏输出把日志撑爆。 */
export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[已截断，原长 ${s.length}]` : s;
}

/** 进日志之前收一收：超长的原文和请求字段截尾。 */
function clipped(entry: LlmFailure): LlmFailure {
  return {
    ...entry,
    raw: entry.raw === null ? null : clip(entry.raw, MAX_RAW_CHARS),
    request: Object.fromEntries(
      Object.entries(entry.request).map(([k, v]) => [k, typeof v === "string" ? clip(v, MAX_FIELD_CHARS) : v]),
    ),
  };
}

const pushFailure = (stored: unknown, entry: LlmFailure): LlmFailure[] =>
  [...(Array.isArray(stored) ? (stored as LlmFailure[]) : []), clipped(entry)].slice(-MAX_LOG_ENTRIES);

export async function recordLlmFailure(entry: LlmFailure): Promise<void> {
  await updateLocalOnly([KEY_LLM_LOG], (v) => ({ [KEY_LLM_LOG]: pushFailure(v[KEY_LLM_LOG], entry) }));
}

/** 清空按钮清的是整份诊断日志，不只 LLM 那两份。界面埋点除外，理由见 uiUsage.ts。 */
export async function clearLlmLog(): Promise<void> {
  // 一次删完：serialize 是同一条链，套着调用各日志的清理会死等。
  await serialize(() => local().remove([KEY_LLM_LOG, KEY_LLM_TIMING, KEY_READER_FETCH, KEY_APP_ERROR, KEY_TRANSLATION_TRACE]));
}

/* ==================== 耗时 ==================== */

export const KEY_LLM_TIMING = "llmTiming";

/**
 * 耗时留得比失败多。两者要看的东西不一样：失败看的是**单次现场**（模型吐了什么），
 * 耗时看的是**分布**（多久慢一次、慢在哪一段），十条根本看不出分布。
 * 一条记录十来个数字，五十条也就几 KB。
 */
export const MAX_TIMING_ENTRIES = 50;

export async function getLlmTimings(): Promise<LlmTiming[]> {
  const got = await local().get(KEY_LLM_TIMING);
  const v = got[KEY_LLM_TIMING];
  return Array.isArray(v) ? (v as LlmTiming[]) : [];
}

const NO_USAGE: RawUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * 记一次调用的耗时。成功由各条路径自己调；失败由 `recordFailure` 顺手带上，
 * 免得每个失败分支都写两行。
 *
 * 落盘失败吞掉，理由同 `recordFailure`：日志是附属品。
 */
const timingEntry = (source: LlmFailure["source"], config: LlmConfig, timing: CallTiming, usage: RawUsage, failedKind: string | null): LlmTiming => ({
  ts: Date.now(),
  source,
  failedKind,
  totalMs: timing.totalMs,
  firstTextMs: timing.firstTextMs,
  firstFieldMs: timing.firstFieldMs,
  attempts: timing.attempts,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  model: config.model,
});

const pushTiming = (stored: unknown, entry: LlmTiming): LlmTiming[] =>
  [...(Array.isArray(stored) ? (stored as LlmTiming[]) : []), entry].slice(-MAX_TIMING_ENTRIES);

export async function recordTiming(
  source: LlmFailure["source"],
  config: LlmConfig,
  timing: CallTiming,
  usage: RawUsage = NO_USAGE,
  failedKind: string | null = null,
): Promise<void> {
  try {
    await updateLocalOnly([KEY_LLM_TIMING], (v) => ({ [KEY_LLM_TIMING]: pushTiming(v[KEY_LLM_TIMING], timingEntry(source, config, timing, usage, failedKind)) }));
  } catch {
    /* 同 recordFailure：日志不能反过来把主流程搞坏 */
  }
}

/**
 * 一次成功的调用记一笔账：用量和耗时**一笔写完**。早先是两次读改写，各把整份状态库读出来再写回去。
 * 落盘失败吞掉，理由同 `recordFailure`。
 */
export async function recordCall(source: LlmFailure["source"], config: LlmConfig, timing: CallTiming, usage: RawUsage): Promise<void> {
  try {
    await updateLocalOnly([KEY_USAGE, KEY_LLM_TIMING], (v) => ({
      [KEY_USAGE]: bumpUsage(v[KEY_USAGE], usage.inputTokens, usage.outputTokens, false),
      [KEY_LLM_TIMING]: pushTiming(v[KEY_LLM_TIMING], timingEntry(source, config, timing, usage, null)),
    }));
  } catch {
    /* 见上 */
  }
}

/*
 * 不挡回复的落盘。记账和日志是附属品，人等的是译文：模型答完就该回话，账随后再记。
 * 排成一条链：几笔账之间不抢同一个库事务，测试也有个地方等它们落定（`bookkeepingSettled`）。
 * service worker 在最后一个事件之后还活三十秒，来得及；真被回收了丢的也只是一条日志。
 */
let deferred: Promise<void> = Promise.resolve();
export function later(task: () => Promise<void>): void {
  deferred = deferred.then(task).catch(() => undefined);
}
export const bookkeepingSettled = (): Promise<void> => deferred;

/** 各条路径交给 recordFailure 的现场。 */
export interface FailureContext {
  source: LlmFailure["source"];
  /** 请求里值得留下的部分，各路径各留各的；文章回顾只留标题、URL 和字数，不留正文 */
  request: LlmFailure["request"];
  /** 流式翻译下浮层是否已经显示过译文；非流式路径不填 */
  partialShown?: boolean;
  /** 人没看见的失败（自动重发成了、或抢救出了译文），见 `LlmFailure.recovered`。这类不记用量和耗时：那一整次调用另有一笔成功的账。 */
  recovered?: "retry" | "salvage";
}

/**
 * 从一次失败里抽出现场并落盘。
 *
 * 主动取消和缺配置不记——那不是"调用失败"，和用量统计的口径一致。
 * 落盘失败（多半是配额）吞掉：日志是附属品，不能反过来把给调用方的回复搞丢。
 */
export async function recordFailure(err: unknown, config: LlmConfig, ctx: FailureContext & { countUsage?: boolean }): Promise<void> {
  const e = err instanceof LlmError ? err : null;
  if (e && (e.kind === "abort" || e.kind === "config")) return;
  const entry: LlmFailure = {
    ts: Date.now(),
    source: ctx.source,
    kind: e?.kind ?? "unknown",
    status: e?.status ?? null,
    message: e ? e.message : String(err),
    stopReason: e?.raw?.stopReason ?? null,
    raw: e?.raw?.text ?? null,
    ...(e?.stream ? { stream: e.stream } : {}),
    partialShown: ctx.partialShown ?? null,
    ...(ctx.recovered ? { recovered: ctx.recovered } : {}),
    request: ctx.request,
    model: config.model,
    maxTokens: config.maxTokens,
  };
  // 失败也占"最近 50 次调用"里的一格：只记成功会把耗时分布看成一片岁月静好。
  // 缺配置那类没发出去的没有 timing，自然也就不记。模型答了、坏在解析上的，token 照样烧了（`LlmError.usage`），照实记。
  const spent = e?.usage ?? NO_USAGE;
  const timing = !ctx.recovered && e?.timing ? timingEntry(ctx.source, config, e.timing, spent, e.kind) : null;
  const keys = [KEY_LLM_LOG, ...(timing ? [KEY_LLM_TIMING] : []), ...(ctx.countUsage ? [KEY_USAGE] : [])];
  try {
    // 现场、耗时、用量三样一笔写完
    await updateLocalOnly(keys, (v) => ({
      [KEY_LLM_LOG]: pushFailure(v[KEY_LLM_LOG], entry),
      ...(timing ? { [KEY_LLM_TIMING]: pushTiming(v[KEY_LLM_TIMING], timing) } : {}),
      ...(ctx.countUsage ? { [KEY_USAGE]: bumpUsage(v[KEY_USAGE], spent.inputTokens, spent.outputTokens, true) } : {}),
    }));
  } catch {
    /* 日志是附属品，不能反过来把给调用方的回复搞丢 */
  }
}

/** 导出格式。和数据导出同一条规矩：密钥只导出"设没设过"。 */
export async function llmLogBundle(version: string): Promise<LlmLogBundle> {
  const llm = await getLlmConfig();
  return {
    schema: 4,
    exportedAt: Date.now(),
    version,
    llm: {
      baseUrl: llm.baseUrl,
      model: llm.model,
      maxTokens: llm.maxTokens,
      timeoutMs: llm.timeoutMs,
      apiKeySet: llm.apiKey.length > 0,
    },
    failures: await getLlmLog(),
    timings: await getLlmTimings(),
    translations: await getTranslationTraces(),
    fetches: await getFetchLog(),
    errors: await getAppErrors(),
    usage: await getUiUsage(),
  };
}
