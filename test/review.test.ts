import { test } from "node:test";
import assert from "node:assert/strict";
import { State } from "ts-fsrs";
import { dueCards, fromStored, gradeCard, newCard, previewIntervals, reviewStats, toStored } from "../src/lib/review.ts";
import {
  HARD_MAX_CHARS,
  cardKeyOf,
  classifyKind,
  hasLatin,
  judgeSelection,
  normalizeSelection,
  wordCountOf,
} from "../src/lib/lang.ts";
import type { StoredCard } from "../src/types.ts";

const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
const LIMITS = { minSelectionChars: 2, maxAutoSelectionWords: 40 };

/* ==================== 选区判定 ==================== */

test("normalizeSelection 压平换行与多余空白", () => {
  assert.equal(normalizeSelection("  the   quick\n brown  "), "the quick brown");
});

test("按词数划分粒度", () => {
  assert.equal(classifyKind("leak"), "word");
  assert.equal(classifyKind("give up on"), "phrase");
  assert.equal(classifyKind("in the wild today"), "phrase");
  assert.equal(classifyKind("the question is not whether it leaks"), "sentence");
});

test("hasLatin 拦掉纯中文选区", () => {
  assert.equal(hasLatin("每个抽象都会泄漏"), false);
  assert.equal(hasLatin("抽象 leak 泄漏"), true);
});

test("wordCountOf 空串为 0", () => {
  assert.equal(wordCountOf("   "), 0);
});

test("太短的选区不翻译", () => {
  const v = judgeSelection("a", LIMITS);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "选区太短");
});

test("纯中文选区不翻译", () => {
  assert.equal(judgeSelection("抽象泄漏", LIMITS).ok, false);
});

test("正常英文选区通过且不需确认", () => {
  const v = judgeSelection("  leaks  ", LIMITS);
  assert.equal(v.ok, true);
  assert.equal(v.text, "leaks");
  assert.equal(v.kind, "word");
  assert.equal(v.needsConfirm, false);
});

test("超过自动阈值的长选区要用户确认，不自动烧 token", () => {
  const long = "word ".repeat(60).trim(); // 60 个词
  const v = judgeSelection(long, LIMITS);
  assert.equal(v.ok, true);
  assert.equal(v.words, 60);
  assert.equal(v.needsConfirm, true);
  assert.equal(v.kind, "sentence");
});

test("阈值按词数而非字符数：长单词组成的短句不该被要求确认", () => {
  // 30 个词、300+ 字符——按旧的 220 字符阈值会误判成长选区
  const jargon = "unconstitutional ".repeat(30).trim();
  assert.ok(jargon.length > 220);
  const v = judgeSelection(jargon, LIMITS);
  assert.equal(v.ok, true);
  assert.equal(v.words, 30);
  assert.equal(v.needsConfirm, false);
});

