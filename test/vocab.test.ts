import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Session, TranslationResult } from "../src/types.ts";

/** 与 store.test.ts 同款内存 storage：深拷贝，暴露"改了没写回"这类错误。 */
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
// globalThis.crypto 只有 getter，整体替换会抛错；只改 randomUUID 这一个方法，
// 让 id 可预测，断言里才好比对。
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

const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
const ARTICLE = "https://example.com/a";

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

const add = (over: Partial<Parameters<typeof vocab.addSnippet>[0]> = {}) =>
  vocab.addSnippet({
    articleId: ARTICLE,
    url: ARTICLE,
    articleTitle: "测试文章",
    text: "leaks",
    kind: "word",
    context: "Every abstraction leaks.",
    result: tr(),
    now: NOW,
    ...over,
  });

/* ==================== 入队规则 ==================== */

test("单词自动进复习队列", async () => {
  const { snippet, card } = await add();
  assert.notEqual(card, null);
  assert.equal(snippet.cardId, card!.id);
  assert.equal(card!.key, "leak", "卡面用词元");
});

test("短语同样自动入队", async () => {
  const { card } = await add({ text: "give up on", kind: "phrase", result: tr({ lemma: "give up on" }) });
  assert.notEqual(card, null);
});

test("整句只记录，不排期", async () => {
  const { snippet, card } = await add({
    text: "The question is not whether it leaks",
    kind: "sentence",
    result: tr({ lemma: null, pos: null, phonetic: null }),
  });
  assert.equal(card, null);
  assert.equal(snippet.cardId, null);
  assert.equal((await vocab.getCards()).length, 0);
});

test("整句可以手动加入复习队列", async () => {
  const { snippet } = await add({ text: "a long sentence here", kind: "sentence", result: tr({ lemma: null }) });
  const card = await vocab.enqueueSnippet(snippet.id, NOW);
  assert.notEqual(card, null);
  const after = (await vocab.getSnippets()).find((s) => s.id === snippet.id)!;
  assert.equal(after.cardId, card!.id);
});

test("重复手动入队不会产生第二张卡", async () => {
  const { snippet } = await add({ text: "a long sentence here", kind: "sentence", result: tr({ lemma: null }) });
  await vocab.enqueueSnippet(snippet.id, NOW);
  const second = await vocab.enqueueSnippet(snippet.id, NOW);
  assert.equal(second, null, "已经在队列里就不该重复入队");
  assert.equal((await vocab.getCards()).length, 1);
});

/* ==================== 同词元合并 ==================== */

test("同一个词元跨文章合并成一张卡，保留多条出处", async () => {
  await add({ text: "leaks", result: tr({ lemma: "leak" }) });
  await add({
    articleId: "https://other.com/b",
    url: "https://other.com/b",
    articleTitle: "另一篇",
    text: "leaked",
    result: tr({ lemma: "leak" }),
  });

  const cards = await vocab.getCards();
  assert.equal(cards.length, 1, "leak / leaks / leaked 应当只有一张卡");
  assert.equal(cards[0]!.snippetIds.length, 2);

  const views = vocab.attachSnippets(cards, await vocab.getSnippets());
  assert.equal(views[0]!.articleCount, 2, "应当记得它在两篇文章里出现过");
});

test("不同词元不会被合并", async () => {
  await add({ text: "leaks", result: tr({ lemma: "leak" }) });
  await add({ text: "abstraction", result: tr({ lemma: "abstraction", translation: "抽象" }) });
  assert.equal((await vocab.getCards()).length, 2);
});

test("没有词元时按原文大小写不敏感合并", async () => {
  await add({ text: "Leaks", result: tr({ lemma: null }) });
  await add({ text: "leaks", result: tr({ lemma: null }) });
  assert.equal((await vocab.getCards()).length, 1);
});

test("attachSnippets 取最近一次划到的语境", async () => {
  await add({ text: "leaks", context: "旧语境", result: tr({ lemma: "leak" }) });
  await add({ text: "leaks", context: "新语境", result: tr({ lemma: "leak" }), now: NOW + 60_000 });
  const views = vocab.attachSnippets(await vocab.getCards(), await vocab.getSnippets());
  assert.equal(views[0]!.snippet!.context, "新语境");
});

/* ==================== 删除 ==================== */

test("删掉最后一条出处时卡片一并删除", async () => {
  const { snippet } = await add();
  await vocab.deleteSnippet(snippet.id);
  assert.equal((await vocab.getSnippets()).length, 0);
  assert.equal((await vocab.getCards()).length, 0, "没有语境的孤卡没有复习价值");
});

