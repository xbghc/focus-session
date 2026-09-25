import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { TranslateRequest } from "../src/types.ts";
import { bookkeepingSettled, getLlmLog, getLlmTimings } from "../src/background/llmLog.ts";
import { getUsage, setLlmConfig } from "../src/core/background/llm.ts";
import { updateLocalOnly } from "../src/background/store.ts";
import { streamTranslate } from "../src/features/translation/translate.ts";
import { freshState, installStorage, memoryDriver, onLocalMutation } from "../src/sync/storage.ts";

/*
 * 后台翻译整条路：模型答完 → 存划词 → 回复 → 随后记账。盯的是诊断日志里量出来的那一秒——
 * 用量、耗时两笔落盘早先挡在回复前面——以及自动重发在日志里留下的痕迹。
 */

/** 内存 storage；`gate` 关着时，记账那几个键的写入悬着不落定，用来证明回复不等它们。 */
function fakeArea() {
  const data = new Map<string, unknown>();
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  return {
    data,
    hold() { gate = new Promise<void>((resolve) => { release = resolve; }); },
    open() { release?.(); gate = undefined; },
    async get(keys: string | string[] | null) {
      if (keys === null) return structuredClone(Object.fromEntries(data));
      const out: Record<string, unknown> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      if (gate && Object.keys(items).some((k) => k === "llmUsage" || k === "llmTiming" || k === "llmLog")) await gate;
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k); },
  };
}
let area = fakeArea();
(globalThis as Record<string, unknown>)["chrome"] = { storage: { get local() { return area; } } };

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });
/** 依次给出这几条 SSE 流；用完了重复最后一条。 */
function serve(...texts: string[]): { calls: number } {
  const state = { calls: 0 };
  const enc = new TextEncoder();
  globalThis.fetch = (async () => {
    const text = texts[Math.min(state.calls++, texts.length - 1)]!;
    const evt = (o: unknown): string => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
    const chunks = [evt({ type: "message_start", message: { usage: { input_tokens: 0 } } })];
    for (let i = 0; i < text.length; i += 9) chunks.push(evt({ type: "content_block_delta", delta: { type: "text_delta", text: text.slice(i, i + 9) } }));
    chunks.push(evt({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 300, output_tokens: 80 } }));
    let i = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(c) { if (i >= chunks.length) c.close(); else c.enqueue(enc.encode(chunks[i++]!)); } }), { status: 200 });
  }) as typeof fetch;
  return state;
}

let n = 0;
/** 每条用例一个新词：翻译结果进内存缓存，同一个词第二次不发请求。 */
const req = (): TranslateRequest => ({ articleId: "https://a.com/p", url: "https://a.com/p", articleTitle: "T", text: `tightrope${++n}`, context: "on a tightrope", kind: "word", explainVocab: true });
const GOOD = `{"translation":"钢丝","phonetic":"/ˈtaɪtroʊp/","pos":"noun","lemma":"tightrope","context_note":"比喻保持平衡。","usage":"walk a tightrope。"}`;
const EMPTY = `{"translation":"","phonetic":"/ˈtaɪtroʊp/","pos":"noun","lemma":"tightrope","context_note":"比喻保持平衡。","usage":"walk a tightrope。"}`;

beforeEach(async () => {
  area.open(); // 上一条用例断言失败时闸门可能还关着，别让它把后面的全堵死
  await bookkeepingSettled();
  area = fakeArea();
  await setLlmConfig({ apiKey: "k" });
});

