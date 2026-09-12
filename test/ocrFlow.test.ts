import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { DEFAULT_SETTINGS } from "../src/types.ts";
import type { OcrReply, Settings, TranslateRequest } from "../src/types.ts";
import { SelectionTranslator } from "../src/content/selection.ts";
import { startTracking } from "../src/content/track.ts";

const dom = new JSDOM("<!doctype html><html><head><title>页面标题</title></head><body><p>hello</p></body></html>", { url: "https://app.example.com/inbox" });
const g = globalThis as Record<string, unknown>;
Object.assign(g, { document: dom.window.document, window: dom.window, DOMRect: dom.window.DOMRect,
  Node: dom.window.Node, Element: dom.window.Element, location: dom.window.location });
const attach = dom.window.Element.prototype.attachShadow;
dom.window.Element.prototype.attachShadow = function(init) { return attach.call(this, { ...init, mode: "open" }); };
const listeners = new Map<string, Set<EventListener>>();
const add = document.addEventListener.bind(document);
const remove = document.removeEventListener.bind(document);
document.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
  if (!["mouseover", "mouseout", "load"].includes(type)) {
    const set = listeners.get(type) ?? new Set<EventListener>(); set.add(fn); listeners.set(type, set);
  }
  add(type, fn, opts);
}) as typeof document.addEventListener;
document.removeEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
  listeners.get(type)?.delete(fn); remove(type, fn, opts);
}) as typeof document.removeEventListener;
const count = (type: string) => listeners.get(type)?.size ?? 0;
const tick = () => new Promise<void>((r) => setImmediate(r));
const root = () => document.getElementById("focus-session-popover")?.shadowRoot;
const rect = new DOMRect(30, 40, 100, 50);
let settings: Settings;
let translator: SelectionTranslator;
let requests: TranslateRequest[];
let reply: (r: OcrReply) => void;
let signal: AbortSignal;
let recognized: string[];
let messages: Array<{ type: string }>;
let changed: ((changes: Record<string, { newValue: Settings }>, area: string) => void) | null;
let capture: () => Promise<unknown>;
let controller: Awaited<ReturnType<typeof startTracking>> | null = null;

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS }; requests = []; recognized = []; messages = []; changed = null;
  capture = async () => ({ ok: false, error: "截图失败" });
  g["chrome"] = {
    runtime: {
      getURL: (p: string) => `chrome-extension://test/${p}`,
      sendMessage: async (msg: { type: string }) => { if (msg.type === "article:classify") return { ok: true, isArticle: false, reason: "非文章" }; messages.push(msg); return msg.type === "page:capture" ? await capture() : undefined; },
    },
    storage: {
      local: { get: async () => ({ settings }) },
      onChanged: {
        addListener: (fn: typeof changed) => { changed = fn; },
        removeListener: (fn: typeof changed) => { if (changed === fn) changed = null; },
      },
    },
  };
  translator = new SelectionTranslator({
    articleId: "article", url: "https://app.example.com/inbox", articleTitle: "页面标题",
    settings: () => settings, contextOf: () => "不应使用网页段落",
    recognize: (png, s) => { recognized.push(png); signal = s; return new Promise((r) => { reply = r; }); },
    translate: async (req, partial) => {
      requests.push(req);
      partial({ translation: "译文", phonetic: null, pos: null, contextNote: null, usage: null, vocab: [] });
      return { ok: true, cached: false, snippet: { ...req, id: "snippet", createdTs: 0, translation: "译文", contextNote: "",
        phonetic: null, pos: null, lemma: null, usage: null, vocab: [], cardId: null } };
    },
    ask: async () => ({ ok: true, text: "追问答案" }), warm: () => {}, openOptions: () => {},
  });
});
afterEach(() => {
  translator.stop(); controller?.stop(); controller = null;
  for (const [type, set] of listeners) assert.equal(set.size, 0, `${type} 监听泄漏`);
  assert.equal(root(), undefined);
});

test("未 start 的 OCR 只挂关闭组，识别后使用同一骨架并保留追问入口", async () => {
  settings.explainVocab = false;
  const pending = translator.translateImage("png", rect);
  assert.deepEqual(recognized, ["png"]);
  assert.equal(count("mouseup"), 0); assert.equal(count("keyup"), 0);
  for (const type of ["mousedown", "scroll", "keydown"]) assert.equal(count(type), 1);
  assert.match(root()!.querySelector(".term")!.textContent!, /正在识别图中文字/);
  const tr = root()!.querySelector(".tr");
  reply({ ok: true, text: "  hello\nworld  " }); await pending;
  assert.deepEqual(requests, [{ articleId: "article", url: "https://app.example.com/inbox", articleTitle: "页面标题",
    text: "hello world", context: "hello world", kind: "phrase", explainVocab: false }]);
  assert.equal(root()!.querySelector(".tr"), tr);
  assert.ok(root()!.querySelector('[data-act="ask"]'));
  document.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
  assert.equal(root(), undefined); assert.equal(count("keydown"), 0);
});

