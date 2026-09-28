import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/*
 * 阅读情况条：按字数排成一截一截、相邻同档并起来，拼成一条硬边渐变；屏幕上那一截亮着。
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g["document"] = dom.window.document;
// 卡片的 shadow root 是 closed 的，测试里强行打开才看得见里面
const attach = dom.window.HTMLElement.prototype.attachShadow;
dom.window.HTMLElement.prototype.attachShadow = function (init: ShadowRootInit) {
  return attach.call(this, { ...init, mode: "open" });
};

const { FocusBar, focusGradient, focusRuns } = await import("../src/features/reading/focusBar.ts");

beforeEach(() => {
  dom.window.document.documentElement.querySelector("#focus-session-focusbar")?.remove();
});

test("按字数分宽度，相邻同一档的并成一截，没字的段落不占地方", () => {
  const runs = focusRuns([
    { words: 100, state: "earlier" },
    { words: 100, state: "earlier" },
    { words: 0, state: "read" },
    { words: 200, state: "read" },
    { words: 100, state: "unseen" },
  ]);
  assert.deepEqual(runs, [
    { state: "earlier", from: 0, to: 0.4 },
    { state: "read", from: 0.4, to: 0.8 },
    { state: "unseen", from: 0.8, to: 1 },
  ]);
  assert.deepEqual(focusRuns([]), []);
  assert.deepEqual(focusRuns([{ words: 0, state: "read" }]), []);
});

test("拼成硬边渐变，颜色走 CSS 变量（深色模式换的是变量）", () => {
  assert.equal(
    focusGradient([{ state: "read", from: 0, to: 1 / 3 }, { state: "glanced", from: 1 / 3, to: 1 }]),
    "linear-gradient(to right, var(--read) 0% 33.333%, var(--glanced) 33.333% 100%)",
  );
  assert.equal(focusGradient([]), "none");
});

const parts = (bar: InstanceType<typeof FocusBar>) => {
  const root = bar.hostElement!.shadowRoot!;
  return { track: root.querySelector<HTMLElement>(".track")!, here: root.querySelector<HTMLElement>(".here")! };
};

test("屏幕上那一截在条下面标出来，滚到正文外面就不标；收起时连宿主一起摘掉", () => {
  const bar = new FocusBar();
  const marks = [{ words: 100, state: "read" as const }, { words: 300, state: "unseen" as const }];
  bar.show(marks, { from: 0.1, to: 0.35 });
  const host = bar.hostElement!;
  assert.equal(host.parentElement, dom.window.document.documentElement);
  const { track, here } = parts(bar);
  assert.match(track.style.background, /var\(--read\) 0% 25%/);
  assert.equal(here.hidden, false);
  assert.equal(here.style.left, "10%");
  assert.equal(here.style.width, "25%");

  bar.show(marks, null);
  assert.equal(here.hidden, true);

  bar.hide();
  assert.equal(host.isConnected, false);
  assert.equal(bar.hostElement, null);
});

test("跟着滚动每帧都在调：档位没变就不重拼渐变，只挪下面那道线", () => {
  const bar = new FocusBar();
  const marks = [{ words: 100, state: "glanced" as const }];
  bar.show(marks, { from: 0, to: 0.5 });
  const { track } = parts(bar);
  let writes = 0;
  const style = track.style;
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(style), "background")!.set!;
  Object.defineProperty(style, "background", { configurable: true, set(v: string) { writes++; set.call(style, v); }, get: () => "" });
  bar.show(marks, { from: 0.2, to: 0.7 });
  assert.equal(writes, 0);
  bar.show([{ words: 100, state: "read" }], { from: 0.2, to: 0.7 });
  assert.equal(writes, 1);
  bar.hide();
});
