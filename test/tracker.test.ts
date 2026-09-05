import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { LATIN_WPM } from "../src/lib/reading.ts";

const VH = 900;
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g["document"] = dom.window.document;
g["window"] = { innerHeight: VH };

/** 捕获 tracker 内部注册的 IO 回调，好在测试里手动驱动进出视口。 */
let ioCb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void = () => {};
g["IntersectionObserver"] = class {
  constructor(cb: typeof ioCb) {
    ioCb = cb;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

const { ParagraphTracker } = await import("../src/content/paragraphs.ts");

let clock = 1_000_000;
/** setActive(true) 会起真实的 setInterval，不收掉进程就不会退出。 */
const live: Array<{ destroy(): void }> = [];
beforeEach(() => {
  clock = 1_000_000;
});
afterEach(() => {
  while (live.length > 0) live.pop()!.destroy();
});

interface Box {
  top: number;
  height: number;
}

/** 按 238 wpm 读完 words 个词要多久。 */
const expectMs = (words: number): number => Math.round((words / LATIN_WPM) * 60_000);

function para(index: number, words: number, box: Box) {
  const el = dom.window.document.createElement("p");
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ top: box.top, height: box.height, bottom: box.top + box.height }),
  });
  return {
    p: { index, hash: "h" + index, words, expectedMs: expectMs(words), el: el as unknown as Element, text: `p${index}` },
    box,
  };
}

/**
 * readFraction 默认 0：这组用例测的是停留累计本身（进出视口、停表、节流、播种），
 * 用纯下限阈值最直白。按段落长度缩放的阈值有自己的一组用例。
 */
function makeTracker(items: ReturnType<typeof para>[], dwellMs = 1_000, readFraction = 0) {
  const t = new ParagraphTracker(
    items.map((i) => i.p),
    { dwellMs, readFraction, now: () => clock },
  );
  t.start();
  live.push(t);
  return t;
}

const enter = (...items: ReturnType<typeof para>[]) =>
  ioCb(items.map((i) => ({ target: i.p.el, isIntersecting: true })));
const leave = (...items: ReturnType<typeof para>[]) =>
  ioCb(items.map((i) => ({ target: i.p.el, isIntersecting: false })));

/** 单次结算最多记 2s（节流钳制），要攒长停留得分多步走。 */
function dwell(t: InstanceType<typeof ParagraphTracker>, ms: number): void {
  for (let left = ms; left > 0; left -= 2_000) {
    clock += Math.min(2_000, left);
    t.takeNewWords();
  }
}

test("段落在视口内停留达到阈值才记为已读", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const t = makeTracker([a]);
  t.setActive(true);
  enter(a);

  clock += 900;
  assert.equal(t.takeNewWords(), 0, "不到 1s 不算读过");
  assert.equal(t.readCount, 0);

  clock += 200;
  assert.equal(t.takeNewWords(), 120, "越过阈值后计入本次字数");
  assert.equal(t.readCount, 1);
  assert.equal(t.wordsRead, 120);
});

test("同一段落不会被重复计入", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const t = makeTracker([a]);
  t.setActive(true);
  enter(a);
  clock += 1_200;
  assert.equal(t.takeNewWords(), 120);
  clock += 5_000;
  assert.equal(t.takeNewWords(), 0, "继续停留不应再次计数");
  assert.equal(t.wordsRead, 120);
});

test("session 未激活时不累计停留（后台标签页不能把视口算成已读）", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const t = makeTracker([a]);
  enter(a); // 页面在后台，但段落确实处在视口位置
  clock += 60_000;
  assert.equal(t.takeNewWords(), 0);
  assert.equal(t.readCount, 0, "整整一分钟也不该算读过");
});

test("停表前会做最后一次结算", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const t = makeTracker([a]);
  t.setActive(true);
  enter(a);
  clock += 800; // 还差 200ms 到阈值
  assert.equal(t.takeNewWords(), 0);

  clock += 300;
  t.setActive(false); // 结算必须在停表前发生，否则这 300ms 被丢掉
  assert.equal(t.takeNewWords(), 120, "session 结束瞬间跨过阈值的段落不能漏记");
});

test("离开视口后停止累计", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const t = makeTracker([a]);
  t.setActive(true);
  enter(a);
  clock += 600;
  t.takeNewWords();
  leave(a);
  clock += 10_000;
  assert.equal(t.takeNewWords(), 0);
  assert.equal(t.readCount, 0, "离开视口后不该再攒够阈值");
});

