import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { DEFAULT_SETTINGS } from "../src/types.ts";
import type { OcrReply, Settings, TranslateRequest } from "../src/types.ts";
import { SelectionTranslator } from "../src/features/translation/selection.ts";
import { translationPlugin, type TranslationFeature } from "../src/features/translation/page.ts";

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
let controller: TranslationFeature | null = null;
/** 这一页的划词翻译插件，等它把设置读回来。 */
async function startTranslation(): Promise<TranslationFeature> {
  const f = translationPlugin().start({
    url: location.href, signal: new AbortController().signal,
    info: { title: () => document.title, setTitle: () => undefined },
    changed: () => undefined,
  });
  await tick();
  return f;
}

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

test("总开关关闭仍能截图，预热不等回复，失败浮层可关闭且不启用划词", async () => {
  settings.translateEnabled = false;
  controller = await startTranslation();
  assert.equal(controller.state().screenshot, "available");
  controller.screenshot(); await tick();
  assert.deepEqual(messages.map((m) => m.type), ["ocr:warm", "page:capture"]);
  assert.match(root()!.textContent!, /截图失败/);
  assert.equal(controller.state().translateHere, undefined); assert.equal(count("mouseup"), 0);
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(root(), undefined); assert.equal(count("keydown"), 0);
});

test("截图翻译不看白名单、也不看文章记录黑名单：每次都是用户亲手框的", async () => {
  settings.articleExcludedUrls = ["example.com"];
  controller = await startTranslation();
  assert.equal(controller.state().screenshot, "available");
  controller.screenshot(); await tick(); assert.ok(root());
});

test("收摊之后截图是空操作，也不再给截图字段", async () => {
  controller = await startTranslation();
  controller.stop();
  controller.screenshot(); await tick();
  assert.equal(messages.length, 0); assert.equal(controller.state().screenshot, undefined);
});

test("停止控制器会作废迟到的截图失败", async () => {
  let finish!: (value: unknown) => void;
  capture = () => new Promise((r) => { finish = r; });
  controller = await startTranslation();
  controller.screenshot(); controller.stop();
  finish({ ok: false, error: "迟到" }); await tick(); assert.equal(root(), undefined);
});

test("截图失败锚在视口顶部中央的 200×0 矩形；滚一下不关，Esc 才关", async () => {
  const { Popover } = await import("../src/features/translation/popover.ts");
  const original = Popover.prototype.showError;
  let anchor: DOMRect | undefined;
  Popover.prototype.showError = function(r, error, config) { anchor = r; original.call(this, r, error, config); };
  try {
    translator.showCaptureError("无法截图");
    assert.deepEqual(anchor!.toJSON(), new DOMRect(412, 0, 200, 0).toJSON());
    document.dispatchEvent(new dom.window.Event("scroll"));
    assert.ok(root(), "滚动本身不关浮层"); assert.equal(count("scroll"), 1);
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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
    controller = await startTranslation();
    controller.screenshot(); await tick();
    const overlay = document.getElementById("focus-session-screenshot")!;
    assert.ok(overlay);
    for (const [type, x, y] of [["pointerdown", 10, 20], ["pointerup", 100, 60]] as const) {
      const e = new dom.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
      Object.defineProperty(e, "pointerId", { value: 1 }); overlay.dispatchEvent(e);
    }
    await tick();
    assert.equal(document.getElementById("focus-session-screenshot"), null);
    // 收尾时轨迹也送去后台。这个环境没有 rAF，complete() 一到就同步收束，所以它紧跟在识别之后
    assert.deepEqual(messages.map((m) => m.type), ["ocr:warm", "page:capture", "ocr:recognize", "translation:trace"]);
    const trace = (messages.at(-1) as unknown as { trace: { source: string; text: string; kind: string } }).trace;
    assert.equal(trace.source, "image"); assert.equal(trace.text, "hello world"); assert.equal(trace.kind, "phrase");
    assert.deepEqual(requests, [{ articleId: "https://app.example.com/inbox", url: location.href, articleTitle: "页面标题",
      text: "hello world", context: "hello world", kind: "phrase", explainVocab: true }]);
    assert.equal(controller.state().translateHere, "available"); assert.equal(count("mouseup"), 0);
  } finally {
    g["createImageBitmap"] = oldBitmap; g["OffscreenCanvas"] = oldCanvas;
    dom.window.HTMLCanvasElement.prototype.getContext = oldContext;
    dom.window.Element.prototype.setPointerCapture = oldCapture;
  }
});

test("浮层里正选着字时，页面上松手引起的选区判定不关浮层", async () => {
  const { Popover } = await import("../src/features/translation/popover.ts");
  const original = Popover.prototype.holdsSelection;
  let holding = true;
  Popover.prototype.holdsSelection = function() { return holding; };
  const settle = () => new Promise<void>((r) => setTimeout(r, 200));
  try {
    translator.start();
    const pending = translator.translateImage("png", rect);
    reply({ ok: true, text: "hello" }); await pending;
    assert.ok(root());
    // 拖选拖出了浮层的边，松手落在页面上：这一下会走一遍选区判定，可人选的字在浮层里，不能关
    document.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
    await settle();
    assert.ok(root(), "浮层里还选着字，不能关");
    holding = false;
    document.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
    await settle();
    assert.equal(root(), undefined, "浮层里没选着、页面上也没选中：照旧关掉");
  } finally {
    Popover.prototype.holdsSelection = original;
  }
});

