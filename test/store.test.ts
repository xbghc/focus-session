import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/types.ts";

/** 内存版 chrome.storage。刻意做深拷贝——真实实现会序列化，
 *  引用共享会掩盖"读出来改了但没写回去"这类错误。 */
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

beforeEach(() => {
  area = fakeArea();
});

const ARTICLE = "https://example.com/a";

async function seedArticle(overrides: Partial<{ totalWords: number; trackedWords: number }> = {}) {
  await store.upsertArticleMeta({
    articleId: ARTICLE,
    url: ARTICLE,
    title: "测试文章",
    totalWords: overrides.totalWords ?? 1000,
    trackedWords: overrides.trackedWords ?? 900,
    paragraphCount: 3,
    now: 1_000,
  });
}

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  articleId: ARTICLE,
  url: ARTICLE,
  title: "测试文章",
  startTs: 10_000,
  endTs: 70_000,
  wordsRead: 300,
  endReason: "idle",
  ...over,
});

test("settings 读写与默认值合并", async () => {
  const d = await store.getSettings();
  assert.equal(d.idleTimeoutMs, 30_000);
  await store.setSettings({ idleTimeoutMs: 45_000 });
  const s = await store.getSettings();
  assert.equal(s.idleTimeoutMs, 45_000);
  assert.equal(s.stallTimeoutMs, 90_000, "未指定的字段应保留默认值");
});

test("旧的字符阈值迁移成词数阈值", async () => {
  await area.set({ settings: { maxAutoSelectionChars: 550 } });
  const s = await store.getSettings();
  assert.equal(s.maxAutoSelectionWords, 100, "550 字符 ÷ 5.5 ≈ 100 词");
});

test("已有词数阈值时不被旧的字符阈值覆盖", async () => {
  await area.set({ settings: { maxAutoSelectionChars: 550, maxAutoSelectionWords: 12 } });
  const s = await store.getSettings();
  assert.equal(s.maxAutoSelectionWords, 12);
});

test("两个阈值都没有时取默认值", async () => {
  assert.equal((await store.getSettings()).maxAutoSelectionWords, 200);
});

test("停在旧默认值 40 词的自动翻译上限被抬到新默认值", async () => {
  await area.set({ settings: { maxAutoSelectionWords: 40 } });
  assert.equal((await store.getSettings()).maxAutoSelectionWords, 200);
});

test("抬过一次就落标记，之后手填 40 词不会再被抬走", async () => {
  await area.set({ settings: { maxAutoSelectionWords: 40 } });
  // 走一遍设置页的保存路径：迁移标记就是靠这次写回落盘的
  await store.setSettings({ maxAutoSelectionWords: 40 });
  assert.equal((await store.getSettings()).maxAutoSelectionWords, 40);
});

test("从没动过设置的人也落标记，以后填 40 词同样填得进去", async () => {
  await store.setSettings({ idleTimeoutMs: 45_000 });
  await store.setSettings({ maxAutoSelectionWords: 40 });
  assert.equal((await store.getSettings()).maxAutoSelectionWords, 40);
});

test("迁移会落盘，不必等用户去设置页按保存", async () => {
  await area.set({ settings: { maxAutoSelectionWords: 40 } });
  await store.persistMigrations();
  // content script 读的是原始 storage，不经过 getSettings 的合并
  const raw = (await area.get("settings"))["settings"] as { maxAutoSelectionWords: number };
  assert.equal(raw.maxAutoSelectionWords, 200);
});

test("迁移落过盘之后就不再写，避免每次唤醒都碰一次 storage", async () => {
  await area.set({ settings: { maxAutoSelectionWords: 40 } });
  await store.persistMigrations();

  const real = area.set;
  let writes = 0;
  area.set = async (items: Record<string, unknown>) => {
    writes += 1;
    await real(items);
  };
  await store.persistMigrations();
  assert.equal(writes, 0, "service worker 每次醒来都会调一次，落过盘就该只剩一次读");
});

