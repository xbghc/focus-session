import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/*
 * 打字机：字按 DOM 顺序一个一个露出来，积压多了在限定时间里追平，改口时退回公共前缀接着打，
 * 没有动画帧或要求减少动画时直接显示。帧由测试一帧一帧手动推。
 */

const dom = new JSDOM("<!doctype html><body></body>");
const g = globalThis as Record<string, unknown>;
g["document"] = dom.window.document;
g["Node"] = dom.window.Node;

const { Typewriter, BASE_CPS, CATCHUP_MS } = await import("../src/features/translation/typewriter.ts");

/** 手动推的动画帧：tick(ms) 让时间走 ms 再跑一帧。 */
function frames() {
  let queue: Array<(t: number) => void> = [];
  let t = 0;
  return {
    frame: (cb: (t: number) => void) => { queue.push(cb); return queue.length; },
    cancel: () => { queue = []; },
    tick(ms = 1000 / 60) {
      t += ms;
      const run = queue;
      queue = [];
      for (const cb of run) cb(t);
    },
    get pending() { return queue.length; },
  };
}

let body: HTMLElement;
let clock: ReturnType<typeof frames>;
let idles: number;
let applied: number;
let reduced: boolean;
const make = () => new Typewriter(
  { apply: (reveal) => { applied++; reveal(); }, idle: () => { idles++; } },
  { frame: clock.frame, cancel: clock.cancel, reducedMotion: () => reduced },
);
const el = (cls: string) => {
  const d = dom.window.document.createElement("div");
  d.className = cls;
  body.append(d);
  return d;
};

beforeEach(() => {
  body = dom.window.document.body;
  body.textContent = "";
  clock = frames();
  idles = 0;
  applied = 0;
  reduced = false;
});

test("写进来不立刻显示；第一帧就露出第一个字，之后按基础速度一帧一个", () => {
  const tw = make();
  const tr = el("tr");
  tr.innerHTML = '<span class="spin"></span>';
  tw.write(tr, "抢占式的");
  assert.equal(tr.textContent, "", "转圈清掉，字还没出来");
  clock.tick();
  assert.equal(tr.textContent, "抢");
  clock.tick();
  clock.tick();
  assert.equal(tr.textContent, "抢占式");
  assert.ok(tw.busy);
  clock.tick();
  assert.equal(tr.textContent, "抢占式的");
  clock.tick(); // 下一帧发现打完了
  assert.equal(idles, 1);
  assert.equal(tw.busy, false);
  assert.equal(clock.pending, 0, "打完就不再要帧");
});

test("一大段一起到：在 CATCHUP_MS 左右追平，不按基础速度慢慢磨", () => {
  const tw = make();
  const note = el("note");
  const text = "在本文语境中指的是操作系统采用的抢占式多任务处理方式。".repeat(10); // 约 270 字
  tw.write(note, text);
  let elapsed = 0;
  while (note.textContent !== text && elapsed < 5000) { clock.tick(); elapsed += 1000 / 60; }
  assert.equal(note.textContent, text);
  assert.ok(elapsed <= CATCHUP_MS + 50, `追平用了 ${Math.round(elapsed)}ms`);
  assert.ok(elapsed >= CATCHUP_MS * 0.5, "也不是一帧倒完");
  assert.ok(text.length / (elapsed / 1000) > BASE_CPS * 2);
});

test("按 DOM 顺序打：后到的上面那个字段先打，下面的等着", () => {
  const tw = make();
  const tr = el("tr");
  const note = el("note");
  tw.write(note, "语境");
  clock.tick();
  assert.equal(note.textContent, "语");
  tw.write(tr, "译文译文译文");
  // 积压不多时一帧一个：先把上面的译文打完，下面的语境解释停在原地
  for (let i = 0; i < 6; i++) clock.tick();
  assert.equal(tr.textContent, "译文译文译文");
  assert.equal(note.textContent, "语");
  clock.tick();
  assert.equal(note.textContent, "语境");
});

test("接着已显示的往后长；改口时退回公共前缀再打，已经露出来的节点不换", () => {
  const tw = make();
  const tr = el("tr");
  tw.write(tr, "抢占");
  clock.tick(); clock.tick();
  const node = tr.firstChild;
  tw.write(tr, "抢占式");
  clock.tick();
  assert.equal(tr.textContent, "抢占式");
  tw.write(tr, "抢先的");
  assert.equal(tr.textContent, "抢", "退回公共前缀");
  clock.tick(); clock.tick();
  assert.equal(tr.textContent, "抢先的");
  assert.equal(tr.firstChild, node, "始终是同一个文本节点：人正选着的字不会因此丢掉");
});

test("接管一整块（一条生词）：字先藏起来轮到再打，挑出来的（音标、按钮）原样显示", () => {
  const tw = make();
  const v = el("v");
  v.innerHTML = '<div class="vh"><span class="vw">leak</span><span class="vm">/liːk/ · v.</span><button>🔊</button></div><div class="vd">泄漏</div>';
  tw.adopt(v, (e) => e.classList.contains("vm") || e.tagName === "BUTTON");
  assert.equal(v.querySelector(".vw")!.textContent, "");
  assert.equal(v.querySelector(".vd")!.textContent, "");
  assert.equal(v.querySelector(".vm")!.textContent, "/liːk/ · v.");
  assert.equal(v.querySelector("button")!.textContent, "🔊");
  for (let i = 0; i < 6; i++) clock.tick();
  assert.equal(v.querySelector(".vw")!.textContent, "leak");
  assert.equal(v.querySelector(".vd")!.textContent, "泄漏");
});

test("按码点走：emoji 不会被劈成半个露出来", () => {
  const tw = make();
  const tr = el("tr");
  tw.write(tr, "a😀b");
  clock.tick();
  assert.equal(tr.textContent, "a");
  clock.tick();
  assert.equal(tr.textContent, "a😀");
});

test("没有动画帧、要求减少动画、或者指定 instant：直接显示", () => {
  const plain = new Typewriter({ apply: (r) => r() }, { frame: null });
  const a = el("a");
  plain.write(a, "直接");
  assert.equal(a.textContent, "直接");
  reduced = true;
  const tw = make();
  const b = el("b");
  tw.write(b, "也直接");
  assert.equal(b.textContent, "也直接");
  reduced = false;
  const c = el("c");
  make().write(c, "缓存命中", true);
  assert.equal(c.textContent, "缓存命中");
  assert.equal(clock.pending, 0);
});

test("flush 一次全露；clear 之后没露的就不露了；被整块换掉的节点不再管", () => {
  const tw = make();
  const a = el("a");
  const b = el("b");
  tw.write(a, "一二三");
  tw.write(b, "四五六");
  tw.flush();
  assert.equal(a.textContent + b.textContent, "一二三四五六");
  assert.equal(idles, 1);

  tw.write(a, "一二三七八九");
  clock.tick();
  tw.clear();
  clock.tick();
  assert.equal(a.textContent, "一二三七");

  tw.write(b, "四五六十");
  b.textContent = "出错了"; // 失败提示整块盖掉了答案
  clock.tick(); clock.tick();
  assert.equal(b.textContent, "出错了");
  assert.equal(idles, 2, "发现没东西可打就停");
});

test("切到后台再回来：一帧最多按 100ms 算，不一口气倒完", () => {
  const tw = make();
  const a = el("a");
  tw.write(a, "一二三四五六七八九十");
  clock.tick();
  clock.tick(10_000);
  assert.ok(a.textContent!.length < 10, `一帧露了 ${a.textContent!.length} 个字`);
});
