import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AppError, LlmFailure, ReaderFetch } from "../src/types.ts";
import { DEFAULT_LLM } from "../src/types.ts";
import { type CallTiming, LlmError } from "../src/lib/llm.ts";
import {
  KEY_LLM_LOG,
  MAX_FIELD_CHARS,
  MAX_LOG_ENTRIES,
  MAX_RAW_CHARS,
  MAX_TIMING_ENTRIES,
  clearLlmLog,
  getLlmLog,
  getLlmTimings,
  llmLogBundle,
  recordFailure,
  recordLlmFailure,
  recordTiming,
} from "../src/background/llmLog.ts";
import { getAppErrors, getFetchLog, recordAppError, recordFetch } from "../src/background/appLog.ts";
import { setLlmConfig } from "../src/background/vocab.ts";
import { clearData } from "../src/background/store.ts";

/** 与 vocab.test.ts 同款内存 storage：深拷贝，暴露"改了没写回"这类错误。 */
function fakeArea() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys: string | string[] | null) {
      if (keys === null) return structuredClone(Object.fromEntries(data));
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

let area = fakeArea();
(globalThis as Record<string, unknown>)["chrome"] = { storage: { get local() { return area; } } };
beforeEach(() => {
  area = fakeArea();
});

const CFG = { ...DEFAULT_LLM, apiKey: "k", model: "M-test" };

/** App 那两份各一条，够验证它们跟着一起清、一起导出。字段本身在 appLog.test.ts 里测。 */
const FETCH: ReaderFetch = {
  ts: 1,
  url: "https://e.com",
  finalUrl: "https://e.com",
  status: 200,
  contentType: "text/html",
  charset: "utf-8",
  charsetFrom: "header",
  bytes: 10,
  bom: false,
  fellBack: false,
  replacementChars: 0,
  title: "t",
  chars: 5,
  error: null,
  ms: 1,
};
const APP_ERROR: AppError = { ts: 1, kind: "error", message: "boom", at: null, stack: null };

function entry(over: Partial<LlmFailure> = {}): LlmFailure {
  return {
    ts: 1,
    source: "translate",
    kind: "parse",
    status: null,
    message: "JSON 解析失败",
    stopReason: "end_turn",
    raw: '{"translation": "泄',
    partialShown: false,
    request: { text: "leaks" },
    model: "M",
    maxTokens: 4096,
    ...over,
  };
}

test("没有日志、或日志键被写坏，都读成空数组", async () => {
  assert.deepEqual(await getLlmLog(), []);
  await area.set({ [KEY_LLM_LOG]: "garbage" });
  assert.deepEqual(await getLlmLog(), []);
});

test("只留最近 MAX_LOG_ENTRIES 条，丢最早的", async () => {
  for (let i = 0; i < MAX_LOG_ENTRIES + 3; i++) await recordLlmFailure(entry({ ts: i }));
  const log = await getLlmLog();
  assert.equal(log.length, MAX_LOG_ENTRIES);
  assert.equal(log[0]!.ts, 3);
  assert.equal(log.at(-1)!.ts, MAX_LOG_ENTRIES + 2);
});

test("超长原文截尾并留标记，请求里的长字段同样截，数字不动", async () => {
  await recordLlmFailure(entry({ raw: "x".repeat(MAX_RAW_CHARS + 5), request: { context: "y".repeat(MAX_FIELD_CHARS + 10), n: 5 } }));
  const [e] = await getLlmLog();
  assert.ok(e!.raw!.startsWith("x".repeat(MAX_RAW_CHARS)));
  assert.match(e!.raw!, /已截断，原长 \d+/);
  assert.ok(e!.raw!.length < MAX_RAW_CHARS + 40);
  assert.match(String(e!.request["context"]), /已截断/);
  assert.equal(e!.request["n"], 5);
  // 短的原样
  await recordLlmFailure(entry({ raw: "short" }));
  assert.equal((await getLlmLog())[1]!.raw, "short");
});

test("recordFailure 从 LlmError 里抽出 kind / status / 原文 / stop_reason", async () => {
  const err = new LlmError("JSON 解析失败：x", "parse");
  err.raw = { text: '{"translation": "泄', stopReason: "end_turn" };
  await recordFailure(err, CFG, { source: "translate", request: { text: "leaks" }, partialShown: true });
  const http = new LlmError("HTTP 429：限流", "http", 429);
  await recordFailure(http, CFG, { source: "assist", request: { mode: "quiz" } });
  const [a, b] = await getLlmLog();
  assert.equal(a!.kind, "parse");
  assert.equal(a!.raw, '{"translation": "泄');
  assert.equal(a!.stopReason, "end_turn");
  assert.equal(a!.partialShown, true);
  assert.equal(a!.model, "M-test");
  assert.equal(b!.kind, "http");
  assert.equal(b!.status, 429);
  assert.equal(b!.raw, null);
  assert.equal(b!.partialShown, null);
});

test("主动取消和缺配置不记；不是 LlmError 的也记，kind 为 unknown", async () => {
  await recordFailure(new LlmError("已取消", "abort"), CFG, { source: "translate", request: {} });
  await recordFailure(new LlmError("没 key", "config"), CFG, { source: "translate", request: {} });
  assert.deepEqual(await getLlmLog(), []);
  await recordFailure(new TypeError("boom"), CFG, { source: "test", request: {} });
  const [e] = await getLlmLog();
  assert.equal(e!.kind, "unknown");
  assert.match(e!.message, /boom/);
});

test("落盘失败不会抛给调用方", async () => {
  area.set = async () => {
    throw new Error("QUOTA_BYTES");
  };
  await assert.rejects(recordLlmFailure(entry()));
  await recordFailure(new LlmError("x", "parse"), CFG, { source: "translate", request: {} });
});

test("清空日志；「清空全部记录」也把日志一起清掉，但配置保留", async () => {
  await recordLlmFailure(entry());
  await clearLlmLog();
  assert.deepEqual(await getLlmLog(), []);
  await recordLlmFailure(entry());
  await setLlmConfig({ apiKey: "secret" });
  await clearData();
  assert.deepEqual(await getLlmLog(), []);
  assert.equal((await llmLogBundle("0")).llm.apiKeySet, true);
});

/* ---------- 耗时 ---------- */

const TIMING: CallTiming = { totalMs: 1_800, firstTextMs: 700, firstFieldMs: 900, attempts: 1 };

test("成功的调用也记一条耗时，四个数字原样落盘", async () => {
  await recordTiming("translate", CFG, TIMING, { inputTokens: 249, outputTokens: 58 });
  const [t] = await getLlmTimings();
  assert.equal(t!.source, "translate");
  assert.equal(t!.failedKind, null); // 成功
  assert.equal(t!.totalMs, 1_800);
  assert.equal(t!.firstTextMs, 700);
  assert.equal(t!.firstFieldMs, 900);
  assert.equal(t!.attempts, 1);
  assert.equal(t!.outputTokens, 58); // 耗时和输出长度成正比，两个得一起看
  assert.equal(t!.model, "M-test");
});

test("只留最近 MAX_TIMING_ENTRIES 条——看的是分布，不是全部历史", async () => {
  for (let i = 0; i < MAX_TIMING_ENTRIES + 3; i++) await recordTiming("ask", CFG, { ...TIMING, totalMs: i });
  const log = await getLlmTimings();
  assert.equal(log.length, MAX_TIMING_ENTRIES);
  assert.equal(log[0]!.totalMs, 3);
});

test("失败也占一格，带上是怎么失败的——只记成功会把分布看成一片岁月静好", async () => {
  const err = new LlmError(`请求超时（60000ms）`, "timeout");
  err.timing = { totalMs: 60_000, firstTextMs: 700, firstFieldMs: 900, attempts: 2 };
  await recordFailure(err, CFG, { source: "translate", request: {} });
  const [t] = await getLlmTimings();
  assert.equal(t!.failedKind, "timeout");
  assert.equal(t!.totalMs, 60_000);
  // 译文其实 900ms 就到了，卡的是后面——这正是要能看出来的那件事
  assert.equal(t!.firstFieldMs, 900);
  assert.equal(t!.attempts, 2);
});

test("主动取消、缺配置、以及压根没耗时的失败都不记", async () => {
  const abort = new LlmError("已取消", "abort");
  abort.timing = { ...TIMING };
  await recordFailure(abort, CFG, { source: "translate", request: {} });
  await recordFailure(new LlmError("没 key", "config"), CFG, { source: "translate", request: {} });
  // 不是 LlmError 的进得了失败日志，但身上没有耗时，耗时这边就该空着
  await recordFailure(new TypeError("boom"), CFG, { source: "test", request: {} });
  assert.deepEqual(await getLlmTimings(), []);
});

test("耗时落盘失败同样不抛给调用方", async () => {
  area.set = async () => {
    throw new Error("QUOTA_BYTES");
  };
  await recordTiming("translate", CFG, TIMING);
});

test("清空日志四样一起清——按钮清的是整份诊断日志，不只 LLM 那两份", async () => {
  await recordTiming("translate", CFG, TIMING);
  await recordLlmFailure(entry());
  await recordFetch(FETCH);
  await recordAppError(APP_ERROR);
  await clearLlmLog();
  assert.deepEqual(await getLlmTimings(), []);
  assert.deepEqual(await getLlmLog(), []);
  assert.deepEqual(await getFetchLog(), []);
  assert.deepEqual(await getAppErrors(), []);
});

test("导出包带版本与配置，不含 apiKey", async () => {
  await setLlmConfig({ apiKey: "secret-key", model: "M-x" });
  await recordLlmFailure(entry());
  await recordTiming("translate", CFG, TIMING);
  await recordFetch(FETCH);
  await recordAppError(APP_ERROR);
  const b = await llmLogBundle("0.3.0");
  assert.equal(b.schema, 2); // 2 起多了 timings、fetches、errors
  assert.equal(b.version, "0.3.0");
  assert.equal(b.llm.model, "M-x");
  assert.equal(b.llm.apiKeySet, true);
  assert.equal(b.failures.length, 1);
  assert.equal(b.timings.length, 1); // 失败日志和耗时环一起导出
  // 抓取与运行时错误也在同一份里：分成三个文件只会让人少发过来两个
  assert.equal(b.fetches.length, 1);
  assert.equal(b.errors.length, 1);
  assert.ok(!JSON.stringify(b).includes("secret-key"));
});

test("流式原始分块随失败持久化并进入诊断导出", async () => {
  const err = new LlmError("流中断", "stream_interrupted");
  err.raw = { text: "半截文本", stopReason: "" };
  err.stream = { chunks: ['data: {坏的\n'], capturedChars: 11, totalChars: 11, clipped: false, messageStop: false };
  await recordFailure(err, CFG, { source: "translate", request: {} });
  const bundle = await llmLogBundle("test");
  assert.deepEqual(bundle.failures[0]?.stream, err.stream);
  assert.equal(bundle.failures[0]?.raw, "半截文本");
});
