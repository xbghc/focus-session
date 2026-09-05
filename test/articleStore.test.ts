import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ArticleCard, Session } from "../src/types.ts";

/** 内存版 chrome.storage，与 store.test.ts 同一套。深拷贝是刻意的。 */
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

const store = await import("../src/background/store.ts");
const ar = await import("../src/background/articleReview.ts");

beforeEach(() => {
  area = fakeArea();
});

const ID = "https://example.com/a";

async function seedArticle(trackedWords = 1_000): Promise<void> {
  await store.upsertArticleMeta({
    articleId: ID,
    url: ID,
    title: "测试文章",
    totalWords: trackedWords,
    trackedWords,
    paragraphCount: 3,
    now: 1_000,
  });
}

/** 造一个把整篇读完的 session，附带触底。 */
function fullSession(wordsRead: number, endTs = 100_000): Session {
  return {
    id: "s1",
    articleId: ID,
    url: ID,
    title: "测试文章",
    startTs: endTs - 60_000,
    endTs,
    wordsRead,
    endReason: "idle",
  };
}

const paras = (words: number[]): Array<{ index: number; hash: string; words: number; firstSeenTs: number; dwellMs: number }> =>
  words.map((w, i) => ({ index: i, hash: `h${i}`, words: w, firstSeenTs: 1_000 + i, dwellMs: 2_000 }));

const cards = (): Promise<ArticleCard[]> => ar.getArticleCards();

/* ---------- 正文 ---------- */

test("正文存一次就不再覆盖——重读同一篇不该写第二遍", async () => {
  assert.equal(await ar.saveArticleText(ID, "第一版", 3), true);
  assert.equal(await ar.saveArticleText(ID, "第二版", 3), false);
  assert.equal((await ar.getArticleText(ID))?.text, "第一版");
});

test("超长正文入库时就截断，并记下原始长度", async () => {
  const long = "x".repeat(50_000);
  await ar.saveArticleText(ID, long, long.length);
  const got = (await ar.getArticleText(ID))!;
  assert.equal(got.text.length, 30_000);
  assert.equal(got.fullChars, 50_000, "原始长度要留着，生成时才知道这是前百分之几");
});

/* ---------- 卡片随读完状态起落 ---------- */

test("读完那一刻自动建一张回顾卡", async () => {
  await seedArticle(1_000);
  assert.deepEqual(await cards(), []);
  await store.commitSession(fullSession(900), paras([500, 400]), true);

  const list = await cards();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.articleId, ID);
  assert.equal(list[0]!.state, 0, "新卡应当是 New 状态");
  assert.equal(list[0]!.reps, 0);
});

test("没触底就不算读完，也就不建卡", async () => {
  await seedArticle(1_000);
  await store.commitSession(fullSession(900), paras([500, 400]), false);
  assert.deepEqual(await cards(), []);
});

test("已读比例不够同样不建卡", async () => {
  await seedArticle(1_000);
  await store.commitSession(fullSession(300), paras([200, 100]), true);
  assert.deepEqual(await cards(), []);
});

test("重读一篇读完的文章不会把调度重置", async () => {
  await seedArticle(1_000);
  await store.commitSession(fullSession(900), paras([500, 400]), true);
  const before = (await cards())[0]!;

  // 假装已经复习过一次，再补一个 session 进来
  await ar.gradeArticleCard(ID, 3, 200_000);
  const graded = (await cards())[0]!;
  assert.ok(graded.due > before.due, "评分应当把卡推到未来");

  await store.commitSession({ ...fullSession(900, 300_000), id: "s2" }, paras([500, 400]), true);
  assert.deepEqual((await cards())[0], graded, "第二次读完不该动已有的卡");
});

test("手动标记读完会建卡，手动取消会把卡撤掉", async () => {
  await seedArticle(1_000);
  await store.setFinished(ID, true);
  assert.equal((await cards()).length, 1);

  await store.setFinished(ID, false);
  assert.deepEqual(await cards(), [], "取消读完后不该还赖在回顾队列里");
});

/* ---------- 评分 ---------- */

test("评分推进 FSRS 状态", async () => {
  await seedArticle(1_000);
  await store.setFinished(ID, true);
  const next = await ar.gradeArticleCard(ID, 4, 500_000);
  assert.ok(next);
  assert.equal(next.reps, 1);
  assert.ok(next.due > 500_000);
  assert.equal(next.articleId, ID, "评分不能把身份字段丢了");
});

test("给不存在的卡评分返回 null，不抛错", async () => {
  assert.equal(await ar.gradeArticleCard("没有这篇", 3, 0), null);
});

/* ---------- 到期队列 ---------- */

test("到期队列带上文章信息和已生成的材料", async () => {
  await seedArticle(1_000);
  await store.setFinished(ID, true);
  await area.set({
    [ar.reviewKey(ID)]: { articleId: ID, outline: ["一"], questions: ["问"], generatedTs: 1, model: "m" },
  });

  const due = await ar.articleReviewViews(Date.now());
  assert.equal(due.length, 1);
  assert.equal(due[0]!.article.title, "测试文章");
  assert.deepEqual(due[0]!.review?.outline, ["一"]);
});

test("还没生成材料的文章照样进队列，界面上再补生成", async () => {
  await seedArticle(1_000);
  await store.setFinished(ID, true);
  const due = await ar.articleReviewViews(Date.now());
  assert.equal(due.length, 1);
  assert.equal(due[0]!.review, null);
});