test("自己调过的上限不受抬升影响", async () => {
  await area.set({ settings: { maxAutoSelectionWords: 12 } });
  assert.equal((await store.getSettings()).maxAutoSelectionWords, 12);
});

test("旧的字符阈值换算夹在设置页的上限内", async () => {
  await area.set({ settings: { maxAutoSelectionChars: 99_999 } });
  assert.equal((await store.getSettings()).maxAutoSelectionWords, 360);
});

test("markFinished 置位读完并建回顾卡", async () => {
  await seedArticle();
  assert.equal(await store.markFinished(ARTICLE, 5_000), true);
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.finished, true);
  assert.equal(a.finishedTs, 5_000);
  const cards = (area.data.get("articleCards") ?? []) as { articleId: string }[];
  assert.deepEqual(
    cards.map((c) => c.articleId),
    [ARTICLE],
  );
});

test("markFinished 是幂等的：重复到达不改完成时刻、不重复建卡", async () => {
  await seedArticle();
  await store.markFinished(ARTICLE, 5_000);
  // 心跳每 5s 判一次，重复到达是常态。返回的是"现在算不算读完"，所以仍是 true
  assert.equal(await store.markFinished(ARTICLE, 9_000), true);
  assert.equal((await store.getArticles())[ARTICLE]!.finishedTs, 5_000);
  assert.equal(((area.data.get("articleCards") ?? []) as unknown[]).length, 1);
});

test("markFinished 对没登记过的文章报 false——角标弹出来会是死路", async () => {
  assert.equal(await store.markFinished("https://example.com/nope", 1), false);
  assert.equal(area.data.get("articleCards"), undefined);
});

test("重复注册文章元信息不会清掉已有阅读进度", async () => {
  await seedArticle();
  await store.commitSession(session(), []);
  await seedArticle({ totalWords: 1100 });
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.totalWords, 1100, "字数应更新");
  assert.equal(a.sessionCount, 1, "session 计数不能被重置");
  assert.equal(a.totalMs, 60_000);
  assert.equal(a.firstSeenTs, 1_000, "首次见到的时间应保留");
});

test("commitSession 聚合时长、最长片段与 session 数", async () => {
  await seedArticle();
  await store.commitSession(session({ startTs: 0, endTs: 60_000 }), []);
  await store.commitSession(session({ id: "s2", startTs: 100_000, endTs: 280_000 }), []);
  await store.commitSession(session({ id: "s3", startTs: 300_000, endTs: 320_000 }), []);
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.sessionCount, 3);
  assert.equal(a.totalMs, 60_000 + 180_000 + 20_000);
  assert.equal(a.maxSessionMs, 180_000);
  assert.equal((await store.getSessions()).length, 3);
});

test("段落按 hash 归并：dwell 累加，firstSeenTs 取最早", async () => {
  await seedArticle();
  await store.commitSession(session(), [
    { index: 0, hash: "aa", words: 100, firstSeenTs: 5_000, dwellMs: 2_000 },
  ]);
  await store.commitSession(session({ id: "s2" }), [
    { index: 0, hash: "aa", words: 100, firstSeenTs: 3_000, dwellMs: 1_500 },
  ]);
  const recs = await store.getParagraphs(ARTICLE);
  assert.equal(recs.length, 1, "同一段落不应产生两条记录");
  assert.equal(recs[0]!.dwellMs, 3_500, "停留时长应累加");
  assert.equal(recs[0]!.firstSeenTs, 3_000, "首次读到的时间应取更早的那个");
});

test("同一段落被两个 session 读到，字数不重复计入文章总计", async () => {
  await seedArticle();
  const paras = [
    { index: 0, hash: "aa", words: 100, firstSeenTs: 5_000, dwellMs: 2_000 },
    { index: 1, hash: "bb", words: 200, firstSeenTs: 6_000, dwellMs: 2_000 },
  ];
  await store.commitSession(session(), paras);
  await store.commitSession(session({ id: "s2" }), paras);
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.wordsRead, 300, "两次上报同样的段落，只应计一次 300 字");
  assert.equal(a.readParagraphCount, 2);
});