for (const [text, kind] of [["hello", "word"], ["This is a complete English sentence.", "sentence"]]) test(`OCR 按词数判定 ${kind}`, async () => {
  const pending = translator.translateImage("png", rect);
  reply({ ok: true, text: text! }); await pending;
  assert.equal(requests[0]!.kind, kind); assert.equal(requests[0]!.explainVocab, true);
});

test("长文本先确认，按钮点击后才翻译", async () => {
  settings.maxAutoSelectionWords = 2;
  const pending = translator.translateImage("png", rect);
  reply({ ok: true, text: "one two three" }); await pending;
  assert.equal(requests.length, 0);
  assert.match(root()!.textContent!, /识别出 3 个词，较长，确认后再翻译/);
  root()!.querySelector<HTMLElement>('[data-act="go"]')!.click(); await tick();
  assert.equal(requests.length, 1); assert.equal(requests[0]!.context, "one two three");
});

for (const [answer, error] of [
  [{ ok: false, error: "识别器失败" }, "识别器失败"],
  [{ ok: true, text: "只有中文" }, "没认出英文"],
  [{ ok: true, text: "" }, "没认出英文"],
  [{ ok: true, text: "a".repeat(2001) }, "识别文字过长"],
] as const) test(`识别错误：${error}`, async () => {
  const pending = translator.translateImage("png", rect); reply(answer); await pending;
  assert.ok(root()!.textContent!.includes(error)); assert.equal(requests.length, 0);
  assert.equal(root()!.querySelector('[data-act="opt"]'), null);
});

test("Esc 作废迟到的识别并摘掉关闭组", async () => {
  const pending = translator.translateImage("png", rect);
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(signal.aborted, true); assert.equal(count("keydown"), 0);
  reply({ ok: true, text: "late" }); await pending;
  assert.equal(root(), undefined); assert.equal(requests.length, 0);
});

test("第二次 OCR 让第一次结果过期", async () => {
  const first = translator.translateImage("first", rect); const oldReply = reply; const oldSignal = signal;
  const second = translator.translateImage("second", rect);
  assert.equal(oldSignal.aborted, true);
  oldReply({ ok: true, text: "old" }); await first; assert.equal(requests.length, 0);
  reply({ ok: true, text: "new" }); await second; assert.equal(requests[0]!.text, "new");
});

test("已 start 时 dismiss 保留两组监听，stop 才一起摘掉", async () => {
  translator.start(); translator.start();
  const pending = translator.translateImage("png", rect);
  translator.dismiss();
  assert.equal(count("mouseup"), 1); assert.equal(count("keydown"), 1);
  reply({ ok: true, text: "late" }); await pending;
  translator.stop(); assert.equal(count("mouseup"), 0); assert.equal(count("keydown"), 0);
});

test("非文章页总开关关闭仍能截图，预热不等回复，失败浮层可关闭且不启用划词", async () => {
  settings.translateEnabled = false;
  controller = await startTracking({ url: location.href, extract: () => null });
  assert.equal(controller.state().screenshot, "available");
  controller.screenshot(); await tick();
  assert.deepEqual(messages.map((m) => m.type), ["ocr:warm", "page:capture"]);
  assert.match(root()!.textContent!, /截图失败/);
  assert.equal(controller.state().translateHere, undefined); assert.equal(count("mouseup"), 0);
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(root(), undefined); assert.equal(count("keydown"), 0);
});

test("非文章页运行中排除后截图无操作，也不再给截图字段", async () => {
  controller = await startTracking({ url: location.href, extract: () => null });
  controller.screenshot(); await tick(); assert.ok(root());
  changed!({ settings: { newValue: { ...settings, translationExcludedUrls: ["example.com"] } } }, "local");
  assert.equal(root(), undefined);
  const n = messages.length; controller.screenshot(); await tick();
  assert.equal(messages.length, n); assert.equal(controller.state().screenshot, undefined);
});

