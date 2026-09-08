import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppError, LlmTiming, ReaderFetch } from "../src/types.ts";
import { appLogLine, secs, timingLine } from "../src/lib/llmStats.ts";

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

/* ---------- App 侧：抓取与运行时错误 ---------- */

function f(over: Partial<ReaderFetch> = {}): ReaderFetch {
  return {
    ts: 1,
    url: "https://e.com/a",
    finalUrl: "https://e.com/a",
    status: 200,
    contentType: "text/html; charset=utf-8",
    charset: "utf-8",
    charsetFrom: "header",
    bytes: 4096,
    bom: false,
    fellBack: false,
    replacementChars: 0,
    title: "t",
    chars: 900,
    error: null,
    ms: 300,
    ...over,
  };
}

const e = (over: Partial<AppError> = {}): AppError => ({
  ts: 1,
  kind: "error",
  message: "boom",
  at: null,
  stack: null,
  ...over,
});

test("两样都空时说清楚是只有 App 才记，免得在扩展里以为坏了", () => {
  assert.match(appLogLine([], []), /只有 App 会记/);
});

test("全都正常时不制造噪音，但要说明最近一次是按什么解的", () => {
  const line = appLogLine([f(), f()], []);
  assert.match(line, /抓取 2 次，都正常/);
  assert.match(line, /按 utf-8 解（响应头）/);
  assert.match(line, /没有未接住的运行时错误/);
});

test("掉字节要点出来——那正是编码挑错了的样子", () => {
  const line = appLogLine([f(), f({ replacementChars: 812, charset: "utf-8", charsetFrom: "default" })], []);
  assert.match(line, /1 次掉字节/);
  assert.match(line, /兜底/);
  assert.doesNotMatch(line, /都正常/);
});

test("抓取失败和掉字节分开数，两样都有就都报", () => {
  const line = appLogLine([f({ error: "网页返回了 HTTP 403" }), f({ replacementChars: 5 })], [e()]);
  assert.match(line, /1 次没抓到/);
  assert.match(line, /1 次掉字节/);
  assert.match(line, /运行时错误 1 条/);
});

test("只有运行时错误、一次都没抓过时，不硬编一句抓取", () => {
  const line = appLogLine([], [e(), e({ kind: "rejection" })]);
  assert.doesNotMatch(line, /抓取/);
  assert.match(line, /运行时错误 2 条/);
});
