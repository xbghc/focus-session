import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { startFullscreen, type FullscreenHost, type FullscreenReading } from "../src/app/fullscreen.ts";

const dom = new JSDOM("<!doctype html><body class=\"reader\"><header class=\"rbar\"></header></body>");
const g = globalThis as Record<string, unknown>;
g["document"] = dom.window.document;

/** 滚动的那个东西。JSDOM 不排版也不滚动，位置由测试自己说。 */
class Host implements FullscreenHost {
  scrollY = 0;
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  /** 滚到某处并派发一次 scroll，像浏览器那样。 */
  scrollTo(y: number): void {
    this.scrollY = y;
    for (const fn of this.listeners.get("scroll") ?? []) fn();
  }
  resize(): void {
    for (const fn of this.listeners.get("resize") ?? []) fn();
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

let body: HTMLElement;
let bar: HTMLElement;
let host: Host;
let bars: boolean[];
let full: FullscreenReading;
let barHeight: number;

beforeEach(() => {
  body = dom.window.document.body;
  body.className = "reader";
  body.removeAttribute("style");
  bar = body.querySelector<HTMLElement>(".rbar")!;
  barHeight = 68;
  bar.getBoundingClientRect = (() => ({ height: barHeight })) as HTMLElement["getBoundingClientRect"];
  host = new Host();
  bars = [];
  full = startFullscreen({ body, bar, host, systemBars: hidden => void bars.push(hidden) });
});

const hidden = (): boolean => body.classList.contains("chrome-hidden");

test("进全屏就收起系统栏，并把顶栏的高度量给正文留白", () => {
  assert.ok(body.classList.contains("immersive"));
  assert.deepEqual(bars, [true]);
  assert.equal(body.style.getPropertyValue("--rbar-h"), "68px");
  // 顶栏一开始露着：那儿有返回键，收掉就没人知道怎么把它叫回来
  assert.equal(full.shown(), true);
});

test("往下读收起顶栏，往回滑一点就回来", () => {
  host.scrollTo(400);
  assert.equal(hidden(), true);
  assert.equal(full.shown(), false);
  host.scrollTo(380);
  assert.equal(hidden(), false);
});

test("读到一段停下来的抖动不来回切顶栏", () => {
  host.scrollTo(400);
  assert.equal(hidden(), true);
  // 每次都换方向，谁也攒不够阈值
  for (const y of [395, 402, 396, 403]) host.scrollTo(y);
  assert.equal(hidden(), true);
});

test("回到正文顶端顶栏一直露着，哪怕这一下是往下滑的", () => {
  host.scrollTo(400);
  assert.equal(hidden(), true);
  host.scrollTo(0);
  assert.equal(hidden(), false);
  // 顶上那几像素的来回不算"往下读"
  host.scrollTo(6);
  assert.equal(hidden(), false);
});

test("reveal 露出顶栏，并从那一刻重新算滚动", () => {
  host.scrollTo(400);
  assert.equal(hidden(), true);
  // 单子开着时正文没动，reveal 之后接着往下读才重新收
  host.scrollY = 400;
  full.reveal();
  assert.equal(hidden(), false);
  host.scrollTo(410);
  assert.equal(hidden(), false);
  host.scrollTo(440);
  assert.equal(hidden(), true);
});

test("退出全屏把系统栏还回来、撤掉监听，之后的滚动不再动界面", () => {
  host.scrollTo(400);
  full.stop();
  assert.deepEqual(bars, [true, false]);
  assert.equal(body.classList.contains("immersive"), false);
  assert.equal(hidden(), false);
  assert.equal(host.count("scroll"), 0);
  assert.equal(host.count("resize"), 0);
  full.stop();
  assert.deepEqual(bars, [true, false]);
});

test("转屏重新量顶栏的高度；量不到（还没排版）时留着上一个值", () => {
  barHeight = 92;
  host.resize();
  assert.equal(body.style.getPropertyValue("--rbar-h"), "92px");
  barHeight = 0;
  host.resize();
  assert.equal(body.style.getPropertyValue("--rbar-h"), "92px");
});

test("老宿主没有收系统栏那座桥时，顶栏照样跟着滚动走", () => {
  full.stop();
  full = startFullscreen({ body, bar, host });
  assert.ok(body.classList.contains("immersive"));
  host.scrollTo(400);
  assert.equal(hidden(), true);
});
