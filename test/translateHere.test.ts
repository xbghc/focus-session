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
  "<!doctype html><html><head><title>某个网页应用</title></head><body><p>hello</p>" +
    // 文章页那几个用例的正文：命中翻译黑名单的文章页也要能暂时开启
    '<div id="art"><p>The river kept its own time and never once asked us for ours.</p></div></body></html>',
  { url: "https://app.example.com/inbox" },
);
const g = globalThis as Record<string, unknown>;
g["document"] = dom.window.document;
g["window"] = dom.window;
g["Node"] = dom.window.Node;
g["Element"] = dom.window.Element;
g["location"] = dom.window.location; // 文章页那条路跳回上次位置时要看 location.hash
/** 段落追踪器要一个 IntersectionObserver。这里不关心谁在视口里，给个空壳。 */
g["IntersectionObserver"] = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

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
      // 收摊时要摘掉，否则总开关一变，停掉的翻译器又会被拉起来
      removeListener: (fn: Changed) => {
        if (onChanged === fn) onChanged = null;
      },
    },
  },
  runtime: {
    sendMessage: async () => ({ ok: true, isArticle: false, reason: "未识别为文章页" }),
    getURL: (p: string) => `chrome-extension://test/${p}`,
  },
};

const { startTracking } = await import("../src/content/track.ts");
const { extractFromContainer } = await import("../src/content/paragraphs.ts");
const URL_ = "https://app.example.com/inbox";
type ChromeMock = { storage: { local: { get: () => Promise<unknown> } }; runtime: { sendMessage: (msg: { type?: string }) => Promise<unknown> } };
/** 文章页的正文：从 #art 里取，和 App 阅读器那条路一样不跑 Readability。 */
const article = () => extractFromContainer(doc.getElementById("art")!, "渡口");

test("抽不出正文：不追踪，划词翻译只是「可用」，点了才挂监听，停了就摘掉", async () => {
  const ctl = await startTracking({ url: URL_, extract: () => null });
  assert.deepEqual(ctl.state(), { tracked: false, reason: "未识别为文章页", translateHere: "available", screenshot: "available" });
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

  push({ ...DEFAULT_SETTINGS, translationExcludedUrls: ["example.com"] });
  assert.equal(mouseups, 0);
  // 黑名单挡住了，但入口还在：点一下是「暂时无视黑名单」，截图翻译跟着放开
  assert.deepEqual(ctl.state(), { tracked: false, reason: "命中翻译黑名单；未识别为文章页", translationExcluded: true, translateHere: "available" });
  ctl.translateHere();
  assert.equal(mouseups, 1);
  assert.deepEqual(ctl.state(), { tracked: false, reason: "命中翻译黑名单；未识别为文章页", translationExcluded: true, translateHere: "on", screenshot: "available" });
  ctl.stop();
  assert.equal(mouseups, 0);
});

test("总开关本来就关着的页面不给按钮", async () => {
  (g["chrome"] as { storage: { local: { get: () => Promise<unknown> } } }).storage.local.get = async () => ({
    settings: { ...DEFAULT_SETTINGS, translateEnabled: false },
  });
  const ctl = await startTracking({ url: URL_, extract: () => null });
  assert.deepEqual(ctl.state(), { tracked: false, reason: "未识别为文章页", screenshot: "available" });
  ctl.translateHere(); // 点了也不该挂：总开关的语义是「根本不挂选区监听」
  assert.equal(mouseups, 0);
  ctl.stop();
});


test("文章黑名单不会禁用非文章页翻译", async () => {
  (g["chrome"] as { storage: { local: { get: () => Promise<unknown> } } }).storage.local.get = async () => ({
    settings: { ...DEFAULT_SETTINGS, articleExcludedUrls: ["app.example.com"] },
  });
  const ctl = await startTracking({ url: URL_, extract: () => null });
  assert.equal(ctl.state().tracked, false);
  assert.equal(ctl.state().screenshot, "available");
  ctl.translateHere();
  assert.equal(ctl.state().translateHere, "on");
  ctl.stop();
});


test("LLM 等待期间可开启翻译，判为非文章后保留开启状态", async () => {
  const chromeMock = g["chrome"] as { storage: { local: { get: () => Promise<unknown> } }; runtime: { sendMessage: () => Promise<unknown> } };
  chromeMock.storage.local.get = async () => ({ settings: DEFAULT_SETTINGS });
  let respond!: (v: unknown) => void;
  chromeMock.runtime.sendMessage = () => new Promise(resolve => { respond = resolve; });
  let pending!: Awaited<ReturnType<typeof startTracking>>;
  const ready = startTracking({ url: URL_, extract: () => null, onPending: value => { pending = value; } });
  await new Promise(resolve => setImmediate(resolve));
  pending.translateHere();
  assert.equal(pending.state().translateHere, "on");
  respond({ ok: true, isArticle: false, reason: "聊天界面" });
  const controller = await ready;
  assert.equal(controller.state().tracked, false);
  assert.equal(controller.state().translateHere, "on");
  assert.equal(mouseups, 1);
  controller.stop();
  assert.equal(mouseups, 0);
});