test("初始排除域名的 idle 控制器截图是空操作", async () => {
  settings.articleExcludedUrls = ["example.com"];
  settings.translationExcludedUrls = ["example.com"];
  controller = await startTracking({ url: location.href, extract: () => null });
  controller.screenshot(); await tick();
  assert.equal(messages.length, 0); assert.equal(controller.state().screenshot, undefined);
});

test("停止控制器会作废迟到的截图失败", async () => {
  let finish!: (value: unknown) => void;
  capture = () => new Promise((r) => { finish = r; });
  controller = await startTracking({ url: location.href, extract: () => null });
  controller.screenshot(); controller.stop();
  finish({ ok: false, error: "迟到" }); await tick(); assert.equal(root(), undefined);
});

test("截图失败锚在视口顶部中央的 200×0 矩形", async () => {
  const { Popover } = await import("../src/content/popover.ts");
  const original = Popover.prototype.showError;
  let anchor: DOMRect | undefined;
  Popover.prototype.showError = function(r, error, config) { anchor = r; original.call(this, r, error, config); };
  try {
    translator.showCaptureError("无法截图");
    assert.deepEqual(anchor!.toJSON(), new DOMRect(412, 0, 200, 0).toJSON());
    document.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(root(), undefined); assert.equal(count("scroll"), 0);
  } finally { Popover.prototype.showError = original; }
});

test("完整控制器路径：预热不等待、冻结帧裁剪、识别文本接回翻译 port，仍未开启划词", async () => {
  const oldBitmap = g["createImageBitmap"], oldCanvas = g["OffscreenCanvas"];
  const oldContext = dom.window.HTMLCanvasElement.prototype.getContext;
  const oldCapture = dom.window.Element.prototype.setPointerCapture;
  g["createImageBitmap"] = async () => ({ width: 1024, height: 768, close: () => {} });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => {} })) as unknown as typeof oldContext;
  dom.window.Element.prototype.setPointerCapture = () => {};
  class FakeCanvas {
    width: number; height: number;
    constructor(w: number, h: number) { this.width = w; this.height = h; }
    getContext() { return { drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }) }; }
    async convertToBlob() { return new Blob([new Uint8Array([1, 2, 3])]); }
  }
  g["OffscreenCanvas"] = FakeCanvas;
  const runtime = chrome.runtime;
  let delivered!: (m: unknown) => void;
  runtime.sendMessage = (async (msg: { type: string; png?: string }) => {
    if (msg.type === "article:classify") return { ok: true, isArticle: false, reason: "非文章" }; messages.push(msg);
    if (msg.type === "ocr:warm") return await new Promise(() => {});
    if (msg.type === "page:capture") return { ok: true, dataUrl: "data:image/png;base64,AA==" };
    if (msg.type === "ocr:recognize") { assert.equal(msg.png, "AQID"); return { ok: true, text: "hello world" }; }
    return undefined;
  }) as typeof runtime.sendMessage;
  runtime.connect = (() => ({
    onMessage: { addListener: (fn: typeof delivered) => { delivered = fn; } },
    onDisconnect: { addListener: () => {} }, disconnect: () => {},
    postMessage: (m: { req: TranslateRequest }) => { requests.push(m.req); delivered({ type: "done", res: { ok: false, error: "测试收尾", needsConfig: false } }); },
  })) as unknown as typeof runtime.connect;
  try {
    controller = await startTracking({ url: location.href, extract: () => null });
    controller.screenshot(); await tick();
    const overlay = document.getElementById("focus-session-screenshot")!;
    assert.ok(overlay);
    for (const [type, x, y] of [["pointerdown", 10, 20], ["pointerup", 100, 60]] as const) {
      const e = new dom.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
      Object.defineProperty(e, "pointerId", { value: 1 }); overlay.dispatchEvent(e);
    }
    await tick();
    assert.equal(document.getElementById("focus-session-screenshot"), null);
    assert.deepEqual(messages.map((m) => m.type), ["ocr:warm", "page:capture", "ocr:recognize"]);
    assert.deepEqual(requests, [{ articleId: "https://app.example.com/inbox", url: location.href, articleTitle: "页面标题",
      text: "hello world", context: "hello world", kind: "phrase", explainVocab: true }]);
    assert.equal(controller.state().translateHere, "available"); assert.equal(count("mouseup"), 0);
  } finally {
    g["createImageBitmap"] = oldBitmap; g["OffscreenCanvas"] = oldCanvas;
    dom.window.HTMLCanvasElement.prototype.getContext = oldContext;
    dom.window.Element.prototype.setPointerCapture = oldCapture;
  }
});
