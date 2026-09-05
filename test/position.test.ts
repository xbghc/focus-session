import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { ReadingPosition } from "../src/types.ts";
import { planRestore, samePosition, type RestoreInput } from "../src/lib/position.ts";

/** 10 段的文章，指纹是 h0…h9。 */
const PARAS = Array.from({ length: 10 }, (_, i) => ({ hash: `h${i}` }));

const pos = (over: Partial<ReadingPosition> = {}): ReadingPosition => ({
  articleId: "https://example.com/a",
  hash: "h4",
  index: 4,
  offset: 120,
  paragraphCount: 10,
  savedTs: 1_000,
  ...over,
});

/** 默认是"该跳"的那一组条件，每条用例只推翻其中一项。 */
const input = (over: Partial<RestoreInput> = {}): RestoreInput => ({
  enabled: true,
  pos: pos(),
  paragraphs: PARAS,
  urlHash: "",
  scrollY: 0,
  userScrolled: false,
  ...over,
});

test("正常情况：按指纹认出段落，带上偏移", () => {
  const plan = planRestore(input());
  assert.deepEqual(plan, { index: 4, offset: 120, matched: "hash", total: 10 });
});

test("关掉开关就不跳", () => {
  assert.equal(planRestore(input({ enabled: false })), null);
});

test("没有位置记录就不跳（第一次读这篇）", () => {
  assert.equal(planRestore(input({ pos: null })), null);
});

test("URL 带锚点时不跳——网页自带位置记录，浏览器的落点优先", () => {
  assert.equal(planRestore(input({ urlHash: "#section-3" })), null);
  assert.ok(planRestore(input({ urlHash: "" })), "没有锚点才轮到插件");
});

test("页面已经不在顶部时不跳——多半是浏览器自己恢复了滚动", () => {
  assert.equal(planRestore(input({ scrollY: 2_400 })), null);
  assert.ok(planRestore(input({ scrollY: 6 })), "几个像素的误差不算被定位过");
  assert.equal(planRestore(input({ scrollY: Number.NaN })), null);
});

test("抽取期间用户已经自己滚了就不跳", () => {
  // 抽取最长重试到 4 秒，这期间把人正在读的画面抽走是最恼人的一种交互
  assert.equal(planRestore(input({ userScrolled: true })), null);
});

test("指纹没对上、段落总数也变了：宁可不跳", () => {
  // 跳到错的地方比不跳更糟——会让人以为上次读到的是另一段
  const changed = [{ hash: "x0" }, { hash: "x1" }, { hash: "x2" }];
  assert.equal(planRestore(input({ paragraphs: changed })), null);
});

test("指纹没对上但段落总数一致：按序号兜底", () => {
  const reworded = PARAS.map((_, i) => ({ hash: `z${i}` }));
  const plan = planRestore(input({ paragraphs: reworded }));
  assert.deepEqual(plan, { index: 4, offset: 120, matched: "index", total: 10 });
});

test("序号兜底也要落在范围内", () => {
  const reworded = PARAS.map((_, i) => ({ hash: `z${i}` }));
  assert.equal(planRestore(input({ pos: pos({ index: 99 }), paragraphs: reworded })), null);
  assert.equal(planRestore(input({ pos: pos({ index: -1 }), paragraphs: reworded })), null);
});

test("段落顺序变了时以指纹为准，不是序号", () => {
  const shuffled = [{ hash: "h4" }, ...PARAS.filter((p) => p.hash !== "h4")];
  const plan = planRestore(input({ pos: pos({ index: 4 }), paragraphs: shuffled }));
  assert.equal(plan?.index, 0, "指纹认得出它挪到了开头");
  assert.equal(plan?.matched, "hash");
});

test("上次停在最后一段就不跳——再打开多半是想重读，甩到文末只会挡路", () => {
  assert.equal(planRestore(input({ pos: pos({ hash: "h9", index: 9 }) })), null);
  assert.ok(planRestore(input({ pos: pos({ hash: "h8", index: 8 }) })), "倒数第二段还是跳");
});

test("落在第一段开头附近不跳（跳了等于原地不动）", () => {
  assert.equal(planRestore(input({ pos: pos({ hash: "h0", index: 0, offset: 30 }) })), null);
  const deep = planRestore(input({ pos: pos({ hash: "h0", index: 0, offset: 900 }) }));
  assert.equal(deep?.index, 0, "超长的第一段滚进去很深，那就该跳");
});

test("坏掉的偏移不跳", () => {
  assert.equal(planRestore(input({ pos: pos({ offset: Number.NaN }) })), null);
});

test("抽取结果为空不跳", () => {
  assert.equal(planRestore(input({ paragraphs: [] })), null);
});

test("偏移取整，供 scrollBy 使用", () => {
  assert.equal(planRestore(input({ pos: pos({ offset: 120.7 }) }))?.offset, 121);
});

/* ---------- samePosition：省掉没必要的落盘 ---------- */