test("只有真正读过的段落计入已读（firstSeenTs 为 0 表示只是扫过）", async () => {
  await seedArticle();
  await store.commitSession(session(), [
    { index: 0, hash: "aa", words: 100, firstSeenTs: 5_000, dwellMs: 2_000 },
    { index: 1, hash: "bb", words: 200, firstSeenTs: 0, dwellMs: 300 },
  ]);
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.readParagraphCount, 1);
  assert.equal(a.wordsRead, 100);
});

test("并发写入不丢数据（串行化队列）", async () => {
  await seedArticle();
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      store.commitSession(session({ id: `c${i}`, startTs: i * 1000, endTs: i * 1000 + 5_000 }), [
        { index: i, hash: `h${i}`, words: 10, firstSeenTs: 1_000 + i, dwellMs: 1_000 },
      ]),
    ),
  );
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal((await store.getSessions()).length, 12, "12 个并发提交都应落库");
  assert.equal(a.sessionCount, 12);
  assert.equal((await store.getParagraphs(ARTICLE)).length, 12);
  assert.equal(a.wordsRead, 120);
});

test("session 列表按开始时间排序", async () => {
  await seedArticle();
  await store.commitSession(session({ id: "late", startTs: 500_000, endTs: 560_000 }), []);
  await store.commitSession(session({ id: "early", startTs: 1_000, endTs: 61_000 }), []);
  const ids = (await store.getSessions()).map((s) => s.id);
  assert.deepEqual(ids, ["early", "late"]);
});

test("未注册元信息的文章提交 session 不会崩溃", async () => {
  await store.commitSession(session({ articleId: "https://unknown.test/x" }), []);
  assert.equal((await store.getSessions()).length, 1);
});

test("导出包含全部数据且结构完整", async () => {
  await seedArticle();
  await store.commitSession(session(), [
    { index: 0, hash: "aa", words: 100, firstSeenTs: 5_000, dwellMs: 2_000 },
  ]);
  const bundle = await store.exportAll();
  assert.equal(bundle.schema, 4);
  assert.equal(bundle.articles.length, 1);
  assert.equal(bundle.sessions.length, 1);
  assert.deepEqual(Object.keys(bundle.paragraphs), [ARTICLE]);
  assert.equal(bundle.paragraphs[ARTICLE]!.length, 1);
  assert.ok(bundle.settings.idleTimeoutMs > 0);
});

test("清空数据保留设置", async () => {
  await store.setSettings({ idleTimeoutMs: 45_000, excludedDomains: ["x.com"] });
  await seedArticle();
  await store.commitSession(session(), [
    { index: 0, hash: "aa", words: 100, firstSeenTs: 5_000, dwellMs: 2_000 },
  ]);
  await store.clearData();
  assert.deepEqual(await store.getArticles(), {});
  assert.deepEqual(await store.getSessions(), []);
  assert.deepEqual(await store.getParagraphs(ARTICLE), []);
  const s = await store.getSettings();
  assert.equal(s.idleTimeoutMs, 45_000, "设置不应被清掉");
  assert.deepEqual(s.excludedDomains, ["x.com"]);
});

test("同一片段被补记后又收到真正的结束消息，不会记成两个 session", async () => {
  await seedArticle();
  // 后台按最后一次心跳补记（只到 40s）
  await store.commitSession(session({ id: "recovered", startTs: 0, endTs: 40_000, endReason: "recovered" }), []);
  // content script 随后送来真正的结束（到 300s）
  await store.commitSession(session({ id: "real", startTs: 0, endTs: 300_000, endReason: "idle" }), []);

  const sessions = await store.getSessions();
  assert.equal(sessions.length, 1, "同一 startTs 的片段只应存在一条");
  assert.equal(sessions[0]!.endTs, 300_000, "应保留更完整的那一份");
  assert.equal(sessions[0]!.endReason, "idle");

  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.sessionCount, 1);
  assert.equal(a.totalMs, 300_000, "时长不能把补记的 40s 也加进去");
  assert.equal(a.maxSessionMs, 300_000);
});

