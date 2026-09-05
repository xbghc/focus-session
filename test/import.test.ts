import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ExportBundle, Session, TranslationResult } from "../src/types.ts";

/** 与 store.test.ts 同款内存 storage。 */
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
let idSeq = 0;
(globalThis as Record<string, unknown>)["chrome"] = { storage: { get local() { return area; } } };
Object.defineProperty(globalThis.crypto, "randomUUID", {
  configurable: true,
  value: () => `id-${++idSeq}`,
});

const store = await import("../src/background/store.ts");
const vocab = await import("../src/background/vocab.ts");

beforeEach(() => {
  area = fakeArea();
  idSeq = 0;
});

const A = "https://example.com/a";

const tr = (over: Partial<TranslationResult> = {}): TranslationResult => ({
  translation: "泄漏",
  contextNote: "指抽象暴露底层细节",
  pos: "verb",
  phonetic: "/liːks/",
  lemma: "leak",
  usage: null,
  vocab: [],
  ...over,
});

const session = (startTs: number, endTs: number, wordsRead: number): Session => ({
  id: `s${startTs}`,
  articleId: A,
  url: A,
  title: "测试文章",
  startTs,
  endTs,
  wordsRead,
  endReason: "idle",
});

/** 在「手机」上读一篇文章、划一个词，导出。 */
async function phoneExport(): Promise<ExportBundle> {
  await store.upsertArticleMeta({
    articleId: A,
    url: A,
    title: "测试文章",
    totalWords: 1000,
    trackedWords: 1000,
    paragraphCount: 4,
    expectedMs: 250_000,
    now: 1_000,
  });
  await store.commitSession(session(10_000, 70_000, 250), [
    { index: 0, hash: "h0", words: 250, firstSeenTs: 20_000, dwellMs: 30_000 },
  ]);
  await store.savePosition({ articleId: A, hash: "h0", index: 0, offset: 200, paragraphCount: 4, savedTs: 60_000 });
  await vocab.addSnippet({
    articleId: A,
    url: A,
    articleTitle: "测试文章",
    text: "leaks",
    kind: "word",
    context: "Every abstraction leaks.",
    result: tr(),
    now: 65_000,
  });
  return store.exportAll();
}

test("导出文件带上阅读位置，schema 4", async () => {
  const bundle = await phoneExport();
  assert.equal(bundle.schema, 4);
  assert.equal(bundle.positions.length, 1);
  assert.equal(bundle.positions[0]!.hash, "h0");
});

test("空的电脑导入手机的导出：再导出时两边一致", async () => {
  const bundle = await phoneExport();
  area = fakeArea(); // 换一台机器
  const res = await store.importBundle(bundle);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.match(res.message, /文章新增 1/);
  assert.match(res.message, /划词新增 1/);

  const again = await store.exportAll();
  const strip = (b: ExportBundle) => {
    const { exportedAt: _e, settings: _s, llm: _l, ...rest } = b;
    return rest;
  };
  assert.deepEqual(strip(again), strip(bundle));
  // 速度摘要也随导入重算了
  const speed = await store.getSpeedSummary();
  assert.equal(speed?.words, 250);
});

test("同一份文件导两次，第二次什么都没变", async () => {
  const bundle = await phoneExport();
  area = fakeArea();
  await store.importBundle(bundle);
  const before = await area.get(null);
  const res = await store.importBundle(bundle);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.message, "没有新内容，本机已经有这些记录了");
  const after = await area.get(null);
  delete before["speed"];
  delete after["speed"]; // updatedTs 是当下时刻
  assert.deepEqual(after, before);
});

test("电脑上已有同一个词的卡：合并成一张，手机上的划词挂过来", async () => {
  const bundle = await phoneExport();
  area = fakeArea();
  await vocab.addSnippet({
    articleId: "https://example.com/b",
    url: "https://example.com/b",
    articleTitle: "另一篇",
    text: "leak",
    kind: "word",
    context: "A leak.",
    result: tr(),
    now: 1_000,
  });
  const res = await store.importBundle(bundle);
  assert.equal(res.ok, true);
  const cards = await vocab.getCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.snippetIds.length, 2);
  const snippets = await vocab.getSnippets();
  assert.ok(snippets.every((s) => s.cardId === cards[0]!.id));
});

test("导入不碰设置与 LLM 配置", async () => {
  const bundle = await phoneExport();
  area = fakeArea();
  await store.setSettings({ idleTimeoutMs: 45_000 });
  await vocab.setLlmConfig({ apiKey: "sk-local" });
  await store.importBundle({ ...bundle, settings: { ...bundle.settings, idleTimeoutMs: 99_000 } });
  assert.equal((await store.getSettings()).idleTimeoutMs, 45_000);
  assert.equal((await vocab.getLlmConfig()).apiKey, "sk-local");
});

test("不是导出文件就拒收，且不写任何东西", async () => {
  const res = await store.importBundle({ schema: 9 });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /schema 9/);
  assert.equal(area.data.size, 0);
  assert.equal((await store.importBundle("junk")).ok, false);
});