test("滚出视口范围的段落即使仍在候选集里也不计入", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const t = makeTracker([a]);
  t.setActive(true);
  enter(a);
  a.box.top = -290; // 只剩 10px 露在上边
  clock += 5_000;
  assert.equal(t.takeNewWords(), 0);
});

test("比视口还高的长段落只要占住半屏就计入", () => {
  const tall = para(0, 900, { top: -100, height: VH * 3 });
  const t = makeTracker([tall]);
  t.setActive(true);
  enter(tall);
  clock += 1_200;
  assert.equal(t.takeNewWords(), 900, "长段落的可见比例永远到不了 50%，不能因此漏记");
});

test("定时器被节流时单次累计被钳住", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const t = makeTracker([a], 60_000);
  t.setActive(true);
  enter(a);
  clock += 300_000; // 后台标签页被冻结了 5 分钟
  t.takeNewWords();
  const snap = t.snapshot();
  assert.ok(snap[0]!.dwellMs <= 2_000, `单次结算最多算 2s，实际 ${snap[0]!.dwellMs}ms`);
});

test("播种的已读段落不再计入本次新读字数，但计入总已读", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const b = para(1, 80, { top: 450, height: 200 });
  const t = makeTracker([a, b]);
  t.seedRead(["h0"]); // 上次已经读过第一段
  t.setActive(true);
  enter(a, b);
  clock += 1_200;
  assert.equal(t.takeNewWords(), 80, "只应计入这次新读的第二段");
  assert.equal(t.wordsRead, 200, "总已读包含上次读过的部分");
  assert.equal(t.readCount, 2);
});

test("snapshot 只包含有停留或已读的段落", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const b = para(1, 80, { top: 5_000, height: 200 }); // 远在屏幕外
  const t = makeTracker([a, b]);
  t.setActive(true);
  enter(a);
  clock += 1_200;
  t.takeNewWords();
  const snap = t.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0]!.hash, "h0");
  assert.ok(snap[0]!.dwellMs >= 1_000);
  assert.ok(snap[0]!.firstSeenTs > 0);
});

test("destroy 后不再累计", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const t = makeTracker([a]);
  t.setActive(true);
  enter(a);
  t.destroy();
  clock += 10_000;
  assert.equal(t.takeNewWords(), 0);
});

/* ---------- 快照发增量 ---------- */

test("snapshot 的 dwellMs 是自上次快照以来的增量，不是累计", () => {
  // 同一次页面加载里会结束很多个 session，每次都发累计值的话后台会把同一段落加很多遍
  const a = para(0, 120, { top: 100, height: 300 });
  const t = makeTracker([a]);
  t.setActive(true);
  enter(a);

  dwell(t, 1_500);
  const first = t.snapshot();
  assert.equal(first[0]!.dwellMs, 1_500);

  dwell(t, 1_500);
  const second = t.snapshot();
  assert.equal(second[0]!.dwellMs, 1_500, "第二份快照只该带这 1.5s，而不是 3s");

  const third = t.snapshot();
  assert.equal(third.length, 1, "已读段落没有新停留也带上，让后台的 firstSeenTs 不依赖某一条消息");
  assert.equal(third[0]!.dwellMs, 0);
});

test("只是扫过、没读到阈值的段落 firstSeenTs 为 0；读到之后才有", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const t = makeTracker([a], 1_000, 0.5); // 120 词 ≈ 30s，阈值 15s
  t.setActive(true);
  enter(a);

  dwell(t, 1_500);
  const glance = t.snapshot();
  assert.equal(glance.length, 1, "有停留就该上报，后台要累计 dwell");
  assert.equal(glance[0]!.firstSeenTs, 0, "没读到阈值不能让后台把它算成已读");
  assert.equal(t.readCount, 0);

  dwell(t, 16_000);
  const read = t.snapshot();
  assert.equal(t.readCount, 1);
  assert.ok(read[0]!.firstSeenTs > 0, "跨过阈值的时刻要带给后台");
});

/* ---------- 已读阈值按段落长度缩放 ---------- */

test("已读阈值随段落长度缩放：一段 120 词的正文露出一秒不算读过", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const t = makeTracker([a], 1_000, 0.5);
  t.setActive(true);
  enter(a);

  dwell(t, 10_000);
  assert.equal(t.readCount, 0, "120 词按 238 wpm 要 30s，阈值是它的一半 15s，10s 还不够");

  dwell(t, 6_000);
  assert.equal(t.readCount, 1, "过了 15s 就算读过");
  assert.equal(t.wordsRead, 120);
});

