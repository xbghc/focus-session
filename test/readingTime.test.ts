import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/types.ts";
import {
  ARTICLE_PRIOR_MS,
  PERSONAL_PRIOR_MS,
  SPEED_WINDOW_DAYS,
  describeBasis,
  estimateArticle,
  estimateReading,
  formatEstimate,
  summarizeSpeed,
} from "../src/lib/readingTime.ts";
import { CJK_CPM, LATIN_WPM } from "../src/lib/reading.ts";

const DAY = 24 * 3600 * 1000;
const MIN = 60_000;
const NOW = 1_800_000_000_000;

const session = (over: Partial<Session>): Session => ({
  id: "s",
  articleId: "https://a.test/x",
  url: "https://a.test/x",
  title: "t",
  startTs: NOW - MIN,
  endTs: NOW,
  wordsRead: 100,
  endReason: "idle",
  ...over,
});

/** 以 wpm 的速度读 minutes 分钟的一个片段，结束于 endTs。 */
const reading = (wpm: number, minutes: number, endTs = NOW): Session =>
  session({ startTs: endTs - minutes * MIN, endTs, wordsRead: Math.round(wpm * minutes) });

/** 按一般速度读 n 个英文词 / n 个汉字要多久。 */
const latinMs = (n: number): number => (n / LATIN_WPM) * MIN;
const cjkMs = (n: number): number => (n / CJK_CPM) * MIN;

/* ---------- estimateReading ---------- */

test("没有任何证据时，估计就是一般速度的预计时长", () => {
  const e = estimateReading({ words: 1000, expectedMs: Math.round(latinMs(1000)) });
  assert.equal(e.ms, Math.round(latinMs(1000)));
  assert.equal(e.basis, "default");
  assert.equal(e.wordsPerMinute, LATIN_WPM);
  assert.equal(e.words, 1000);
});

test("先验跟着文种走：同样字数，中文的预计时长更短", () => {
  const zh = estimateReading({ words: 1000, expectedMs: Math.round(cjkMs(1000)) });
  const en = estimateReading({ words: 1000, expectedMs: Math.round(latinMs(1000)) });
  assert.equal(zh.ms, Math.round(cjkMs(1000)));
  assert.ok(zh.ms < en.ms);
});

test("个人证据充分时，估计向个人速度收敛，并标明依据是你的速度", () => {
  // 两小时里按 150 wpm 读——明显慢于 238 的人群均值
  const personal = { words: 150 * 120, ms: 120 * MIN, windowDays: 30 };
  const e = estimateReading({ words: 1000, expectedMs: latinMs(1000) }, { personal });
  assert.equal(e.basis, "personal");
  assert.equal(e.windowDays, 30);
  assert.ok(e.wordsPerMinute >= 150 && e.wordsPerMinute < 160, `应接近 150，实际 ${e.wordsPerMinute}`);
  assert.ok(e.ms > latinMs(1000), "比一般速度估得更久");
  assert.ok(e.ms <= (1000 / 150) * MIN, "但不会比个人速度本身还慢");
});

test("证据越多，先验的分量越小", () => {
  const target = { words: 1000, expectedMs: latinMs(1000) };
  const little = estimateReading(target, { personal: { words: 150 * 10, ms: 10 * MIN } });
  const lots = estimateReading(target, { personal: { words: 150 * 200, ms: 200 * MIN } });
  const own = (1000 / 150) * MIN;
  assert.ok(Math.abs(lots.ms - own) < Math.abs(little.ms - own), "两百分钟的证据应比十分钟更贴近个人速度");
});

test("证据量没过先验权重时，不敢说是按你的速度", () => {
  const target = { words: 1000, expectedMs: latinMs(1000) };
  const thin = estimateReading(target, { personal: { words: 200, ms: PERSONAL_PRIOR_MS - 1 } });
  const enough = estimateReading(target, { personal: { words: 200, ms: PERSONAL_PRIOR_MS } });
  assert.equal(thin.basis, "default");
  assert.equal(enough.basis, "personal");
  // 措辞保守，但估计本身仍然用上了那点证据
  assert.notEqual(thin.ms, estimateReading(target).ms);
});