test("超过硬上限直接拒绝，与设置无关", () => {
  const huge = "x".repeat(HARD_MAX_CHARS + 1);
  const v = judgeSelection(huge, { minSelectionChars: 2, maxAutoSelectionWords: 999_999 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "选区过长");
});

test("cardKey 用词元合并同一个词的不同形态", () => {
  assert.equal(cardKeyOf("Leaks", "leak"), "leak");
  assert.equal(cardKeyOf("leaked", "leak"), "leak");
  // 没有词元时退回原文，且大小写不敏感
  assert.equal(cardKeyOf("Leaks", null), "leaks");
});

/* ==================== FSRS 桥接 ==================== */

test("新卡从 New 状态开始且立即到期", () => {
  const c = newCard("c1", "leak", ["s1"], NOW);
  assert.equal(c.state, State.New);
  assert.equal(c.reps, 0);
  assert.ok(c.due <= NOW, "新卡应当马上可以复习");
  assert.equal(c.lastReview, null);
});

test("StoredCard round-trip 不丢精度", () => {
  const before = newCard("c1", "leak", ["s1"], NOW);
  const graded = gradeCard(before, 3, NOW);
  const card = fromStored(graded);
  const again = toStored(card, graded.id, graded.key, graded.snippetIds);
  assert.deepEqual(again, graded, "存→算→存 必须完全一致");
});

test("fromStored 对没复习过的新卡不产生 Invalid Date", () => {
  const c = newCard("c1", "leak", ["s1"], NOW);
  const card = fromStored(c);
  assert.equal(card.last_review, undefined);
  assert.equal(Number.isNaN(card.due.getTime()), false);
});

test("时间戳存储经 JSON round-trip 后仍能正确调度", () => {
  // 这正是用 number 而不是 Date 的原因：Date 走一遍 JSON 会变字符串
  const c = newCard("c1", "leak", ["s1"], NOW);
  const revived = JSON.parse(JSON.stringify(c)) as StoredCard;
  const a = gradeCard(c, 3, NOW);
  const b = gradeCard(revived, 3, NOW);
  assert.equal(a.due, b.due);
  assert.equal(a.stability, b.stability);
});

test("评 Again 会让卡片进入 Learning/Relearning 并很快再来", () => {
  const c = newCard("c1", "leak", ["s1"], NOW);
  const good = gradeCard(c, 3, NOW);
  const again = gradeCard(good, 1, good.due);
  assert.ok(again.due - good.due < 24 * 3600 * 1000, "忘了的卡应当当天再来");
  assert.ok(again.state === State.Learning || again.state === State.Relearning);
});

test("评分越高，下次到期越晚", () => {
  const c = gradeCard(newCard("c1", "leak", ["s1"], NOW), 3, NOW);
  const p = previewIntervals(c, c.due);
  assert.ok(p[1] < p[2] && p[2] <= p[3] && p[3] <= p[4], `期望单调递增，实得 ${JSON.stringify(p)}`);
});

test("连续评 Easy 间隔会拉长", () => {
  let c = newCard("c1", "leak", ["s1"], NOW);
  c = gradeCard(c, 4, NOW);
  const first = c.due - NOW;
  const second = gradeCard(c, 4, c.due);
  assert.ok(second.due - c.due > first, "第二次 Easy 的间隔应当比第一次长");
  assert.equal(second.reps, 2);
});

test("评分会记录 lastReview", () => {
  const c = gradeCard(newCard("c1", "leak", ["s1"], NOW), 3, NOW);
  assert.equal(c.lastReview, NOW);
});

test("卡片 id / key / snippetIds 在评分后保持不变", () => {
  const c = newCard("c1", "leak", ["s1", "s2"], NOW);
  const g = gradeCard(c, 2, NOW);
  assert.equal(g.id, "c1");
  assert.equal(g.key, "leak");
  assert.deepEqual(g.snippetIds, ["s1", "s2"]);
});

/* ==================== 队列与统计 ==================== */

const mk = (id: string, due: number, state = State.Review): StoredCard => ({
  ...newCard(id, id, [], NOW),
  due,
  state,
});

test("dueCards 只取到期的，逾期最久的排最前", () => {
  const cards = [mk("a", NOW + 1000), mk("b", NOW - 5000), mk("c", NOW - 100_000)];
  const due = dueCards(cards, NOW);
  assert.deepEqual(
    due.map((c) => c.id),
    ["c", "b"],
  );
});

test("dueCards 的 limit 生效", () => {
  const cards = [mk("a", NOW - 1), mk("b", NOW - 2), mk("c", NOW - 3)];
  assert.equal(dueCards(cards, NOW, 2).length, 2);
});

test("reviewStats 分状态计数", () => {
  const cards = [mk("a", NOW - 1, State.New), mk("b", NOW - 1, State.Learning), mk("c", NOW + 10_000, State.Review)];
  const s = reviewStats(cards, NOW);
  assert.equal(s.total, 3);
  assert.equal(s.dueNow, 2);
  assert.equal(s.newCount, 1);
  assert.equal(s.learningCount, 1);
  assert.equal(s.reviewCount, 1);
});

test("forecast 把逾期的卡都算进今天", () => {
  const yesterday = NOW - 3 * 24 * 3600 * 1000;
  const s = reviewStats([mk("a", yesterday), mk("b", NOW)], NOW);
  assert.equal(s.forecast[0], 2);
  assert.equal(s.forecast.length, 7);
});

test("forecast 按本地日历天分桶", () => {
  const startOfToday = new Date(NOW);
  startOfToday.setHours(0, 0, 0, 0);
  const tomorrowNoon = startOfToday.getTime() + 24 * 3600 * 1000 + 12 * 3600 * 1000;
  const s = reviewStats([mk("a", tomorrowNoon)], NOW);
  assert.equal(s.forecast[1], 1);
  assert.equal(s.forecast[0], 0);
});
