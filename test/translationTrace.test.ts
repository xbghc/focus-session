import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { TranslationTrace } from "../src/lib/translationDiagnostics.ts";

/*
 * 翻译链路记录器（内容脚本那一半）：打点相对手势起点；浮层位置按动画帧采样，每次定位后只采一帧，
 * 译文进 DOM 后补一帧记"露出来"的时刻；最终内容更新之后才逐帧连续采，连续两帧稳定算渲染完成、
 * 两秒不稳定算超时；稳定前被关掉仍按结果记；没有 rAF 的环境记 unobserved；
 * http 页面没有 randomUUID 也能生成 id；save 抛错不外溢。
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com/" });
const g = globalThis as Record<string, unknown>;
g["document"] = dom.window.document;
g["window"] = dom.window;

/** 手动驱动的动画帧：谁排了队记下来，跑一帧就把队里的全放行。 */
let frames: Array<() => void> = [];
g["requestAnimationFrame"] = (cb: () => void): number => frames.push(cb);
g["cancelAnimationFrame"] = (): void => undefined;
const frame = (): void => {
  for (const cb of frames.splice(0)) cb();
};

const { TranslationTraceRecorder, traceId } = await import("../src/content/translationTrace.ts");

/** 浮层盒子：位置由测试摆，getBoundingClientRect 照着报。 */
let rect = { left: 10, top: 20, width: 100, height: 40 };
const box = dom.window.document.createElement("div");
dom.window.document.body.append(box);
Object.defineProperty(box, "getBoundingClientRect", {
  value: () => ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height }),
});

let t = 1000;
const now = (): number => t;
/** 手势 1000 起：选区 1200 提交、1250 解析、1480 防抖结束。 */
const input = { source: "mouse" as const, started: 1000, committed: 1200, resolved: 1250, debounceEnded: 1480 };
const reset = (): void => {
  frames = [];
  t = 1500;
  rect = { left: 10, top: 20, width: 100, height: 40 };
};
const partial = (translation: string | null) => ({ translation, phonetic: null, pos: null, contextNote: null, usage: null, vocab: [] });

test("打点相对手势起点；译文露出的那一帧、渲染稳定各自有据；定位后只采一帧；save 只调一次且是快照", () => {
  reset();
  const saved: TranslationTrace[] = [];
  const rec = new TranslationTraceRecorder(input, "river bank", "phrase", (log) => saved.push(log), now);
  // 展开一份再比：assert.deepEqual 会把 rec.log.marks 收窄成这个字面量类型，后面的打点就访问不了
  assert.deepEqual({ ...rec.log.marks }, { inputStart: 0, selectionEnd: 200, selectionResolved: 250, debounceEnd: 480 });
  assert.equal(rec.log.popup.measurement, "animation-frame");
  assert.ok(Math.abs(rec.log.ts - (Date.now() - 500)) < 5_000, "ts 是手势起点的墙钟时间");
  rec.mark("prepared");
  t = 1600;
  rec.mark("requestStart");
  rec.positioned(box); // 占位浮层摆好：排一帧
  assert.equal(frames.length, 1);
  t = 1620;
  frame();
  assert.equal(rec.log.marks.popupShown, 620);
  assert.equal(rec.log.marks.firstTranslationVisible, undefined, "还没有译文");
  assert.deepEqual(rec.log.popup.initial, { x: 10, y: 20, width: 100, height: 40, scale: 1 });
  assert.equal(frames.length, 0, "定位后只采一帧，等确认时不该逐帧空转");

  t = 2000;
  rec.partial(partial("河岸"), () => { t += 4; });
  assert.equal(rec.log.marks.firstPartial, 1000);
  assert.equal(rec.log.marks.firstTranslationDom, 1004, "译文进 DOM 记在渲染之后，渲染那 4ms 算在里面");
  assert.deepEqual(rec.log.partials, [{ atMs: 1000, renderMs: 4, fields: ["translation"] }]);
  assert.equal(frames.length, 1, "译文进了 DOM 要补一帧");
  t = 2010;
  frame();
  assert.equal(rec.log.marks.firstTranslationVisible, 1010);
  assert.equal(frames.length, 0);
  rec.partial(partial("河岸"), () => undefined); // 第二个增量：打点不重复，增量照记
  assert.equal(rec.log.partials.length, 2);
  assert.equal(rec.log.marks.firstTranslationDom, 1004, "首次打点不被后来的增量覆盖");
  t = 2020;
  frame(); // 这一帧是第二个增量排的，放它过去

  t = 2500;
  rec.mark("responseReceived");
  rec.complete("success");
  assert.equal(rec.log.marks.finalDom, 1500);
  assert.equal(saved.length, 0, "还没稳定");
  t = 2516;
  frame();
  assert.equal(saved.length, 0);
  assert.equal(frames.length, 1, "收尾阶段逐帧连续采");
  t = 2532;
  frame();
  assert.equal(saved.length, 1, "连续两帧位置不变即稳定");
  const log = saved[0]!;
  assert.equal(log.status, "success");
  assert.equal(log.marks.renderComplete, 1532);
  assert.equal(log.marks.ended, 1532);
  assert.equal(log.durations.totalMs, 1532);
  assert.equal(log.durations.requestMs, 900);
  assert.equal(log.durations.translationVisibleMs, 1010);
  assert.equal(log.durations.renderSettleMs, 32);
  assert.equal(log.popup.samples, 5);
  assert.equal(log.popup.positionCalls, 1);
  assert.equal(log.popup.positionChanges, 0);
  assert.equal(frames.length, 0, "收束之后不再排帧");
  rec.mark("late");
  rec.finish("cancelled");
  assert.equal(saved.length, 1, "收束之后再收一次不重复保存");
  assert.equal(log.marks.late, undefined, "save 拿到的是快照，事后的打点进不去");
});

