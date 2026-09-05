import type { LlmConfig, LlmFailure, LlmLogBundle } from "../types.ts";
import { LlmError } from "../lib/llm.ts";
import { getLlmConfig } from "./vocab.ts";
import { serialize } from "./store.ts";

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

const local = (): chrome.storage.StorageArea => chrome.storage.local;

export async function getLlmLog(): Promise<LlmFailure[]> {
  const got = await local().get(KEY_LLM_LOG);
  const v = got[KEY_LLM_LOG];
  return Array.isArray(v) ? (v as LlmFailure[]) : [];
}

/** 超长的截掉尾部并留个标记，别让一条坏输出把日志撑爆。 */
export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[已截断，原长 ${s.length}]` : s;
}

export async function recordLlmFailure(entry: LlmFailure): Promise<void> {
  const safe: LlmFailure = {
    ...entry,
    raw: entry.raw === null ? null : clip(entry.raw, MAX_RAW_CHARS),
    request: Object.fromEntries(
      Object.entries(entry.request).map(([k, v]) => [k, typeof v === "string" ? clip(v, MAX_FIELD_CHARS) : v]),
    ),
  };
  await serialize(async () => {
    const log = await getLlmLog();
    log.push(safe);
    await local().set({ [KEY_LLM_LOG]: log.slice(-MAX_LOG_ENTRIES) });
  });
}

export async function clearLlmLog(): Promise<void> {
  await serialize(() => local().remove(KEY_LLM_LOG));
}

/** 各条路径交给 recordFailure 的现场。 */
export interface FailureContext {
  source: LlmFailure["source"];
  /** 请求里值得留下的部分，各路径各留各的；文章回顾只留标题、URL 和字数，不留正文 */
  request: LlmFailure["request"];
  /** 流式翻译下浮层是否已经显示过译文；非流式路径不填 */
  partialShown?: boolean;
}

/**
 * 从一次失败里抽出现场并落盘。
 *
 * 主动取消和缺配置不记——那不是"调用失败"，和用量统计的口径一致。
 * 落盘失败（多半是配额）吞掉：日志是附属品，不能反过来把给调用方的回复搞丢。
 */
export async function recordFailure(err: unknown, config: LlmConfig, ctx: FailureContext): Promise<void> {
  const e = err instanceof LlmError ? err : null;
  if (e && (e.kind === "abort" || e.kind === "config")) return;
  try {
    await recordLlmFailure({
      ts: Date.now(),
      source: ctx.source,
      kind: e?.kind ?? "unknown",
      status: e?.status ?? null,
      message: e ? e.message : String(err),
      stopReason: e?.raw?.stopReason ?? null,
      raw: e?.raw?.text ?? null,
      partialShown: ctx.partialShown ?? null,
      request: ctx.request,
      model: config.model,
      maxTokens: config.maxTokens,
    });
  } catch {
    /* 见上：日志不能影响主流程 */
  }
}

/** 导出格式。和数据导出同一条规矩：密钥只导出"设没设过"。 */
export async function llmLogBundle(version: string): Promise<LlmLogBundle> {
  const llm = await getLlmConfig();
  return {
    schema: 1,
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
  };
}