test("这一篇自己的节奏压过整体速度", () => {
  const personal = { words: 150 * 120, ms: 120 * MIN };
  const target = { words: 1000, expectedMs: latinMs(1000) };
  const overall = estimateReading(target, { personal });
  // 这篇是硬骨头：十分钟只啃了 600 词
  const paper = estimateReading(target, { personal, article: { words: 600, ms: 10 * MIN } });
  assert.equal(paper.basis, "article");
  assert.ok(paper.ms > overall.ms, "本篇读得慢，剩下的就该估得更久");
  assert.ok(paper.wordsPerMinute < 100, `应明显低于整体的 ${overall.wordsPerMinute}，实际 ${paper.wordsPerMinute}`);
});

test("本篇的证据不足先验权重时，依据仍写整体速度", () => {
  const personal = { words: 150 * 120, ms: 120 * MIN };
  const e = estimateReading(
    { words: 1000, expectedMs: latinMs(1000) },
    { personal, article: { words: 100, ms: ARTICLE_PRIOR_MS - 1 } },
  );
  assert.equal(e.basis, "personal");
});

test("坏数据被夹在一般速度的 1/4 到 4 倍之间", () => {
  const target = { words: 1000, expectedMs: latinMs(1000) };
  const absurdlyFast = estimateReading(target, { personal: { words: 1_000_000, ms: MIN } });
  assert.equal(absurdlyFast.wordsPerMinute, LATIN_WPM * 4);
  const absurdlySlow = estimateReading(target, { personal: { words: 1, ms: 100 * 3600 * 1000 } });
  assert.ok(Math.abs(absurdlySlow.wordsPerMinute - LATIN_WPM / 4) <= 1);
});

test("没有字要读时估计为 0", () => {
  const e = estimateReading({ words: 0, expectedMs: 0 }, { personal: { words: 5000, ms: 30 * MIN } });
  assert.equal(e.ms, 0);
  assert.equal(e.words, 0);
});

test("字数或时长为 0 的证据不算数", () => {
  const target = { words: 1000, expectedMs: latinMs(1000) };
  const base = estimateReading(target).ms;
  assert.equal(estimateReading(target, { personal: { words: 0, ms: 10 * MIN } }).ms, base);
  assert.equal(estimateReading(target, { personal: { words: 500, ms: 0 } }).ms, base);
  assert.equal(estimateReading(target, { personal: null, article: null }).ms, base);
});

/* ---------- summarizeSpeed ---------- */

test("摘要只统计读到新内容的片段", () => {
  const s = summarizeSpeed([reading(150, 10), session({ wordsRead: 0, startTs: NOW - 60 * MIN, endTs: NOW })], NOW);
  assert.equal(s.words, 1500);
  assert.equal(s.ms, 10 * MIN);
  assert.equal(s.sessions, 1);
});

test("近 30 天的证据够用时只看近 30 天", () => {
  const s = summarizeSpeed([reading(150, 10), reading(300, 100, NOW - 40 * DAY)], NOW);
  assert.equal(s.windowDays, SPEED_WINDOW_DAYS);
  assert.equal(s.words, 1500);
  assert.equal(s.ms, 10 * MIN);
  assert.equal(s.updatedTs, NOW);
});

test("近 30 天的证据不够时退回全部历史，并注明", () => {
  const s = summarizeSpeed([reading(150, 2), reading(300, 100, NOW - 40 * DAY)], NOW);
  assert.equal(s.windowDays, 0);
  assert.equal(s.sessions, 2);
  assert.equal(s.words, 300 + 30_000);
  assert.equal(s.ms, 102 * MIN);
});

test("没有记录时摘要全零", () => {
  assert.deepEqual(summarizeSpeed([], NOW), { words: 0, ms: 0, sessions: 0, windowDays: 0, updatedTs: NOW });
});

test("结束不晚于开始的坏记录跳过", () => {
  const s = summarizeSpeed([session({ startTs: NOW, endTs: NOW, wordsRead: 999 })], NOW);
  assert.equal(s.sessions, 0);
});

/* ---------- estimateArticle ---------- */

test("按整篇的文种比例折算剩余部分的先验", () => {
  // 2000 字按一般速度 5 分钟——是中文的速率
  const e = estimateArticle({ trackedWords: 2000, wordsRead: 500, totalMs: 0, readingMs: 0, expectedMs: 5 * MIN }, null);
  assert.ok(e);
  assert.equal(e.words, 1500);
  assert.equal(e.ms, Math.round(5 * MIN * 0.75));
});