test("位置变化：半个像素以内的抖动不算挪动，够半个像素才记一次，宽高变化不算", () => {
  reset();
  const rec = new TranslationTraceRecorder(input, "x", "word", () => undefined, now);
  rec.positioned(box);
  frame();
  rect = { ...rect, left: 10.4 };
  rec.positioned(box);
  frame();
  assert.equal(rec.log.popup.positionChanges, 0);
  rect = { ...rect, height: 80 };
  rec.positioned(box);
  frame();
  assert.equal(rec.log.popup.positionChanges, 0, "只是长高了");
  rect = { ...rect, top: 20.5 };
  t = 1800;
  rec.positioned(box);
  frame();
  assert.equal(rec.log.popup.positionChanges, 1);
  assert.deepEqual(rec.log.popup.moves, [{ atMs: 800,
    from: { x: 10.4, y: 20, width: 100, height: 80, scale: 1 }, to: { x: 10.4, y: 20.5, width: 100, height: 80, scale: 1 } }]);
  assert.equal(rec.log.popup.positionCalls, 4);
  assert.equal(rec.log.popup.samples, 4);
  rec.finish("cancelled");
});

test("最终内容已更新、稳定前被关掉：按结果记而不是 cancelled，失败原因留着；还没到最终内容才是真的取消", () => {
  reset();
  const saved: TranslationTrace[] = [];
  const ok = new TranslationTraceRecorder(input, "x", "word", (log) => saved.push(log), now);
  ok.positioned(box);
  frame();
  ok.complete("success");
  ok.finish("cancelled", "浮层关闭");
  assert.equal(saved[0]!.status, "success");
  assert.equal(saved[0]!.reason, "浮层关闭");
  assert.equal(saved[0]!.marks.renderComplete, undefined, "没等到稳定就不能说渲染完成");
  const bad = new TranslationTraceRecorder(input, "x", "word", (log) => saved.push(log), now);
  bad.complete("error", "模型没回话");
  bad.finish("cancelled", "浮层关闭");
  assert.equal(saved[1]!.status, "error");
  assert.equal(saved[1]!.reason, "模型没回话");
  const gone = new TranslationTraceRecorder(input, "x", "word", (log) => saved.push(log), now);
  gone.mark("requestStart");
  gone.finish("cancelled", "选择改变");
  assert.equal(saved[2]!.status, "cancelled");
  assert.equal(saved[2]!.reason, "选择改变");
  assert.equal(saved[2]!.marks.finalDom, undefined);
});

test("两秒内没稳定下来记 render-timeout，之后不再采样", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    reset();
    const saved: TranslationTrace[] = [];
    const rec = new TranslationTraceRecorder(input, "x", "word", (log) => saved.push(log), now);
    rec.positioned(box);
    frame();
    rec.complete("success");
    for (let i = 1; i <= 5; i++) { // 每帧都在挪：稳定不下来
      rect = { ...rect, left: rect.left + 1 };
      t += 16;
      frame();
    }
    assert.equal(saved.length, 0);
    mock.timers.tick(2_000);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.status, "render-timeout");
    assert.equal(saved[0]!.popup.positionChanges, 5);
    frame();
    assert.equal(frames.length, 0, "收束之后不再排帧");
  } finally {
    mock.timers.reset();
  }
});

test("没有动画帧的环境：位置不量，complete 一到就记 unobserved", () => {
  const raf = g["requestAnimationFrame"];
  delete g["requestAnimationFrame"];
  try {
    reset();
    const saved: TranslationTrace[] = [];
    const rec = new TranslationTraceRecorder(input, "x", "word", (log) => saved.push(log), now);
    assert.equal(rec.log.popup.measurement, "unavailable");
    rec.positioned(box);
    rec.complete("success");
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.status, "unobserved");
    assert.equal(saved[0]!.popup.samples, 0);
    assert.equal(saved[0]!.popup.positionCalls, 1);
  } finally {
    g["requestAnimationFrame"] = raf;
  }
});

test("http 页面没有 randomUUID 也能生成 id；save 抛错不外溢", () => {
  const stub = {
    getRandomValues: ((a: Uint8Array) => a.fill(0xab)) as Crypto["getRandomValues"],
  };
  assert.equal(traceId(stub), "ab".repeat(16));
  assert.equal(traceId({ ...stub, randomUUID: () => "uuid" }), "uuid");
  assert.match(traceId(), /^[0-9a-f-]{32,36}$/);
  reset();
  const rec = new TranslationTraceRecorder(input, "x", "word", () => { throw new Error("日志坏了"); }, now);
  assert.ok(rec.log.id);
  assert.doesNotThrow(() => rec.finish("cancelled"));
});
