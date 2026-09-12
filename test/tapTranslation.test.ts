import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { textRangeAtPoint } from "../src/content/tapTranslation.ts";
import { SelectionTranslator, paragraphContext } from "../src/content/selection.ts";
import { DEFAULT_SETTINGS, type TranslateRequest } from "../src/types.ts";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://example.com" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
  Element: dom.window.Element, DOMRect: dom.window.DOMRect,
  chrome: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } } });
// JSDOM 无排版引擎，用每字 10px 的行内布局模拟实际命中与空白。
const rect = new dom.window.DOMRect(0, 20, 100, 20);
dom.window.Range.prototype.getBoundingClientRect = () => rect;
dom.window.Range.prototype.getClientRects = function() {
  return [new dom.window.DOMRect(this.startOffset * 10, 20, 10, 20)] as unknown as DOMRectList;
};
let hitNode: Node;
(document as Document & { caretRangeFromPoint: (x: number, y: number) => Range }).caretRangeFromPoint = x => {
  const range = document.createRange();
  range.setStart(hitNode, Math.min(Math.floor(x / 10), hitNode.textContent!.length));
  range.collapse(true);
  return range;
};
let root: HTMLElement;
let translator: SelectionTranslator;
let requests: TranslateRequest[];
let signals: AbortSignal[];

beforeEach(() => {
  document.body.innerHTML = '<div id="article"><p>Hello <em>world</em>! Stay curious.</p><p>Next paragraph.</p><a href="#next">Link</a><button>Button</button><input value="Edit"></div><button id="outside">Outside</button>';
  root = document.getElementById("article")!;
  hitNode = root.querySelector("em")!.firstChild!;
  requests = [];
  signals = [];
  translator = new SelectionTranslator({
    tapRoot: root, articleId: "article", articleTitle: "Title", url: "https://example.com",
    settings: () => DEFAULT_SETTINGS, contextOf: paragraphContext,
    recognize: async () => ({ ok: false, error: "unused" }),
    translate: async (req, _partial, signal) => {
      requests.push(req);
      signals.push(signal);
      return new Promise(() => {});
    },
    ask: async () => ({ ok: true, text: "" }), warm: () => {}, openOptions: () => {},
  });
  translator.start();
});
afterEach(() => translator.stop());

function pointer(type: string, target: Element = hitNode.parentElement!, x = 15, extra: Record<string, unknown> = {}): void {
  const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 25, button: 0 });
  Object.defineProperties(event, Object.fromEntries(Object.entries({ pointerId: 1, isPrimary: true, pointerType: "touch", ...extra })
    .map(([key, value]) => [key, { value }])));
  target.dispatchEvent(event);
}
function tap(): void { pointer("pointerdown"); pointer("pointerup"); }

test("命中单词、跨内联标签的整句，并区分相邻句子与段落", () => {
  assert.equal(textRangeAtPoint(root, 15, 25, "word")?.toString(), "world");
  assert.equal(textRangeAtPoint(root, 15, 25, "sentence")?.toString(), "Hello world!");
  hitNode = root.querySelector("p")!.lastChild!;
  assert.equal(textRangeAtPoint(root, 35, 25, "sentence")?.toString(), "Stay curious.");
  hitNode = root.querySelectorAll("p")[1]!.firstChild!;
  assert.equal(textRangeAtPoint(root, 15, 25, "sentence")?.toString(), "Next paragraph.");
});

test("保留缩写撇号、连字符、跨内联节点的词，br 不拼成整句", () => {
  root.innerHTML = "<p>We can't re-<em>enter</em>.<br>Try again.</p>";
  hitNode = root.querySelector("p")!.firstChild!;
  assert.equal(textRangeAtPoint(root, 45, 25, "word")?.toString(), "can't");
  hitNode = root.querySelector("em")!.firstChild!;
  assert.equal(textRangeAtPoint(root, 15, 25, "word")?.toString(), "re-enter");
  hitNode = root.querySelector("p")!.lastChild!;
  assert.equal(textRangeAtPoint(root, 15, 25, "sentence")?.toString(), "Try again.");
});

test("空白、标点和正文外内容不触发点词", () => {
  assert.equal(textRangeAtPoint(root, 1000, 25, "word"), null);
  hitNode = root.querySelector("p")!.firstChild!;
  assert.equal(textRangeAtPoint(root, 55, 25, "word"), null);
  hitNode = root.querySelector("p")!.lastChild!;
  assert.equal(textRangeAtPoint(root, 5, 25, "word"), null);
  hitNode = document.getElementById("outside")!.firstChild!;
  assert.equal(textRangeAtPoint(root, 15, 25, "word"), null);
});

test("单击等待双击窗口后只请求单词，携带段落语境", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  tap();
  t.mock.timers.tick(149);
  assert.equal(requests.length, 0);
  t.mock.timers.tick(1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.text, "world");
  assert.equal(requests[0]!.kind, "word");
  assert.equal(requests[0]!.context, "Hello world! Stay curious.");
});

test("双击只请求当前句子，合成 mouseup / selectionchange 不重复翻译", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  tap();
  t.mock.timers.tick(100);
  tap();
  for (const type of ["mousedown", "mouseup", "click", "dblclick", "selectionchange"]) {
    hitNode.parentElement!.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true }));
  }
  t.mock.timers.tick(1000);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.text, "Hello world!");
  assert.equal(requests[0]!.kind, "sentence", "短句也不能进词组复习队列");
  assert.equal(signals[0]!.aborted, false);
});

test("第二次落指后不抢先发单词请求", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  tap();
  t.mock.timers.tick(140);
  pointer("pointerdown");
  t.mock.timers.tick(100);
  assert.equal(requests.length, 0);
  pointer("pointerup");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.kind, "sentence");
});

test("明确点击单字母 I 也翻译", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  root.innerHTML = "<p>I agree.</p>";
  hitNode = root.querySelector("p")!.firstChild!;
  pointer("pointerdown", hitNode.parentElement!, 5);
  pointer("pointerup", hitNode.parentElement!, 5);
  t.mock.timers.tick(150);
  assert.equal(requests[0]!.text, "I");
});

test("滚动、拖动、长按、取消手势和多指触摸不触发翻译", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  tap(); document.dispatchEvent(new dom.window.Event("scroll"));
  t.mock.timers.tick(500);
  pointer("pointerdown"); pointer("pointermove", hitNode.parentElement!, 40); pointer("pointerup");
  pointer("pointerdown"); t.mock.timers.tick(600); pointer("pointerup");
  pointer("pointerdown"); pointer("pointercancel"); pointer("pointerup");
  pointer("pointerdown"); pointer("pointerdown", hitNode.parentElement!, 15, { isPrimary: false, pointerId: 2 }); pointer("pointerup");
  t.mock.timers.tick(1000);
  assert.equal(requests.length, 0);
});

test("链接、按钮、输入框和点击外部不会触发待处理翻译", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const target of root.querySelectorAll("a, button, input")) {
    pointer("pointerdown", target); pointer("pointerup", target);
    t.mock.timers.tick(500);
  }
  tap();
  document.getElementById("outside")!.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
  t.mock.timers.tick(500);
  assert.equal(requests.length, 0);
});

test("停止时取消单击等待、卸载监听，重新启动不叠加请求", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  tap(); translator.stop(); t.mock.timers.tick(500);
  tap(); t.mock.timers.tick(500);
  assert.equal(requests.length, 0);
  translator.start(); translator.start(); tap(); t.mock.timers.tick(150);
  assert.equal(requests.length, 1);
  translator.stop();
  assert.equal(signals[0]!.aborted, true);
});
