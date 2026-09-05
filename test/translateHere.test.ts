import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { Settings } from "../src/types.ts";
import { DEFAULT_SETTINGS } from "../src/types.ts";

/*
 * 没识别为文章的页面：不追踪，但划词翻译可以从 popup 临时开起来。
 * 这里盯的是那条路径上的状态机：默认只是「可用」、点了才挂监听、
 * 总开关与排除域名的热更新都能把它关掉，而用户的选择在本次加载内不丢。
 */

const dom = new JSDOM(
  "<!doctype html><html><head><title>某个网页应用</title></head><body><p>hello</p></body></html>",
  { url: "https://app.example.com/inbox" },
);
const g = globalThis as Record<string, unknown>;
g["document"] = dom.window.document;
g["window"] = dom.window;
g["Node"] = dom.window.Node;
g["Element"] = dom.window.Element;

/** 数 document 上挂着几个 mouseup 监听：划词翻译器 start 会挂一个、stop 会摘掉。 */
let mouseups = 0;
const doc = dom.window.document;
const realAdd = doc.addEventListener.bind(doc);
const realRemove = doc.removeEventListener.bind(doc);
doc.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
  if (type === "mouseup") mouseups++;
  realAdd(type, fn, opts);
}) as typeof doc.addEventListener;
doc.removeEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
  if (type === "mouseup") mouseups--;
  realRemove(type, fn, opts);
}) as typeof doc.removeEventListener;

type Changed = (changes: Record<string, { newValue: unknown }>, area: string) => void;
let onChanged: Changed | null = null;
/** 模拟设置页保存：storage.onChanged 会把整份 settings 推给 content script。 */
const push = (s: Settings): void => onChanged?.({ settings: { newValue: s } }, "local");

g["chrome"] = {
  storage: {
    local: { get: async () => ({ settings: { ...DEFAULT_SETTINGS } }) },
    onChanged: {
      addListener: (fn: Changed) => {
        onChanged = fn;
      },
    },
  },
  runtime: {
    sendMessage: async () => undefined,
    getURL: (p: string) => `chrome-extension://test/${p}`,
  },
};

const { startTracking } = await import("../src/content/track.ts");
const URL_ = "https://app.example.com/inbox";

test("抽不出正文：不追踪，划词翻译只是「可用」，点了才挂监听，停了就摘掉", async () => {
  const ctl = await startTracking({ url: URL_, extract: () => null });
  assert.deepEqual(ctl.state(), { tracked: false, reason: "未识别为文章页", translateHere: "available" });
  assert.equal(mouseups, 0);

  ctl.translateHere();
  assert.equal(ctl.state().translateHere, "on");
  assert.equal(mouseups, 1);
  ctl.translateHere(); // 再点一次不叠加
  assert.equal(mouseups, 1);

  ctl.stop();
  assert.equal(mouseups, 0);
  assert.equal(ctl.state().translateHere, "available");
});

test("总开关关掉即摘监听且不再给按钮；开关回来时用户的选择还在；排除域名同样生效", async () => {
  const ctl = await startTracking({ url: URL_, extract: () => null });
  ctl.translateHere();
  assert.equal(mouseups, 1);

  push({ ...DEFAULT_SETTINGS, translateEnabled: false });
  assert.equal(mouseups, 0);
  assert.equal(ctl.state().translateHere, undefined);

  push({ ...DEFAULT_SETTINGS, translateEnabled: true });
  assert.equal(mouseups, 1);
  assert.equal(ctl.state().translateHere, "on");

  push({ ...DEFAULT_SETTINGS, excludedDomains: ["example.com"] });
  assert.equal(mouseups, 0);
  assert.deepEqual(ctl.state(), { tracked: false, reason: "app.example.com 在排除列表中" });
  ctl.stop();
});

test("总开关本来就关着的页面不给按钮", async () => {
  (g["chrome"] as { storage: { local: { get: () => Promise<unknown> } } }).storage.local.get = async () => ({
    settings: { ...DEFAULT_SETTINGS, translateEnabled: false },
  });
  const ctl = await startTracking({ url: URL_, extract: () => null });
  assert.deepEqual(ctl.state(), { tracked: false, reason: "未识别为文章页" });
  ctl.translateHere(); // 点了也不该挂：总开关的语义是「根本不挂选区监听」
  assert.equal(mouseups, 0);
  ctl.stop();
});