test("文章记录被淘汰后，孤儿卡不会渲染出来", async () => {
  await seedArticle(1_000);
  await store.setFinished(ID, true);
  await area.set({ articles: {} }); // 模拟 prune 掉了文章
  assert.deepEqual(await ar.articleReviewViews(Date.now()), []);
});

test("没到期的卡不在队列里", async () => {
  await seedArticle(1_000);
  await store.setFinished(ID, true);
  await ar.gradeArticleCard(ID, 4, Date.now());
  assert.deepEqual(await ar.articleReviewViews(Date.now()), []);
});

/* ---------- 与串行队列的关系 ---------- */

test("读完建卡跑在 commitSession 的串行队列内，不会把队列锁死", async () => {
  await seedArticle(1_000);
  // 真死锁的话这里会超时而不是失败——并发发几个写入，确认队列还转得动
  await Promise.all([
    store.commitSession(fullSession(900), paras([500, 400]), true),
    store.setSettings({ finishRatio: 0.8 }),
    store.upsertArticleMeta({
      articleId: ID,
      url: ID,
      title: "测试文章",
      totalWords: 1_000,
      trackedWords: 1_000,
      paragraphCount: 3,
      now: 2_000,
    }),
  ]);
  assert.equal((await cards()).length, 1);
  assert.equal((await store.getSettings()).finishRatio, 0.8);
});

/* ---------- 导出与清理 ---------- */

test("导出带上回顾材料和卡片，但不含正文——正文可再抓，没必要撑大备份", async () => {
  await seedArticle(1_000);
  await store.setFinished(ID, true);
  await ar.saveArticleText(ID, "正文正文", 4);
  await area.set({
    [ar.reviewKey(ID)]: { articleId: ID, outline: ["一"], questions: [], generatedTs: 1, model: "m" },
  });

  const bundle = await store.exportAll();
  assert.equal(bundle.schema, 4);
  assert.equal(bundle.articleCards.length, 1);
  assert.equal(bundle.articleReviews.length, 1);
  assert.ok(!JSON.stringify(bundle).includes("正文正文"), "正文不该出现在导出里");
});

test("清空数据把正文、材料、卡片一并带走", async () => {
  await seedArticle(1_000);
  await store.setFinished(ID, true);
  await ar.saveArticleText(ID, "正文", 2);
  await store.clearData();
  assert.equal(await ar.getArticleText(ID), null);
  assert.deepEqual(await cards(), []);
});

test("指定 articleId 时不看到期时间——从文章列表点「回顾」是随时想看就看", async () => {
  await seedArticle(1_000);
  await store.setFinished(ID, true);
  await ar.gradeArticleCard(ID, 4, Date.now()); // 推到几天后，队列里就没有了

  assert.deepEqual(await ar.articleReviewViews(Date.now()), []);
  const one = await ar.articleReviewViews(Date.now(), { articleId: ID });
  assert.equal(one.length, 1);
  assert.equal(one[0]!.article.id, ID);
});

test("指定一篇没有卡的文章时返回空，不造假卡", async () => {
  await seedArticle(1_000);
  assert.deepEqual(await ar.articleReviewViews(Date.now(), { articleId: ID }), []);
});

/* ---------- 上线前就读完的老文章 ---------- */

test("已读完、正文也在，却没有卡的老文章会被补上", async () => {
  await seedArticle(1_000);
  // 模拟功能上线前的状态：finished 早就是 true，但没有卡
  await store.setFinished(ID, true);
  await area.set({ articleCards: [] });
  await ar.saveArticleText(ID, "正文", 2);

  assert.deepEqual(await cards(), []);
  await ar.ensureArticleCard(ID, 1_000);
  assert.equal((await cards()).length, 1, "finished 的翻转已经发生过，只能靠这一层补");
});

test("补卡是幂等的，不会每次点开都加一张", async () => {
  await seedArticle(1_000);
  await store.setFinished(ID, true);
  await ar.saveArticleText(ID, "正文", 2);
  await ar.ensureArticleCard(ID, 1_000);
  await ar.ensureArticleCard(ID, 2_000);
  assert.equal((await cards()).length, 1);
});

test("没有正文就不补卡——否则队列里全是看不了的东西", async () => {
  await seedArticle(1_000);
  await store.setFinished(ID, true);
  await area.set({ articleCards: [] });
  await ar.ensureArticleCard(ID, 1_000);
  assert.deepEqual(await cards(), []);
});

test("没读完的文章不补卡", async () => {
  await seedArticle(1_000);
  await ar.saveArticleText(ID, "正文", 2);
  await ar.ensureArticleCard(ID, 1_000);
  assert.deepEqual(await cards(), []);
});

test("状态查询顺手补卡，并如实报告读完与否", async () => {
  await seedArticle(1_000);
  await store.setFinished(ID, true);
  await area.set({ articleCards: [] });
  await ar.saveArticleText(ID, "正文", 2);

  const st = await ar.articleReviewState(ID);
  assert.equal(st.finished, true);
  assert.equal(st.hasText, true);
  assert.equal(st.hasReview, false);
  assert.equal(st.carded, true, "查一次状态就该把老文章补进队列");
});

test("从没读过的文章，状态全是 false", async () => {
  const st = await ar.articleReviewState("https://example.com/never");
  assert.deepEqual(st, { finished: false, hasText: false, hasReview: false, carded: false });
});