test("起点不同的片段仍然各自独立", async () => {
  await seedArticle();
  await store.commitSession(session({ id: "a", startTs: 0, endTs: 40_000 }), []);
  await store.commitSession(session({ id: "b", startTs: 50_000, endTs: 90_000 }), []);
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.sessionCount, 2);
  assert.equal(a.totalMs, 80_000);
});

test("文章聚合从 session 列表重算，历史漂移会自动修正", async () => {
  await seedArticle();
  await store.commitSession(session({ id: "s1", startTs: 0, endTs: 60_000 }), []);
  // 手工污染聚合值，模拟旧版本留下的错误数据
  const articles = await store.getArticles();
  articles[ARTICLE]!.totalMs = 999_999;
  articles[ARTICLE]!.sessionCount = 42;
  await (globalThis as any).chrome.storage.local.set({ articles });

  await store.commitSession(session({ id: "s2", startTs: 100_000, endTs: 160_000 }), []);
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.sessionCount, 2);
  assert.equal(a.totalMs, 120_000);
});

test("补记消息后到也不会覆盖掉更完整的真实记录", async () => {
  await seedArticle();
  // 真实结束先到
  await store.commitSession(session({ id: "real", startTs: 0, endTs: 300_000, endReason: "unload" }), []);
  // 后台的补记（只到最后一次心跳）随后才到
  await store.commitSession(session({ id: "recovered", startTs: 0, endTs: 40_000, endReason: "recovered" }), []);

  const sessions = await store.getSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.endTs, 300_000, "先到后到都应保留更完整的那一份");
  assert.equal(sessions[0]!.endReason, "unload");
  assert.equal((await store.getArticles())[ARTICLE]!.totalMs, 300_000);
});

/* ---------- 阅读位置 ---------- */

const position = (over: Partial<import("../src/types.ts").ReadingPosition> = {}) => ({
  articleId: ARTICLE,
  hash: "bb",
  index: 4,
  offset: 120,
  paragraphCount: 10,
  savedTs: 5_000,
  ...over,
});

test("位置记录读写", async () => {
  assert.equal(await store.getPosition(ARTICLE), null, "没读过的文章没有位置");
  await store.savePosition(position());
  assert.deepEqual(await store.getPosition(ARTICLE), position());
});

test("后写的位置覆盖先写的（最后离开的那一眼就是下次的落点）", async () => {
  await store.savePosition(position({ index: 4, hash: "bb" }));
  await store.savePosition(position({ index: 7, hash: "gg", savedTs: 9_000 }));
  const p = await store.getPosition(ARTICLE);
  assert.equal(p?.index, 7);
  assert.equal(p?.hash, "gg");
});

test("位置按文章分开存，互不干扰", async () => {
  await store.savePosition(position());
  await store.savePosition(position({ articleId: "https://example.com/b", index: 1, hash: "zz" }));
  assert.equal((await store.getPosition(ARTICLE))?.index, 4);
  assert.equal((await store.getPosition("https://example.com/b"))?.index, 1);
});

test("清空数据会连位置一起清掉", async () => {
  await store.savePosition(position());
  await store.clearData();
  assert.equal(await store.getPosition(ARTICLE), null);
});

test("文章被容量淘汰时位置记录一并删除，不留孤儿", async () => {
  // 1000 篇的上限，多塞一篇把最老的挤掉
  const old = "https://example.com/old";
  await store.upsertArticleMeta({
    articleId: old,
    url: old,
    title: "最老的一篇",
    totalWords: 100,
    trackedWords: 100,
    paragraphCount: 1,
    now: 1,
  });
  await store.savePosition(position({ articleId: old }));
  for (let i = 0; i < 1_000; i++) {
    const id = `https://example.com/n${i}`;
    await store.upsertArticleMeta({
      articleId: id,
      url: id,
      title: `新文章 ${i}`,
      totalWords: 100,
      trackedWords: 100,
      paragraphCount: 1,
      now: 1_000 + i,
    });
  }
  assert.equal((await store.getArticles())[old], undefined, "最老的一篇应被淘汰");
  assert.equal(await store.getPosition(old), null, "它的位置记录不该留在存储里");
});