test("一开始就命中翻译黑名单的非文章页：入口照给，点了才挂、截图翻译跟着放开；从黑名单拿掉后用户的选择还在", async () => {
  const chromeMock = g["chrome"] as ChromeMock;
  chromeMock.storage.local.get = async () => ({ settings: { ...DEFAULT_SETTINGS, translationExcludedUrls: ["app.example.com"] } });
  chromeMock.runtime.sendMessage = async () => ({ ok: true, isArticle: false, reason: "未识别为文章页" });
  const ctl = await startTracking({ url: URL_, extract: () => null });
  assert.deepEqual(ctl.state(), { tracked: false, reason: "命中翻译黑名单；未识别为文章页", translationExcluded: true, translateHere: "available" });
  assert.equal(mouseups, 0);

  ctl.translateHere();
  assert.equal(mouseups, 1);
  assert.deepEqual(ctl.state(), { tracked: false, reason: "命中翻译黑名单；未识别为文章页", translationExcluded: true, translateHere: "on", screenshot: "available" });

  // 从黑名单里拿掉：还开着——和总开关关了又开一样，用户这次的选择不丢
  push({ ...DEFAULT_SETTINGS });
  assert.equal(mouseups, 1);
  assert.deepEqual(ctl.state(), { tracked: false, reason: "未识别为文章页", translateHere: "on", screenshot: "available" });

  ctl.stop();
  assert.equal(mouseups, 0);
});

test("命中翻译黑名单的文章页：默认不挂但给「暂时开启」入口，点了才挂、截图翻译跟着放开；再被加进黑名单就作废", async () => {
  const chromeMock = g["chrome"] as ChromeMock;
  chromeMock.storage.local.get = async () => ({ settings: { ...DEFAULT_SETTINGS, translationExcludedUrls: ["app.example.com"] } });
  chromeMock.runtime.sendMessage = async () => ({ ok: true, isArticle: true, reason: "是文章" });
  const ctl = await startTracking({ url: URL_, extract: article });
  const st = ctl.state();
  assert.equal(st.tracked, true);
  assert.equal(st.translationExcluded, true);
  assert.equal(st.translateHere, "available");
  assert.equal(st.screenshot, undefined, "没放行之前不该画一个点了没反应的截图按钮");
  assert.equal(mouseups, 0);

  ctl.translateHere();
  assert.equal(ctl.state().translateHere, "on");
  assert.equal(ctl.state().screenshot, "available");
  assert.equal(mouseups, 1);
  ctl.translateHere(); // 再点一次不叠加
  assert.equal(mouseups, 1);

  // 从黑名单里拿掉：文章页本来就该挂着，入口也就不必再给
  push({ ...DEFAULT_SETTINGS });
  assert.equal(mouseups, 1);
  assert.equal(ctl.state().translateHere, undefined);
  assert.equal(ctl.state().translationExcluded, undefined);
  assert.equal(ctl.state().screenshot, "available");

  // 又加回去：比「暂时开启」更新的一次选择，这次的开启作废，得再点一次
  push({ ...DEFAULT_SETTINGS, translationExcludedUrls: ["app.example.com"] });
  assert.equal(mouseups, 0);
  assert.equal(ctl.state().translateHere, "available");
  assert.equal(ctl.state().screenshot, undefined);
  ctl.translateHere();
  assert.equal(mouseups, 1);

  ctl.stop();
  assert.equal(mouseups, 0);
  ctl.translateHere(); // 收摊之后再点不该把翻译器拉起来
  assert.equal(mouseups, 0);
});

test("命中黑名单的文章页上总开关关着：不给入口，点了也不挂", async () => {
  const chromeMock = g["chrome"] as ChromeMock;
  chromeMock.storage.local.get = async () => ({
    settings: { ...DEFAULT_SETTINGS, translateEnabled: false, translationExcludedUrls: ["app.example.com"] },
  });
  chromeMock.runtime.sendMessage = async () => ({ ok: true, isArticle: true, reason: "是文章" });
  const ctl = await startTracking({ url: URL_, extract: article });
  assert.equal(ctl.state().tracked, true);
  assert.equal(ctl.state().translationExcluded, true);
  assert.equal(ctl.state().translateHere, undefined);
  ctl.translateHere();
  assert.equal(mouseups, 0);
  ctl.stop();
});

test("LLM 判断期间在命中黑名单的页面暂时开启，判成文章后还开着", async () => {
  const chromeMock = g["chrome"] as ChromeMock;
  chromeMock.storage.local.get = async () => ({ settings: { ...DEFAULT_SETTINGS, translationExcludedUrls: ["app.example.com"] } });
  let respond!: (v: unknown) => void;
  chromeMock.runtime.sendMessage = (msg) => msg.type === "article:classify"
    ? new Promise(resolve => { respond = resolve; })
    : Promise.resolve({});
  let pending!: Awaited<ReturnType<typeof startTracking>>;
  const ready = startTracking({ url: URL_, extract: article, onPending: value => { pending = value; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.state().translateHere, "available");
  pending.translateHere();
  assert.equal(pending.state().translateHere, "on");
  assert.equal(mouseups, 1);

  respond({ ok: true, isArticle: true, reason: "是文章" });
  const controller = await ready;
  assert.equal(controller.state().tracked, true);
  assert.equal(controller.state().translateHere, "on");
  assert.equal(controller.state().screenshot, "available");
  assert.equal(mouseups, 1, "判断期间那个翻译器要收掉、文章页的挂上，页面上始终只有一份");
  controller.stop();
  assert.equal(mouseups, 0);
});
