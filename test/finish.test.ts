import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { isFinished } from "../src/lib/finish.ts";

/* ==================== 读完判定 ==================== */

const BASE = { wordsRead: 800, trackedWords: 1000, reachedBottom: true, finishRatio: 0.8 };

test("比例达标且触底才算读完", () => {
  assert.equal(isFinished(BASE), true);
});

test("比例不够不算读完", () => {
  assert.equal(isFinished({ ...BASE, wordsRead: 799 }), false);
});

test("没触底不算读完——一路滚到底的跳读不该算", () => {
  assert.equal(isFinished({ ...BASE, reachedBottom: false }), false);
});

test("正文字数为 0 时不算读完，也不会除出 NaN", () => {
  assert.equal(isFinished({ ...BASE, wordsRead: 0, trackedWords: 0 }), false);
});

/* ==================== 右下角回顾角标 ==================== */

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g["document"] = dom.window.document;
g["Element"] = dom.window.Element;

// 同 popover.test.ts：closed shadow root 从外面查不到，测试里强制开着。
const realAttach = dom.window.Element.prototype.attachShadow;
dom.window.Element.prototype.attachShadow = function attachShadow(init: ShadowRootInit): ShadowRoot {
  return realAttach.call(this, { ...init, mode: "open" });
};

const { FinishCard } = await import("../src/content/finishCard.ts");

let opened = 0;
let dismissed = 0;
let card: InstanceType<typeof FinishCard>;
beforeEach(() => {
  document.documentElement.querySelectorAll("#focus-session-finish").forEach((n) => n.remove());
  opened = dismissed = 0;
  card = new FinishCard({ onOpen: () => opened++, onDismiss: () => dismissed++ });
});

const btn = (act: string): HTMLElement =>
  card.hostElement!.shadowRoot!.querySelector(`[data-act="${act}"]`) as HTMLElement;

test("show 挂出角标", () => {
  card.show();
  assert.ok(card.hostElement);
  assert.equal(btn("go").textContent, "回顾这篇");
});

test("重复 show 不会挂出第二个角标", () => {
  card.show();
  const first = card.hostElement;
  card.show();
  assert.equal(card.hostElement, first);
  assert.equal(document.documentElement.querySelectorAll("#focus-session-finish").length, 1);
});

test("点「回顾这篇」通知调用方，角标留在原地", () => {
  card.show();
  btn("go").dispatchEvent(new dom.window.Event("click"));
  assert.equal(opened, 1);
  assert.ok(card.hostElement, "点回顾不该顺手关掉角标——标签页是新开的，原页面还在");
});

test("点 × 立刻摘掉角标并通知调用方", () => {
  card.show();
  btn("x").dispatchEvent(new dom.window.Event("click"));
  assert.equal(dismissed, 1);
  assert.equal(card.hostElement, null);
  assert.equal(document.documentElement.querySelectorAll("#focus-session-finish").length, 0);
});

test("没挂出来时 hide 不炸", () => {
  card.hide();
  assert.equal(card.hostElement, null);
});