test("滚动、resize 时浮层看不见了才关；追问中、浮层里选着字时不关", async () => {
  const { Popover } = await import("../src/features/translation/popover.ts");
  const follow = Popover.prototype.followAnchor;
  const asking = Object.getOwnPropertyDescriptor(Popover.prototype, "asking")!;
  const holds = Popover.prototype.holdsSelection;
  let visible = true;
  let isAsking = false;
  let holding = false;
  Popover.prototype.followAnchor = function() { return visible; };
  Object.defineProperty(Popover.prototype, "asking", { get: () => isAsking, configurable: true });
  Popover.prototype.holdsSelection = function() { return holding; };
  const open = async (): Promise<void> => {
    const pending = translator.translateImage("png", rect);
    reply({ ok: true, text: "hello" }); await pending;
    assert.ok(root());
  };
  const scroll = (): void => void document.dispatchEvent(new dom.window.Event("scroll"));
  try {
    await open();
    scroll();
    assert.ok(root(), "还看得见就留着");
    visible = false; isAsking = true;
    scroll();
    assert.ok(root(), "追问中不关");
    isAsking = false; holding = true;
    scroll();
    assert.ok(root(), "浮层里选着字不关");
    holding = false;
    scroll();
    assert.equal(root(), undefined, "看不见了就关");
    assert.equal(count("scroll"), 0, "没开划词时关闭组一起摘掉");
    visible = true;
    await open();
    visible = false;
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(root(), undefined, "resize 同样查一次");
  } finally {
    Popover.prototype.followAnchor = follow;
    Object.defineProperty(Popover.prototype, "asking", asking);
    Popover.prototype.holdsSelection = holds;
  }
});

test("中键、按在页面滚动条上不算点到别处；主键按在页面上照旧关", async () => {
  const pending = translator.translateImage("png", rect);
  reply({ ok: true, text: "hello" }); await pending;
  document.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 1 }));
  assert.ok(root(), "中键是自动滚动");
  const de = document.documentElement;
  Object.defineProperty(de, "clientWidth", { value: 1000, configurable: true });
  Object.defineProperty(de, "clientHeight", { value: 700, configurable: true });
  try {
    de.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 1005, clientY: 300 }));
    assert.ok(root(), "按在页面滚动条上是在滚");
    de.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 500, clientY: 300 }));
    assert.equal(root(), undefined, "按在页面内容上照旧关");
  } finally {
    Reflect.deleteProperty(de, "clientWidth");
    Reflect.deleteProperty(de, "clientHeight");
  }
});

test("右键、中键松开不判选区：开着的浮层不因此关掉；主键松开照常判", async () => {
  const proto = dom.window.Range.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
  proto.getBoundingClientRect = () => new DOMRect(10, 10, 50, 20);
  const settle = () => new Promise<void>((r) => setTimeout(r, 200));
  const up = (button: number): void => void document.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, button }));
  try {
    translator.start();
    const r = document.createRange();
    r.selectNodeContents(document.querySelector("p")!);
    const sel = dom.window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    up(0); await settle();
    assert.equal(requests.length, 1);
    sel.removeAllRanges(); // 中键按下会把页面选区清掉
    up(1); up(2); await settle();
    assert.ok(root(), "不是主键松开，不去判选区");
    up(0); await settle();
    assert.equal(root(), undefined, "主键松开照常判：选区没了就关");
  } finally {
    if (original) Object.defineProperty(proto, "getBoundingClientRect", original);
    else Reflect.deleteProperty(proto, "getBoundingClientRect");
  }
});

test("页面上没有选区时，不按 shift 的方向键（滚页面、挪光标）不去判选区；按着 shift 照常判", async () => {
  const settle = () => new Promise<void>((r) => setTimeout(r, 200));
  const arrow = (shiftKey: boolean): void =>
    void document.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "ArrowDown", shiftKey, bubbles: true }));
  translator.start();
  const pending = translator.translateImage("png", rect);
  reply({ ok: true, text: "hello" }); await pending;
  dom.window.getSelection()!.removeAllRanges();
  arrow(false); await settle();
  assert.ok(root(), "没有选区、没按 shift：是在滚页面，不判");
  arrow(true); await settle();
  assert.equal(root(), undefined, "按着 shift：照常判，选区是空的就关");
});

test("选区没变的 keyup 不重建浮层；选区变了照常重翻", async () => {
  const proto = dom.window.Range.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
  proto.getBoundingClientRect = () => new DOMRect(10, 10, 50, 20);
  const settle = () => new Promise<void>((r) => setTimeout(r, 200));
  const text = document.querySelector("p")!.firstChild!;
  const select = (end: number): void => {
    const r = document.createRange();
    r.setStart(text, 0);
    r.setEnd(text, end);
    const sel = dom.window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  };
  const arrow = (): void => void document.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true }));
  try {
    translator.start();
    select(5); arrow(); await settle();
    assert.equal(requests.length, 1);
    const host = document.getElementById("focus-session-popover");
    assert.ok(host);
    arrow(); await settle();
    assert.equal(requests.length, 1, "方向键滚页面，选区没变：不重翻");
    assert.equal(document.getElementById("focus-session-popover"), host, "浮层没被拆了重建");
    select(4); arrow(); await settle();
    assert.equal(requests.length, 2, "选区变了照常翻");
  } finally {
    if (original) Object.defineProperty(proto, "getBoundingClientRect", original);
    else Reflect.deleteProperty(proto, "getBoundingClientRect");
  }
});