test("同一段落、几十像素内的抖动算没动过", () => {
  assert.equal(samePosition(pos(), pos()), true);
  assert.equal(samePosition(pos({ offset: 120 }), pos({ offset: 138 })), true, "缩放/图片撑开的抖动");
  assert.equal(samePosition(pos({ offset: 120 }), pos({ offset: 200 })), false, "真的滚了一段");
});

test("换了段落就是动了", () => {
  assert.equal(samePosition(pos({ hash: "h4", index: 4 }), pos({ hash: "h5", index: 5 })), false);
});

test("没有旧位置时一律算动过（第一拍必须落盘）", () => {
  assert.equal(samePosition(undefined, pos()), false);
  assert.equal(samePosition(null, pos()), false);
});

test("savedTs 不参与比较——否则每一拍心跳都会被判成动过", () => {
  assert.equal(samePosition(pos({ savedTs: 1 }), pos({ savedTs: 9_999_999 })), true);
});

/* ==================== 左下角的那行说明 ==================== */

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g["document"] = dom.window.document;
g["Element"] = dom.window.Element;

// 同 finish.test.ts：closed shadow root 从外面查不到，测试里强制开着。
const realAttach = dom.window.Element.prototype.attachShadow;
dom.window.Element.prototype.attachShadow = function attachShadow(init: ShadowRootInit): ShadowRoot {
  return realAttach.call(this, { ...init, mode: "open" });
};

/** 让测试能摆布 document.visibilityState（jsdom 里它是只读的）。 */
let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(dom.window.document, "visibilityState", {
  configurable: true,
  get: () => visibility,
});
const setVisibility = (v: DocumentVisibilityState): void => {
  visibility = v;
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
};

const { PositionCard } = await import("../src/content/positionCard.ts");

let tops = 0;
let card: InstanceType<typeof PositionCard>;
beforeEach(() => {
  document.documentElement.querySelectorAll("#focus-session-position").forEach((n) => n.remove());
  visibility = "visible";
  tops = 0;
  card = new PositionCard({ onTop: () => tops++ });
});

const text = (sel: string): string =>
  (card.hostElement!.shadowRoot!.querySelector(sel) as HTMLElement).textContent ?? "";

test("show 挂出提示并说明跳到了第几段", () => {
  card.show(5, 10);
  assert.ok(card.hostElement);
  assert.equal(text(".title"), "已回到上次读到的位置");
  assert.equal(text(".sub"), "第 5 段 / 共 10 段");
});

test("重复 show 不会挂出第二个", () => {
  card.show(5, 10);
  const first = card.hostElement;
  card.show(6, 10);
  assert.equal(card.hostElement, first);
  assert.equal(document.documentElement.querySelectorAll("#focus-session-position").length, 1);
});

test("点「回到顶部」摘掉提示并通知调用方", () => {
  card.show(5, 10);
  (card.hostElement!.shadowRoot!.querySelector('[data-act="top"]') as HTMLElement).dispatchEvent(
    new dom.window.Event("click"),
  );
  assert.equal(tops, 1);
  assert.equal(card.hostElement, null);
});

test("页面可见时 6 秒后自己消失", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    card.show(5, 10);
    mock.timers.tick(5_000);
    assert.ok(card.hostElement, "还没到点");
    mock.timers.tick(1_000); // 6s 到点，先淡出
    mock.timers.tick(300); // 淡出走完才真的摘掉
    assert.equal(card.hostElement, null);
  } finally {
    mock.timers.reset();
  }
});

test("后台标签页里不开始倒计时，切过来才开始", () => {
  // 从信息流中键新开一个标签页：跳转发生在没人看着的时候，
  // 这时起表的话等用户切过来提示早没了——而那正是最需要解释的一刻。
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    visibility = "hidden";
    card.show(5, 10);
    mock.timers.tick(60_000);
    assert.ok(card.hostElement, "没人看的时候不该走表");

    setVisibility("visible");
    mock.timers.tick(5_000);
    assert.ok(card.hostElement, "切过来才开始的 6 秒还没走完");
    mock.timers.tick(1_000);
    mock.timers.tick(300);
    assert.equal(card.hostElement, null);
  } finally {
    mock.timers.reset();
  }
});

test("在后台被手动收掉之后，切回前台不会再复活计时", () => {
  visibility = "hidden";
  card.show(5, 10);
  card.hide();
  assert.equal(card.hostElement, null);
  setVisibility("visible"); // 监听已摘掉，这一下不该抛也不该重挂
  assert.equal(card.hostElement, null);
});

test("没挂出来时 hide 不炸", () => {
  card.hide();
  assert.equal(card.hostElement, null);
});

test("带上剩余时间时，说明里跟一句还需多久", () => {
  card.show(5, 10, "还需约 12 分钟");
  assert.equal(text(".sub"), "第 5 段 / 共 10 段 · 还需约 12 分钟");
});
