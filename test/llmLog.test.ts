import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { LlmFailure } from "../src/types.ts";
import { DEFAULT_LLM } from "../src/types.ts";
import { LlmError } from "../src/lib/llm.ts";
import {
  KEY_LLM_LOG,
  MAX_FIELD_CHARS,
  MAX_LOG_ENTRIES,
  MAX_RAW_CHARS,
  clearLlmLog,
  getLlmLog,
  llmLogBundle,
  recordFailure,
  recordLlmFailure,
} from "../src/background/llmLog.ts";
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

test("导出包带版本与配置，不含 apiKey", async () => {
  await setLlmConfig({ apiKey: "secret-key", model: "M-x" });
  await recordLlmFailure(entry());
  const b = await llmLogBundle("0.3.0");
  assert.equal(b.schema, 1);
  assert.equal(b.version, "0.3.0");
  assert.equal(b.llm.model, "M-x");
  assert.equal(b.llm.apiKeySet, true);
  assert.equal(b.failures.length, 1);
  assert.ok(!JSON.stringify(b).includes("secret-key"));
});