test("几个字的标题仍由最短停留兜底", () => {
  const h = para(0, 3, { top: 100, height: 40 }); // 3 词 ≈ 0.76s，一半是 0.38s，低于下限 1s
  const t = makeTracker([h], 1_000, 0.5);
  t.setActive(true);
  enter(h);
  clock += 900;
  t.takeNewWords();
  assert.equal(t.readCount, 0, "不到 1s 的下限");
  clock += 200;
  t.takeNewWords();
  assert.equal(t.readCount, 1);
});

test("阈值热更新只影响还没读到的段落", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const b = para(1, 120, { top: 450, height: 300 });
  const t = makeTracker([a, b], 1_000, 0);
  t.setActive(true);
  enter(a);
  dwell(t, 1_500);
  assert.equal(t.readCount, 1, "旧阈值下 a 已读");

  t.setThresholds({ readFraction: 0.5 });
  enter(b);
  dwell(t, 1_500);
  assert.equal(t.readCount, 1, "新阈值下 b 还没读到，a 不回退");
  dwell(t, 15_000);
  assert.equal(t.readCount, 2);
});

/* ---------- 视口文字量 ---------- */

test("visibleExpectedMs 按露出比例加权，不依赖 session 是否在计时", () => {
  const a = para(0, 120, { top: 100, height: 300 }); // 全露
  const b = para(1, 240, { top: 750, height: 300 }); // 只露上半 150px
  const off = para(2, 500, { top: 5_000, height: 300 }); // 屏幕外，不在候选集
  const t = makeTracker([a, b, off]);
  assert.equal(t.visibleExpectedMs(), 0, "还没有段落进过视口");
  enter(a, b);
  const want = expectMs(120) + Math.round(expectMs(240) * 0.5);
  assert.ok(Math.abs(t.visibleExpectedMs() - want) <= 2, `期望约 ${want}ms，实际 ${t.visibleExpectedMs()}`);
  leave(b);
  assert.ok(Math.abs(t.visibleExpectedMs() - expectMs(120)) <= 2);
});

/* ---------- anchor()：读到哪了 ---------- */

test("锚点取视口里最靠上的段落，偏移是滚进段落内部的距离", () => {
  const a = para(0, 120, { top: -80, height: 300 }); // 顶部被划出去 80px
  const b = para(1, 80, { top: 260, height: 200 });
  const t = makeTracker([a, b]);
  enter(a, b);
  assert.deepEqual(t.anchor(), { index: 0, hash: "h0", offset: 80 });
});

test("上一段完全滚过去之后，锚点交给下一段", () => {
  const a = para(0, 120, { top: -400, height: 300 }); // bottom = -100，已经出视口
  const b = para(1, 80, { top: 40, height: 200 });
  const t = makeTracker([a, b]);
  enter(a, b); // IO 回调可能还没来得及把 a 移出候选集
  assert.deepEqual(t.anchor(), { index: 1, hash: "h1", offset: -40 }, "负偏移表示段落顶还在视口下方");
});

test("候选集为空时返回 null——保留上次的位置，别用空位置覆盖对的", () => {
  const a = para(0, 120, { top: 100, height: 300 });
  const t = makeTracker([a]);
  assert.equal(t.anchor(), null, "还没进过视口");
  enter(a);
  assert.ok(t.anchor());
  leave(a); // 人滚到评论区了，正文全在视口之外
  assert.equal(t.anchor(), null);
});

test("零高度的段落（被折叠/隐藏）不当锚点", () => {
  const hidden = para(0, 120, { top: 0, height: 0 });
  const real = para(1, 80, { top: 20, height: 200 });
  const t = makeTracker([hidden, real]);
  enter(hidden, real);
  assert.equal(t.anchor()?.index, 1);
});

test("锚点不依赖 session 是否在计时", () => {
  // pagehide 时 setActive(false) 已经先执行了，那一刻仍然要采得到位置
  const a = para(0, 120, { top: -50, height: 300 });
  const t = makeTracker([a]);
  t.setActive(true);
  enter(a);
  t.setActive(false);
  assert.deepEqual(t.anchor(), { index: 0, hash: "h0", offset: 50 });
});
