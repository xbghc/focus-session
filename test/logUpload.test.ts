import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { KEY_LOG_UPLOAD, LOG_RETRY_MS, LOG_UNSUPPORTED_MS, uploadLogs, type LogUpload } from "../src/background/logUpload.ts";
import { KEY_LLM_LOG, KEY_LLM_TIMING, clearLlmLog } from "../src/background/llmLog.ts";
import { KEY_TRANSLATION_TRACE } from "../src/features/translation/translationLog.ts";
import { KEY_APP_ERROR } from "../src/background/appLog.ts";
import { setUiPlatform } from "../src/background/uiUsage.ts";

/*
 * 诊断日志的上传：只传新增和改写过的，传成才算数，服务器旧（404）就一天问一次，任何失败都不外溢。
 */

/** 与 uiUsage.test.ts 同款内存 storage。 */
function fakeArea() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys: string | string[] | null) {
      if (keys === null) return structuredClone(Object.fromEntries(data));
      const out: Record<string, unknown> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) { for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v)); },
    async remove(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k); },
  };
}
let area = fakeArea();
(globalThis as Record<string, unknown>)["chrome"] = {
  storage: { get local() { return area; } },
  runtime: { getManifest: () => ({ version: "0.3.15" }) },
};
beforeEach(() => { area = fakeArea(); setUiPlatform("extension"); });

const NOW = Date.parse("2026-09-25T12:00:00Z");
const failure = { ts: NOW - 5000, source: "translate", kind: "parse", status: null, message: "坏 JSON", raw: '{"translation":' };
const trace = (status: string) => ({ id: "t1", ts: NOW - 3000, status, text: "leaks" });

function recorder(fail?: { status?: number }) {
  const sent: LogUpload[] = [];
  const post = async (body: LogUpload) => { if (fail) throw Object.assign(new Error("x"), fail); sent.push(structuredClone(body)); };
  return { sent, post };
}

test("第一次把五份日志里的全部传上去，带上设备、平台和版本；再跑一轮什么都不发", async () => {
  area.data.set(KEY_LLM_LOG, [failure]);
  area.data.set(KEY_LLM_TIMING, [{ ts: NOW - 5000, totalMs: 900 }]);
  area.data.set(KEY_TRANSLATION_TRACE, [trace("error")]);
  area.data.set(KEY_APP_ERROR, [{ ts: NOW - 1000, message: "boom" }]);
  const { sent, post } = recorder();
  await uploadLogs(post, "laptop", NOW);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0]!.deviceId, sent[0]!.platform, sent[0]!.version], ["laptop", "extension", "0.3.15"]);
  assert.deepEqual(sent[0]!.entries.map((e) => e.kind), ["failure", "timing", "translation", "error"]);
  assert.deepEqual(sent[0]!.entries[0]!.entry, failure, "失败现场原样上传，包括模型的原始输出");
  await uploadLogs(post, "laptop", NOW + 60_000);
  assert.equal(sent.length, 1, "没有新东西就不发请求");
});

test("只传新增的，以及原地改写过的翻译轨迹", async () => {
  area.data.set(KEY_LLM_LOG, [failure]);
  area.data.set(KEY_TRANSLATION_TRACE, [trace("unobserved")]);
  const { sent, post } = recorder();
  await uploadLogs(post, "laptop", NOW);
  const second = { ...failure, ts: NOW, message: "超时" };
  area.data.set(KEY_LLM_LOG, [failure, second]);
  area.data.set(KEY_TRANSLATION_TRACE, [trace("success")]);
  await uploadLogs(post, "laptop", NOW + 60_000);
  assert.deepEqual(sent[1]!.entries, [{ kind: "failure", entry: second }, { kind: "translation", entry: trace("success") }]);
});

test("传不上去：原样留着下回再传；服务器没有这个接口就一天问一次；都不抛错", async () => {
  area.data.set(KEY_LLM_LOG, [failure]);
  const down = recorder({ status: 503 });
  await uploadLogs(down.post, "laptop", NOW);
  assert.equal((area.data.get(KEY_LOG_UPLOAD) as { nextUploadAt: number }).nextUploadAt, NOW + LOG_RETRY_MS);
  const ok = recorder();
  await uploadLogs(ok.post, "laptop", NOW + 60_000);
  assert.equal(ok.sent.length, 0, "重试时刻之前不发");
  await uploadLogs(ok.post, "laptop", NOW + LOG_RETRY_MS);
  assert.equal(ok.sent[0]!.entries.length, 1, "没传成的那条还在");

  area.data.set(KEY_LLM_LOG, [failure, { ...failure, ts: NOW + 1 }]);
  await uploadLogs(recorder({ status: 404 }).post, "laptop", NOW + LOG_RETRY_MS);
  assert.equal((area.data.get(KEY_LOG_UPLOAD) as { nextUploadAt: number }).nextUploadAt, NOW + LOG_RETRY_MS + LOG_UNSUPPORTED_MS);

  area.get = async () => { throw new Error("存储坏了"); };
  await uploadLogs(ok.post, "laptop", NOW + 10 * LOG_UNSUPPORTED_MS);
});

test("清空日志之后传过的指纹跟着清掉，App 上报自己的平台", async () => {
  area.data.set(KEY_LLM_LOG, [failure]);
  const { sent, post } = recorder();
  await uploadLogs(post, "phone", NOW);
  await clearLlmLog();
  area.data.set(KEY_APP_ERROR, [{ ts: NOW, message: "boom" }]);
  setUiPlatform("app");
  await uploadLogs(post, "phone", NOW + 60_000);
  assert.equal(sent[1]!.platform, "app");
  assert.deepEqual((area.data.get(KEY_LOG_UPLOAD) as { sent: string[] }).sent.length, 1, "只留还在本机日志里的那条");
  // 同一条失败清掉后又出现（比如重新导入了日志）：指纹已经不在，会再传一次，服务器按内容去重
  area.data.set(KEY_LLM_LOG, [failure]);
  await uploadLogs(post, "phone", NOW + 120_000);
  assert.deepEqual(sent[2]!.entries.map((e) => e.kind), ["failure"]);
});