test("还有其他出处时保留卡片，只摘掉这一条", async () => {
  const a = await add({ text: "leaks", result: tr({ lemma: "leak" }) });
  const b = await add({ text: "leaked", result: tr({ lemma: "leak" }) });
  await vocab.deleteSnippet(a.snippet.id);
  const cards = await vocab.getCards();
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0]!.snippetIds, [b.snippet.id]);
});

/* ==================== 评分落库 ==================== */

test("评分会写回存储", async () => {
  const { card } = await add();
  const before = card!.due;
  const next = await vocab.gradeStoredCard(card!.id, 3, NOW);
  assert.notEqual(next, null);
  assert.ok(next!.due > before);
  const stored = (await vocab.getCards())[0]!;
  assert.equal(stored.due, next!.due, "内存里的结果必须落盘");
  assert.equal(stored.reps, 1);
});

test("给不存在的卡评分返回 null 而不是抛错", async () => {
  assert.equal(await vocab.gradeStoredCard("nope", 3, NOW), null);
});

/* ==================== LLM 配置与用量 ==================== */

test("LLM 配置与 Settings 分开存放", async () => {
  await vocab.setLlmConfig({ apiKey: "secret" });
  const settings = await store.getSettings();
  assert.equal(JSON.stringify(settings).includes("secret"), false, "密钥绝不能出现在 content script 会读的 settings 里");
  assert.equal((await vocab.getLlmConfig()).apiKey, "secret");
});

test("LLM 配置合并默认值", async () => {
  await vocab.setLlmConfig({ apiKey: "k" });
  const cfg = await vocab.getLlmConfig();
  assert.equal(cfg.baseUrl, "https://api.minimaxi.com/anthropic");
  assert.equal(cfg.model, "MiniMax-M3-highspeed");
});

test("停在旧默认值上的输出上限与超时被抬上来", async () => {
  await area.set({ llm: { apiKey: "k", maxTokens: 1024, timeoutMs: 30_000 } });
  const cfg = await vocab.getLlmConfig();
  assert.equal(cfg.maxTokens, 4096);
  assert.equal(cfg.timeoutMs, 60_000);
  assert.equal(cfg.apiKey, "k", "抬额度不该碰密钥");
});

test("抬过一次落标记，之后手填 1024 不会再被抬走", async () => {
  await area.set({ llm: { apiKey: "k", maxTokens: 1024 } });
  await vocab.setLlmConfig({ maxTokens: 1024 });
  assert.equal((await vocab.getLlmConfig()).maxTokens, 1024);
});

test("自己调过的额度不受抬升影响", async () => {
  await area.set({ llm: { apiKey: "k", maxTokens: 2048, timeoutMs: 45_000 } });
  const cfg = await vocab.getLlmConfig();
  assert.equal(cfg.maxTokens, 2048);
  assert.equal(cfg.timeoutMs, 45_000);
});

test("用量累加，失败单独计数", async () => {
  await vocab.addUsage(10, 20);
  await vocab.addUsage(5, 0, true);
  const u = await vocab.getUsage();
  assert.equal(u.requests, 2);
  assert.equal(u.inputTokens, 15);
  assert.equal(u.outputTokens, 20);
  assert.equal(u.errors, 1);
});

/* ==================== 读完判定 ==================== */

const seed = (trackedWords = 1000) =>
  store.upsertArticleMeta({
    articleId: ARTICLE,
    url: ARTICLE,
    title: "测试文章",
    totalWords: trackedWords + 100,
    trackedWords,
    paragraphCount: 3,
    now: 1_000,
  });

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  articleId: ARTICLE,
  url: ARTICLE,
  title: "测试文章",
  startTs: 10_000,
  endTs: 70_000,
  wordsRead: 0,
  endReason: "idle",
  ...over,
});

/** 造一批段落快照，让已读字数达到指定值。 */
const paras = (readWords: number) => [
  { index: 0, hash: "h1", words: readWords, firstSeenTs: 20_000, dwellMs: 5_000 },
];

test("比例达标但没触底，不算读完", async () => {
  await seed(1000);
  await store.commitSession(session(), paras(900), false);
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.wordsRead, 900);
  assert.equal(a.reachedBottom, false);
  assert.equal(a.finished, false, "一路读到 90% 但没到末尾，不该算读完");
});

test("触底但比例不够，也不算读完", async () => {
  await seed(1000);
  await store.commitSession(session(), paras(200), true);
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.reachedBottom, true);
  assert.equal(a.finished, false, "一路滚到底的跳读不该算读完");
});

test("比例达标且触底才算读完", async () => {
  await seed(1000);
  await store.commitSession(session(), paras(850), true);
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.finished, true);
  assert.equal(a.finishedTs, 70_000);
});