/* ---------- 预计阅读时间：速度摘要与文章字段 ---------- */

test("commitSession 顺手重算个人阅读速度的摘要", async () => {
  await seedArticle();
  await store.commitSession(session({ startTs: 0, endTs: 600_000, wordsRead: 1_500 }), []);
  const speed = await store.getSpeedSummary();
  assert.ok(speed);
  assert.equal(speed.words, 1_500);
  assert.equal(speed.ms, 600_000);
  assert.equal(speed.sessions, 1);
});

test("速度摘要只统计读到新内容的片段", async () => {
  await seedArticle();
  await store.commitSession(session({ id: "r", startTs: 0, endTs: 600_000, wordsRead: 1_500 }), []);
  await store.commitSession(session({ id: "z", startTs: 700_000, endTs: 4_300_000, wordsRead: 0 }), []);
  const speed = await store.getSpeedSummary();
  assert.equal(speed?.sessions, 1, "重读一小时不该拉低速度");
  assert.equal(speed?.ms, 600_000);
});

test("文章的 readingMs 只算读到新内容的片段，totalMs 照旧全算", async () => {
  await seedArticle();
  await store.commitSession(session({ id: "r", startTs: 0, endTs: 60_000, wordsRead: 300 }), []);
  await store.commitSession(session({ id: "z", startTs: 100_000, endTs: 220_000, wordsRead: 0 }), []);
  const a = (await store.getArticles())[ARTICLE]!;
  assert.equal(a.totalMs, 180_000);
  assert.equal(a.readingMs, 60_000);
});

test("expectedMs 随元信息落盘；老调用方不带时保留上次的值", async () => {
  await store.upsertArticleMeta({
    articleId: ARTICLE,
    url: ARTICLE,
    title: "测试文章",
    totalWords: 1000,
    trackedWords: 900,
    paragraphCount: 3,
    expectedMs: 250_000,
    now: 1_000,
  });
  assert.equal((await store.getArticles())[ARTICLE]!.expectedMs, 250_000);
  await seedArticle(); // 不带 expectedMs
  assert.equal((await store.getArticles())[ARTICLE]!.expectedMs, 250_000, "不该被抹成 0");
  await store.upsertArticleMeta({
    articleId: "https://example.com/fresh",
    url: "https://example.com/fresh",
    title: "新文章",
    totalWords: 10,
    trackedWords: 10,
    paragraphCount: 1,
    now: 1_000,
  });
  assert.equal((await store.getArticles())["https://example.com/fresh"]!.expectedMs, 0, "从没记过就是 0（未知）");
});

test("ensureSpeedSummary 给存量用户补一份摘要，有了之后不再写", async () => {
  // 升级前的存量：只有 session 表，没有摘要
  await area.set({ sessions: [session({ startTs: 0, endTs: 120_000, wordsRead: 400 })] });
  assert.equal(await store.getSpeedSummary(), null);
  await store.ensureSpeedSummary();
  const speed = await store.getSpeedSummary();
  assert.equal(speed?.words, 400);
  assert.equal(speed?.ms, 120_000);

  const real = area.set;
  let writes = 0;
  area.set = async (items: Record<string, unknown>) => {
    writes += 1;
    await real(items);
  };
  await store.ensureSpeedSummary();
  assert.equal(writes, 0, "SW 每次醒来都会调一次，有摘要就该只剩一次读");
});

test("没有任何记录时 ensureSpeedSummary 不写全零的摘要", async () => {
  await store.ensureSpeedSummary();
  assert.equal(await store.getSpeedSummary(), null);
});

test("清空数据连速度摘要一起清掉", async () => {
  await seedArticle();
  await store.commitSession(session(), []);
  assert.ok(await store.getSpeedSummary());
  await store.clearData();
  assert.equal(await store.getSpeedSummary(), null);
});
