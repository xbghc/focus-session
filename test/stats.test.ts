import { test } from "node:test";
import assert from "node:assert/strict";
import type { EndReason, Session } from "../src/types.ts";
import { breakdownByReason, buildOverview, mergeEpisodes, overviewInsights } from "../src/lib/stats.ts";

const MIN = 60_000;

let seq = 0;
function session(startTs: number, ms: number, over: Partial<Session> = {}): Session {
  return {
    id: `s${++seq}`,
    articleId: "https://a.com/1",
    url: "https://a.com/1",
    title: "A",
    startTs,
    endTs: startTs + ms,
    wordsRead: 0,
    endReason: "idle",
    ...over,
  };
}

/* ---------- 回合 ---------- */

test("同一篇文章内间隔不超过阈值的片段合成一个回合", () => {
  const eps = mergeEpisodes(
    [session(0, 30_000), session(40_000, 60_000), session(2 * MIN, 30_000)],
    5 * MIN,
  );
  assert.equal(eps.length, 1);
  assert.equal(eps[0]!.sessionCount, 3);
  assert.equal(eps[0]!.activeMs, 120_000, "回合时长是片段之和，不含间隔");
  assert.equal(eps[0]!.endTs, 2 * MIN + 30_000);
});

test("间隔恰好等于阈值仍合并，超过一毫秒就分开", () => {
  const gap = 5 * MIN;
  const same = mergeEpisodes([session(0, MIN), session(MIN + gap, MIN)], gap);
  assert.equal(same.length, 1);
  const apart = mergeEpisodes([session(0, MIN), session(MIN + gap + 1, MIN)], gap);
  assert.equal(apart.length, 2);
});

test("不同文章不会合成一个回合，输出按时间排序", () => {
  const eps = mergeEpisodes(
    [
      session(10 * MIN, MIN, { articleId: "https://b.com/2" }),
      session(0, MIN),
      session(10 * MIN + 30_000, MIN),
    ],
    5 * MIN,
  );
  assert.equal(eps.length, 3, "b 的片段夹在 a 的两段之间，三者都不该合并");
  assert.deepEqual(
    eps.map((e) => e.startTs),
    [0, 10 * MIN, 10 * MIN + 30_000],
  );
});

test("输入乱序也能正确合并，字数随之累加", () => {
  const eps = mergeEpisodes(
    [session(MIN, MIN, { wordsRead: 50 }), session(0, 30_000, { wordsRead: 20 })],
    5 * MIN,
  );
  assert.equal(eps.length, 1);
  assert.equal(eps[0]!.wordsRead, 70);
  assert.equal(eps[0]!.startTs, 0);
});

test("阈值为 0 时只有严丝合缝的片段才合并", () => {
  const eps = mergeEpisodes([session(0, MIN), session(MIN, MIN), session(2 * MIN + 1, MIN)], 0);
  assert.equal(eps.length, 2);
});

/* ---------- 结束原因 ---------- */

test("结束原因构成：所有原因都在，没出现的为 0", () => {
  const b = breakdownByReason([
    session(0, 10_000, { endReason: "blur" }),
    session(0, 20_000, { endReason: "blur" }),
    session(0, 30_000, { endReason: "idle" }),
  ]);
  assert.equal(b.blur.count, 2);
  assert.equal(b.blur.ms, 30_000);
  assert.equal(b.idle.count, 1);
  for (const r of ["stall", "hidden", "unload", "recovered"] as EndReason[]) {
    assert.deepEqual(b[r], { count: 0, ms: 0 });
  }
});

/* ---------- 概览 ---------- */

test("概览只统计窗口内的片段，并把窗口与合并阈值一并回传", () => {
  const now = 100 * MIN;
  const o = buildOverview(
    [session(0, MIN), session(now - MIN, MIN)],
    now,
    { windowMs: 10 * MIN, episodeGapMs: 5 * MIN },
  );
  assert.equal(o.sessionCount, 1);
  assert.equal(o.windowMs, 10 * MIN);
  assert.equal(o.episodeGapMs, 5 * MIN, "阈值的选择是结果的一部分，界面上要写明");
});

