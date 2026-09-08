import { test } from "node:test";
import assert from "node:assert/strict";
import type { LlmTiming } from "../src/types.ts";
import { secs, timingLine } from "../src/lib/llmStats.ts";

function t(over: Partial<LlmTiming> = {}): LlmTiming {
  return {
    ts: 1,
    source: "translate",
    failedKind: null,
    totalMs: 1_800,
    firstTextMs: 700,
    firstFieldMs: 900,
    attempts: 1,
    inputTokens: 249,
    outputTokens: 58,
    model: "M",
    ...over,
  };
}

test("没有记录时说没有，而不是画一行零", () => {
  assert.equal(timingLine([]), "还没有耗时记录。");
});

test("秒以下给毫秒，秒以上给一位小数", () => {
  assert.equal(secs(0), "0ms");
  assert.equal(secs(940), "940ms");
  assert.equal(secs(1_000), "1.0s");
  assert.equal(secs(1_437), "1.4s");
  assert.equal(secs(60_000), "60.0s");
});

test("用中位数而不是均值——一次超时不该把'平时多快'整个带偏", () => {
  // 九次 1s 加一次 60s：均值 6.9s，谁看了都以为这东西常年很慢
  const ts = [...Array(9)].map(() => t({ totalMs: 1_000 }));
  ts.push(t({ totalMs: 60_000, failedKind: "timeout" }));
  const line = timingLine(ts);
  assert.match(line, /中位 1\.0s/);
  assert.ok(!line.includes("6.9s"), "均值不该出现在这一行");
});

test("最慢那次连是谁、怎么坏的一起说", () => {
  const line = timingLine([t({ totalMs: 900 }), t({ totalMs: 42_000, source: "articleReview", failedKind: "timeout" })]);
  assert.match(line, /最慢 42\.0s（文章回顾，timeout）/);
});

test("成功的最慢那次不带失败原因", () => {
  assert.match(timingLine([t({ totalMs: 2_500 })]), /最慢 2\.5s（划词翻译）/);
});

test("看到译文的中位单独给——那才是用户真正等的那一段", () => {
  const line = timingLine([t({ totalMs: 5_000, firstFieldMs: 800 }), t({ totalMs: 6_000, firstFieldMs: 900 })]);
  assert.match(line, /看到译文中位 900ms/);
});

test("一条都没有译文时刻（全是非流式）就不提这一项", () => {
  const line = timingLine([t({ source: "assist", firstTextMs: null, firstFieldMs: null })]);
  assert.ok(!line.includes("看到译文"), line);
});

test("重试过的单独点出来——不然那 1.2 秒退避会被读成模型慢", () => {
  const line = timingLine([t(), t({ attempts: 2 }), t({ attempts: 2 })]);
  assert.match(line, /其中 2 次撞上过载重试/);
});

test("一次都没重试就不提重试", () => {
  assert.ok(!timingLine([t(), t()]).includes("重试"));
});

