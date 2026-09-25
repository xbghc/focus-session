import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { Settings } from "../src/types.ts";
import { DEFAULT_SETTINGS } from "../src/types.ts";

/*
 * 划词翻译插件在一个页面上挂不挂选区监听：只看翻译自己的设置（总开关、白名单）和用户在本页点没点过，
 * 和这一页是不是文章、记不记专注无关。这里盯的就是这张状态表，以及设置热更新和收摊。
 */

const URL_ = "https://app.example.com/inbox";
const dom = new JSDOM("<!doctype html><html><head><title>某个网页应用</title></head><body><p>hello</p></body></html>", { url: URL_ });
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
let stored: Partial<Settings> = {};
let release: (() => void) | null = null;
let hold = false;

g["chrome"] = {
  storage: {
    local: {
      get: () => hold
        ? new Promise((r) => { release = () => r({ settings: stored }); })
        : Promise.resolve({ settings: stored }),
    },
    onChanged: {
      addListener: (fn: Changed) => {
        onChanged = fn;
      },
      // 收摊时要摘掉，否则总开关一变，停掉的翻译器又会被拉起来
      removeListener: (fn: Changed) => {
        if (onChanged === fn) onChanged = null;
      },
    },
  },
  runtime: {
    sendMessage: async () => undefined,
    getURL: (p: string) => `chrome-extension://test/${p}`,
  },
};

const { translationPlugin } = await import("../src/features/translation/page.ts");
const tick = () => new Promise((r) => setImmediate(r));

async function start(settings: Partial<Settings>, opts: Parameters<typeof translationPlugin>[0] = {}, carried?: boolean) {
  stored = { ...DEFAULT_SETTINGS, ...settings };
  const f = translationPlugin(opts).start({
    url: URL_,
    signal: new AbortController().signal,
    info: { title: () => document.title, setTitle: () => undefined },
    changed: () => undefined,
  }, carried);
  await tick();
  return f;
}

test("不在白名单：只是「可用」，点了才挂监听，停了就摘掉", async () => {
  const f = await start({});
  assert.deepEqual(f.state(), { screenshot: "available", translateHere: "available" });
  assert.equal(mouseups, 0);
  f.translateHere();
  assert.deepEqual(f.state(), { screenshot: "available", translateHere: "on" });
  assert.equal(mouseups, 1);
  f.translateHere(); // 再点一次不叠加
  assert.equal(mouseups, 1);
  f.stop();
  assert.equal(mouseups, 0);
  assert.equal(onChanged, null, "设置监听要跟着摘掉");
  f.translateHere(); // 收摊之后再点不该把翻译器拉起来
  assert.equal(mouseups, 0);
  assert.deepEqual(f.state(), {});
});

test("命中白名单：自动挂、不给入口；运行中拿掉就回到手动，加回来又自动挂", async () => {
  const f = await start({ translationAllowedUrls: ["example.com"] });
  assert.deepEqual(f.state(), { screenshot: "available" });
  assert.equal(mouseups, 1);

  push({ ...DEFAULT_SETTINGS });
  assert.equal(mouseups, 0, "用户没在本页点过，拿出白名单就该摘");
  assert.equal(f.state().translateHere, "available");

  push({ ...DEFAULT_SETTINGS, translationAllowedUrls: ["https://app.example.com/inbox"] });
  assert.equal(mouseups, 1, "完整网址规则同样认");
  f.stop();
  assert.equal(mouseups, 0);
});

test("白名单外点过「本页启用」的，拿进又拿出白名单都还开着", async () => {
  const f = await start({});
  f.translateHere();
  push({ ...DEFAULT_SETTINGS, translationAllowedUrls: ["app.example.com"] });
  push({ ...DEFAULT_SETTINGS });
  assert.equal(mouseups, 1);
  assert.equal(f.state().translateHere, "on");
  f.stop();
});

test("总开关关掉即摘监听且不再给按钮；开关回来时用户的选择还在", async () => {
  const f = await start({});
  f.translateHere();
  assert.equal(mouseups, 1);
  push({ ...DEFAULT_SETTINGS, translateEnabled: false });
  assert.equal(mouseups, 0);
  assert.deepEqual(f.state(), { screenshot: "available" });
  push({ ...DEFAULT_SETTINGS });
  assert.equal(mouseups, 1);
  assert.equal(f.state().translateHere, "on");
  f.stop();
});

test("总开关本来就关着：白名单里也不挂，不给按钮，点了也不挂", async () => {
  const f = await start({ translateEnabled: false, translationAllowedUrls: ["example.com"] });
  assert.deepEqual(f.state(), { screenshot: "available" });
  f.translateHere();
  assert.equal(mouseups, 0);
  f.stop();
});

test("和专注记录各判各的：文章记录黑名单不影响翻译", async () => {
  const f = await start({ articleExcludedUrls: ["example.com"], translationAllowedUrls: ["example.com"] });
  assert.equal(mouseups, 1);
  f.stop();
});

test("App 阅读器（autoEnable）：不看白名单，总开关开着就挂", async () => {
  const f = await start({}, { autoEnable: true });
  assert.deepEqual(f.state(), { screenshot: "available" });
  assert.equal(mouseups, 1);
  push({ ...DEFAULT_SETTINGS, translateEnabled: false });
  assert.equal(mouseups, 0);
  f.stop();
});

test("bfcache 回来带着「本页启用」：新一轮一读完设置就挂上", async () => {
  const f = await start({}, {}, true);
  assert.equal(f.state().translateHere, "on");
  assert.equal(mouseups, 1);
  f.stop();
});

test("设置还没读回来就收摊：读回来也不挂", async () => {
  hold = true;
  try {
    const f = await start({ translationAllowedUrls: ["example.com"] });
    assert.deepEqual(f.state(), { screenshot: "available" }, "设置没到之前不给入口");
    f.stop();
    release!();
    await tick();
    assert.equal(mouseups, 0);
  } finally {
    hold = false;
  }
});