test("模型答完、划词存好就回复；用量和耗时随后一笔记上，不让人等", async () => {
  serve(GOOD);
  area.hold();
  const reply = await Promise.race([streamTranslate(req(), () => {}).done, new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000))]);
  assert.ok(reply, "记账的写入还悬着，回复就该到了");
  assert.ok(reply.ok && reply.snippet.translation === "钢丝");
  // 链路轨迹里这两格从此没有数：它们量的那两笔不在回复的路上了；存划词那一笔还在
  assert.ok(reply.diagnostics?.accountingMs === null && reply.diagnostics.diagnosticWriteMs === null && reply.diagnostics.snippetWriteMs !== null);
  assert.equal((await getUsage()).requests, 0);
  area.open();
  await bookkeepingSettled();
  const usage = await getUsage();
  assert.deepEqual([usage.requests, usage.inputTokens, usage.outputTokens, usage.errors], [1, 300, 80, 0]);
  const [t] = await getLlmTimings();
  assert.deepEqual([t!.source, t!.failedKind, t!.attempts, t!.outputTokens], ["translate", null, 1, 80]);
  assert.deepEqual(await getLlmLog(), []);
});

test("空译文自动重发成了：人看到的是成功，日志里留一条带 recovered 的现场，账只记一笔", async () => {
  const served = serve(EMPTY, GOOD);
  const reply = await streamTranslate(req(), () => {}).done;
  assert.ok(reply.ok && reply.snippet.translation === "钢丝");
  assert.equal(served.calls, 2);
  await bookkeepingSettled();
  const log = await getLlmLog();
  assert.equal(log.length, 1);
  assert.deepEqual([log[0]!.recovered, log[0]!.kind, log[0]!.raw], ["retry", "parse", EMPTY]);
  assert.match(log[0]!.message, /没有返回 translation/);
  const timings = await getLlmTimings();
  assert.equal(timings.length, 1, "重发的那次不另占一格");
  assert.deepEqual([timings[0]!.failedKind, timings[0]!.attempts, timings[0]!.inputTokens, timings[0]!.outputTokens], [null, 2, 600, 160]);
  const usage = await getUsage();
  assert.deepEqual([usage.requests, usage.errors, usage.outputTokens], [1, 0, 160]);
});

test("两次都坏：照旧报错，但烧掉的 token 照实记——早先解析失败一律记成 0", async () => {
  serve(EMPTY);
  const reply = await streamTranslate(req(), () => {}).done;
  assert.ok(!reply.ok && /没有返回 translation/.test(reply.error));
  await bookkeepingSettled();
  const usage = await getUsage();
  assert.deepEqual([usage.requests, usage.errors, usage.inputTokens, usage.outputTokens], [1, 1, 600, 160]);
  const [t] = await getLlmTimings();
  assert.deepEqual([t!.failedKind, t!.attempts, t!.outputTokens], ["parse", 2, 160]);
  const [f] = await getLlmLog();
  assert.equal(f!.recovered, undefined, "人真撞上的失败没有这个标记");
});

test("有状态库时：记账走本机专用的直写，不进 outbox、不催同步；只有划词那一笔照常排同步", async () => {
  const driver = memoryDriver(freshState());
  installStorage(driver);
  let mutations = 0;
  onLocalMutation(() => { mutations++; });
  try {
    await setLlmConfig({ apiKey: "k" });
    await driver.update((s) => { s.outbox = []; });
    mutations = 0;
    serve(GOOD);
    const reply = await streamTranslate(req(), () => {}).done;
    assert.ok(reply.ok);
    const afterSnippet = mutations;
    assert.ok(afterSnippet >= 1, "划词是会同步的数据");
    await bookkeepingSettled();
    assert.equal(mutations, afterSnippet, "用量、耗时落盘不催同步");
    const state = await driver.read();
    assert.equal((state.data["llmUsage"] as { requests: number }).requests, 1);
    assert.equal((state.data["llmTiming"] as unknown[]).length, 1);
    assert.ok(state.outbox.length >= 1 && state.outbox.every((op) => op.record.type === "snippet" || op.record.type === "card"), JSON.stringify(state.outbox.map((op) => op.record.type)));
    // 白名单之外的键不给直写：那样改出来的东西进不了 outbox，别的设备永远看不到
    await assert.rejects(updateLocalOnly(["snippets"], () => ({ snippets: [] })), /不是本机专用/);
  } finally {
    onLocalMutation(() => {});
    installStorage(undefined as never);
  }
});
