import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TRACE_SPANS, traceDurations } from "../src/lib/translationDiagnostics.ts";
import {
  KEY_TRANSLATION_TRACE,
  MAX_TRANSLATION_TRACES,
  getTranslationTraces,
  recordTranslationTrace,
  sanitizeTranslationTrace,
} from "../src/background/translationLog.ts";
import { TranslationTraceRecorder } from "../src/content/translationTrace.ts";

/*
 * 翻译链路轨迹的后台这一半：内容脚本送来的东西只认已知字段、截尾限量，落盘同 id 覆盖、最多 100 条，
 * 坏数据与写失败都不外溢。最要紧的一条是**真实的 Date.now() 时间戳要过得了校验**：早先拿相对毫秒的
 * 1e12 上限去卡它，2001 年以后的时间戳全被当成坏数据，功能在生产里一条也没落过盘。所以末尾有一条
 * 用真记录器生成、再走完整清洗落盘的回路用例——只喂手写的 fixture 看不出"生产数据长得不一样"。
 */

/** 与 llmLog.test.ts 同款内存 storage：深拷贝，暴露"改了没写回"这类错误。 */
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

const pos = { x: 1, y: 2, width: 3, height: 4, scale: 1 };
const popup = { measurement: "animation-frame", positionCalls: 1, positionChanges: 0, samples: 1, initial: pos, final: pos, moves: [], movesTruncated: false };
/** 内容脚本送来的一条轨迹，字段齐全；override 用来各改一处看清洗怎么处理。 */
const raw = (override: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "t-1", ts: Date.now(), source: "mouse", status: "success", kind: "word", text: "river", textChars: 5, reason: null, cached: false,
  marks: { inputStart: 0, selectionEnd: 120.456, requestStart: 400, responseReceived: 900, ended: 950 },
  partials: [{ atMs: 600, renderMs: 1.5, fields: ["translation", "phonetic"] }],
  backend: { cache: "miss", subscriberMs: 1, totalMs: 480, configMs: 2, modelMs: 470, firstTextMs: 200, firstFieldMs: 300, attempts: 1,
    accountingMs: 1, diagnosticWriteMs: 2, snippetWriteMs: 3 },
  popup,
  ...override,
});

test("traceDurations：两个端点都有才算，缺一个就不填，倒着的钉在 0", () => {
  const d = traceDurations({ inputStart: 0, selectionEnd: 100, requestStart: 300, responseReceived: 250, ended: 900 });
  assert.equal(d.interactionMs, 100);
  assert.equal(d.requestMs, 0); // 倒着的不伪装成负数
  assert.equal(d.totalMs, 900);
  assert.equal(d.debounceMs, undefined); // 没有 debounceEnd
  assert.ok(Object.keys(d).every((k) => k in TRACE_SPANS));
});

test("真实的 Date.now() 时间戳过得了校验；缺失、非正、Infinity、字符串才拒", () => {
  const r = raw();
  const t = sanitizeTranslationTrace(r);
  assert.ok(t, "今天的时间戳约 1.79e12，不能拿相对毫秒的上限去卡它");
  assert.equal(t.ts, r.ts);
  assert.equal(t.text, "river");
  assert.deepEqual(t.marks, { inputStart: 0, selectionEnd: 120.46, requestStart: 400, responseReceived: 900, ended: 950 });
  assert.equal(t.durations.requestMs, 500);
  assert.equal(t.backend?.cache, "miss");
  assert.equal(t.backend?.modelMs, 470);
  for (const ts of [undefined, 0, -1, Infinity, "1"]) assert.equal(sanitizeTranslationTrace(raw({ ts })), null, String(ts));
});