test("触底状态跨 session 累积", async () => {
  await seed(1000);
  // 第一次先滚到底看了眼结尾，只读了一点
  await store.commitSession(session({ startTs: 0, endTs: 10_000 }), paras(100), true);
  assert.equal((await store.getArticles())[ARTICLE]!.finished, false);
  // 第二次回来认真读完，本次没有再滚到底，但触底是记着的
  await store.commitSession(session({ id: "s2", startTs: 20_000, endTs: 90_000 }), paras(900), false);
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.reachedBottom, true);
  assert.equal(a.finished, true);
});

test("读完状态是 sticky 的，之后调高阈值也不会变回未读完", async () => {
  await seed(1000);
  await store.commitSession(session(), paras(850), true);
  await store.setSettings({ finishRatio: 0.99 });
  await store.commitSession(session({ id: "s2", startTs: 80_000, endTs: 90_000 }), paras(0), false);
  assert.equal((await store.getArticles())[ARTICLE]!.finished, true);
});

test("阈值可调：调低后较少的阅读量也算读完", async () => {
  await seed(1000);
  await store.setSettings({ finishRatio: 0.3 });
  await store.commitSession(session(), paras(350), true);
  assert.equal((await store.getArticles())[ARTICLE]!.finished, true);
});

test("手动标记读完覆盖自动判定", async () => {
  await seed(1000);
  await store.commitSession(session(), paras(10), false);
  const a = await store.setFinished(ARTICLE, true);
  assert.equal(a!.finished, true);
  assert.notEqual(a!.finishedTs, null);
});

test("手动取消读完后不会被下一个 session 立刻自动置回", async () => {
  await seed(1000);
  await store.commitSession(session(), paras(850), true);
  await store.setFinished(ARTICLE, false);
  await store.commitSession(session({ id: "s2", startTs: 80_000, endTs: 90_000 }), paras(0), false);
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.finished, false, "取消后该保持取消，除非再次读到末尾");
});

test("对不存在的文章标记读完返回 null", async () => {
  assert.equal(await store.setFinished("https://nope.com/", true), null);
});

/* ==================== 导出 ==================== */

test("导出包含划词与卡片，且不含 API key", async () => {
  await seed(1000);
  await vocab.setLlmConfig({ apiKey: "super-secret" });
  await add();
  const bundle = await store.exportAll();
  assert.equal(bundle.schema, 4);
  assert.equal(bundle.snippets.length, 1);
  assert.equal(bundle.cards.length, 1);
  assert.equal(bundle.llm.apiKeySet, true);
  assert.equal(JSON.stringify(bundle).includes("super-secret"), false, "导出文件常被随手分享");
});

test("清空数据保留设置与 LLM 配置", async () => {
  await seed(1000);
  await add();
  await vocab.setLlmConfig({ apiKey: "keep-me" });
  await store.setSettings({ finishRatio: 0.5 });
  await store.clearData();
  assert.equal((await vocab.getSnippets()).length, 0);
  assert.equal((await vocab.getCards()).length, 0);
  assert.equal(Object.keys(await store.getArticles()).length, 0);
  assert.equal((await vocab.getLlmConfig()).apiKey, "keep-me", "重填密钥很烦，不该被清掉");
  assert.equal((await store.getSettings()).finishRatio, 0.5);
});

/* ==================== 生词讲解的落盘 ==================== */

const NOTE = { word: "abstraction", phonetic: "/ˌæbˈstrækʃn/", pos: "noun", meaning: "抽象层", note: null };

test("讲解随划词一起落盘", async () => {
  const { snippet } = await add({
    text: "Every abstraction leaks",
    kind: "sentence",
    result: tr({ lemma: null, pos: null, phonetic: null, vocab: [NOTE] }),
  });
  assert.deepEqual(snippet.vocab, [NOTE]);
  const stored = await vocab.getSnippets();
  assert.deepEqual(stored[0]!.vocab, [NOTE]);
});

test("单词的用法提示也存下来", async () => {
  const { snippet } = await add({ result: tr({ usage: "常和 abstraction 连用" }) });
  assert.equal(snippet.usage, "常和 abstraction 连用");
  assert.equal((await vocab.getSnippets())[0]!.usage, "常和 abstraction 连用");
});

test("老记录没有讲解字段，读出来补成 null / 空数组", async () => {
  // 「英语老师模式」之前存的那些记录：界面上到处 `?? []` 不如在入口补一次
  await area.set({
    snippets: [
      {
        id: "old",
        articleId: ARTICLE,
        url: ARTICLE,
        articleTitle: "旧文章",
        text: "leaks",
        kind: "word",
        context: "…",
        createdTs: 1,
        translation: "泄漏",
        contextNote: "",
        pos: null,
        phonetic: null,
        lemma: "leak",
        cardId: null,
      },
    ],
  });
  const [s] = await vocab.getSnippets();
  assert.equal(s!.usage, null);
  assert.deepEqual(s!.vocab, []);
});