test("老记录没有 expectedMs 时按英文均速", () => {
  const e = estimateArticle({ trackedWords: 2000, wordsRead: 500, totalMs: 0 }, null);
  assert.ok(e);
  assert.equal(e.ms, Math.round(latinMs(1500)));
});

test("老记录没有 readingMs 时用总时长当本篇的证据", () => {
  // 十分钟读了 1000 词：100 wpm，比一般速度慢得多
  const e = estimateArticle({ trackedWords: 2000, wordsRead: 1000, totalMs: 10 * MIN }, null);
  assert.ok(e);
  assert.equal(e.basis, "article");
  assert.ok(e.wordsPerMinute > 100 && e.wordsPerMinute < LATIN_WPM, `实际 ${e.wordsPerMinute}`);
});

test("有 readingMs 时不再拿总时长当证据", () => {
  // 总时长一小时里只有十分钟读到了新内容，其余是重读——速度按十分钟算
  const withReading = estimateArticle(
    { trackedWords: 2000, wordsRead: 1000, totalMs: 60 * MIN, readingMs: 10 * MIN },
    null,
  );
  const legacy = estimateArticle({ trackedWords: 2000, wordsRead: 1000, totalMs: 60 * MIN }, null);
  assert.ok(withReading && legacy);
  assert.ok(withReading.ms < legacy.ms);
});

test("读过的字数不少于可观测字数时，剩余为 0", () => {
  const e = estimateArticle(
    { trackedWords: 1000, wordsRead: 1000, totalMs: 5 * MIN, readingMs: 5 * MIN, expectedMs: 3 * MIN },
    null,
  );
  assert.ok(e);
  assert.equal(e.words, 0);
  assert.equal(e.ms, 0);
});

test("没有可观测段落的记录估不了", () => {
  assert.equal(estimateArticle({ trackedWords: 0, wordsRead: 0, totalMs: 0 }, null), null);
});

/* ---------- 文案 ---------- */

test("formatEstimate：20 分钟内按分钟，往上按 5 分钟取整，过一小时报小时", () => {
  assert.equal(formatEstimate(0), "不到 1 分钟");
  assert.equal(formatEstimate(29_999), "不到 1 分钟");
  assert.equal(formatEstimate(30_000), "约 1 分钟");
  assert.equal(formatEstimate(12.4 * MIN), "约 12 分钟");
  assert.equal(formatEstimate(19 * MIN), "约 19 分钟");
  assert.equal(formatEstimate(22 * MIN), "约 20 分钟");
  assert.equal(formatEstimate(23 * MIN), "约 25 分钟");
  assert.equal(formatEstimate(58 * MIN), "约 1 小时");
  assert.equal(formatEstimate(72 * MIN), "约 1 小时 10 分钟");
  assert.equal(formatEstimate(75 * MIN), "约 1 小时 15 分钟");
  assert.equal(formatEstimate(180 * MIN), "约 3 小时");
  assert.equal(formatEstimate(-5), "不到 1 分钟");
});

test("describeBasis 按依据措辞，并写明用的是近 30 天还是全部历史", () => {
  const base = { words: 100, ms: 1, wordsPerMinute: 142 };
  assert.match(describeBasis({ ...base, basis: "default", windowDays: 0 }), /一般速度/);
  assert.match(describeBasis({ ...base, basis: "personal", windowDays: 30 }), /近 30 天.*142/);
  assert.match(describeBasis({ ...base, basis: "personal", windowDays: 0 }), /过往.*142/);
  assert.match(describeBasis({ ...base, basis: "article", windowDays: 30 }), /这篇.*142/);
});

/* ---------- ParagraphTracker.remainingTarget ---------- */

test("remainingTarget 合计还没读的段落的字数与预计时长", async () => {
  const { ParagraphTracker } = await import("../src/content/paragraphs.ts");
  const p = (index: number, words: number, expectedMs: number) => ({
    index,
    hash: "h" + index,
    words,
    expectedMs,
    el: {} as unknown as Element,
    text: "p" + index,
  });
  const t = new ParagraphTracker([p(0, 100, 25_000), p(1, 50, 12_500), p(2, 200, 50_000)], {
    dwellMs: 1_000,
    readFraction: 0.5,
    now: () => 0,
  });
  assert.deepEqual(t.remainingTarget(), { words: 350, expectedMs: 87_500 });
  t.seedRead(["h0", "h2"]); // 上次已经读过第一段和最后一段
  assert.deepEqual(t.remainingTarget(), { words: 50, expectedMs: 12_500 });
});