test("只认已知字段：来源/状态/粒度不对整条丢掉；未知打点、未知字段、离谱数字丢掉；文本与原因截尾，id 限长", () => {
  assert.equal(sanitizeTranslationTrace(raw({ source: "voice" })), null);
  assert.equal(sanitizeTranslationTrace(raw({ status: "done" })), null);
  assert.equal(sanitizeTranslationTrace(raw({ kind: "paragraph" })), null);
  assert.equal(sanitizeTranslationTrace(raw({ id: "" })), null);
  assert.equal(sanitizeTranslationTrace(null), null);
  assert.equal(sanitizeTranslationTrace("x"), null);
  const t = sanitizeTranslationTrace(raw({
    id: "x".repeat(100), text: "a".repeat(200), reason: "r".repeat(400), cached: "yes", textChars: 7.9,
    marks: { inputStart: 0, bogus: 5, requestStart: -3, responseReceived: Infinity, ended: 10.123 },
    partials: [{ atMs: 1, renderMs: 2, fields: ["translation", "context", "dom"] }],
    backend: { cache: "warm" },
  }))!;
  assert.equal(t.id.length, 80);
  assert.equal(t.text.length, 160);
  assert.equal(t.reason!.length, 300);
  assert.equal(t.cached, null);
  assert.equal(t.textChars, 7);
  assert.deepEqual(t.marks, { inputStart: 0, ended: 10.12 });
  assert.deepEqual(t.durations, { totalMs: 10.12 }); // 耗时按清洗后的打点重算，不信送来的
  assert.deepEqual(t.partials, [{ atMs: 1, renderMs: 2, fields: ["translation"] }]);
  assert.equal(t.backend, null);
});

test("浮层位置：坏坐标丢掉，挪动记录最多 100 条并标出截断", () => {
  const move = (i: number) => ({ atMs: i, from: { ...pos, x: i }, to: { ...pos, x: i + 1 } });
  const few = sanitizeTranslationTrace(raw({ popup: { ...popup, initial: { x: "1" }, moves: [{ atMs: 1, from: null, to: pos }, move(0)] } }))!;
  assert.equal(few.popup.initial, null);
  assert.deepEqual(few.popup.moves, [move(0)]);
  assert.equal(few.popup.movesTruncated, false);
  const many = sanitizeTranslationTrace(raw({ popup: { ...popup, moves: Array.from({ length: 101 }, (_, i) => move(i)) } }))!;
  assert.equal(many.popup.moves.length, 100);
  assert.equal(many.popup.movesTruncated, true);
  assert.equal(many.popup.measurement, "animation-frame");
});

test("落盘：同 id 覆盖、只留最近 100 条、整条不合法不记、写失败不外溢", async () => {
  await recordTranslationTrace(raw({ id: "a", text: "old" }));
  await recordTranslationTrace(raw({ id: "a", text: "new" }));
  assert.deepEqual((await getTranslationTraces()).map((t) => [t.id, t.text]), [["a", "new"]]);
  assert.ok(area.data.has(KEY_TRANSLATION_TRACE));
  await recordTranslationTrace(raw({ source: "voice" }));
  assert.equal((await getTranslationTraces()).length, 1);
  for (let i = 0; i < MAX_TRANSLATION_TRACES + 5; i++) await recordTranslationTrace(raw({ id: `t${i}` }));
  const all = await getTranslationTraces();
  assert.equal(all.length, MAX_TRANSLATION_TRACES);
  assert.equal(all[0]!.id, "t5"); // "a" 和最早的五条被挤掉
  assert.equal(all.at(-1)!.id, `t${MAX_TRANSLATION_TRACES + 4}`);
  area.set = async () => {
    throw new Error("QUOTA_BYTES");
  };
  await recordTranslationTrace(raw({ id: "z" })); // 诊断写失败不能反过来影响翻译
  assert.equal((await getTranslationTraces()).length, MAX_TRANSLATION_TRACES);
});

test("回路：真记录器生成的轨迹原样清洗、落盘，一条不丢", async () => {
  // Node 里没有 requestAnimationFrame：complete 一到就收束，save 同步被调
  let saved: unknown = null;
  const rec = new TranslationTraceRecorder({ source: "tap", started: 100, committed: 130, resolved: 131, debounceEnded: 280 },
    "kept", "word", (log) => { saved = log; }, () => 300);
  rec.mark("requestStart");
  rec.complete("success");
  assert.ok(saved);
  await recordTranslationTrace(saved);
  const [stored] = await getTranslationTraces();
  assert.ok(stored, "真实时间戳必须过得了校验，这条以前整条被丢");
  assert.equal(stored.id, (saved as { id: string }).id);
  assert.equal(stored.status, "unobserved");
  assert.equal(stored.text, "kept");
  assert.ok(Math.abs(stored.ts - Date.now()) < 5_000);
  assert.deepEqual(Object.keys(stored.marks).sort(),
    ["debounceEnd", "ended", "finalDom", "inputStart", "requestStart", "selectionEnd", "selectionResolved"]);
  assert.equal(stored.durations.requestMs, undefined); // 没有 responseReceived 就不填
  assert.equal(stored.durations.totalMs, 200);
});