test("概览：回合、有效阅读时长、切换频率", () => {
  const now = 60 * MIN;
  const o = buildOverview(
    [
      session(0, 10 * MIN, { wordsRead: 500, endReason: "blur" }),
      session(11 * MIN, 10 * MIN, { wordsRead: 0, endReason: "idle" }), // 回看，没读到新内容
      session(30 * MIN, 10 * MIN, { wordsRead: 300, endReason: "hidden" }), // 间隔 9 分钟，另一回合
    ],
    now,
    { windowMs: 24 * 3600_000, episodeGapMs: 5 * MIN },
  );
  assert.equal(o.totalMs, 30 * MIN);
  assert.equal(o.readingMs, 20 * MIN, "只有读到新段落的片段算有效阅读");
  assert.equal(o.wordsRead, 800);
  assert.equal(o.episodeCount, 2);
  assert.equal(o.longestEpisodeMs, 20 * MIN);
  assert.equal(o.episodeMedianMs, 15 * MIN);
  // blur + hidden = 2 次切换，专注 0.5 小时 → 4 次/时
  assert.equal(o.switchesPerHour, 4);
  assert.equal(o.medianMs, 10 * MIN);
});

test("没有记录时概览全为 0，不出现 NaN", () => {
  const o = buildOverview([], 0, { windowMs: MIN, episodeGapMs: MIN });
  assert.equal(o.sessionCount, 0);
  assert.equal(o.switchesPerHour, 0);
  assert.equal(o.episodeMedianMs, 0);
  assert.deepEqual(overviewInsights(o), [], "没数据就没有解读");
});

/* ---------- 解读只在数据支持时出现 ---------- */

test("片段明显比回合碎时才提示切碎，否则不说话", () => {
  const now = 60 * MIN;
  const fragmented = buildOverview(
    [session(0, MIN), session(2 * MIN, MIN), session(4 * MIN, MIN), session(6 * MIN, MIN)],
    now,
    { windowMs: 24 * 3600_000, episodeGapMs: 5 * MIN },
  );
  assert.equal(fragmented.episodeCount, 1);
  assert.ok(overviewInsights(fragmented).some((l) => l.includes("合成 1 个回合")));

  const clean = buildOverview(
    [session(0, MIN), session(30 * MIN, MIN)],
    now,
    { windowMs: 24 * 3600_000, episodeGapMs: 5 * MIN },
  );
  assert.equal(clean.sessionCount / clean.episodeCount, 1);
  assert.equal(overviewInsights(clean).length, 0, "两个片段两个回合，没什么可解读的");
});

test("一半以上片段以切走结束且总时长够长时才提示切换频率", () => {
  const now = 60 * MIN;
  const blurry = buildOverview(
    [
      session(0, 6 * MIN, { endReason: "blur" }),
      session(10 * MIN, 6 * MIN, { endReason: "hidden" }),
      session(20 * MIN, 6 * MIN, { endReason: "idle" }),
    ],
    now,
    { windowMs: 24 * 3600_000, episodeGapMs: MIN },
  );
  assert.ok(overviewInsights(blurry).some((l) => l.includes("每小时切换")));

  const brief = buildOverview([session(0, MIN, { endReason: "blur" })], now, {
    windowMs: 24 * 3600_000,
    episodeGapMs: MIN,
  });
  assert.equal(overviewInsights(brief).length, 0, "一分钟的样本说不出什么");
});

test("读到新内容的时长不足一半时提示，否则不提", () => {
  const now = 60 * MIN;
  const lingering = buildOverview(
    [session(0, 5 * MIN, { wordsRead: 100 }), session(10 * MIN, 15 * MIN, { wordsRead: 0 })],
    now,
    { windowMs: 24 * 3600_000, episodeGapMs: MIN },
  );
  assert.ok(overviewInsights(lingering).some((l) => l.includes("25% 的专注时长")));

  const reading = buildOverview(
    [session(0, 15 * MIN, { wordsRead: 100 }), session(20 * MIN, 5 * MIN, { wordsRead: 0 })],
    now,
    { windowMs: 24 * 3600_000, episodeGapMs: MIN },
  );
  assert.ok(!overviewInsights(reading).some((l) => l.includes("的专注时长")));
});
