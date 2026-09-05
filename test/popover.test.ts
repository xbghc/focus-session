import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { PartialTranslation } from "../src/types.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g["document"] = dom.window.document;
g["Element"] = dom.window.Element;

// closed 的 shadow root 从外面查不到，测试里强制开着才能断言渲染结果。
// 生产代码仍然用 closed——这里改的是宿主环境，不是被测代码。
const realAttach = dom.window.Element.prototype.attachShadow;
dom.window.Element.prototype.attachShadow = function attachShadow(init: ShadowRootInit): ShadowRoot {
  return realAttach.call(this, { ...init, mode: "open" });
};

g["chrome"] = { runtime: { getURL: (p: string) => `chrome-extension://test/${p}` } };

/** 语音桩：断言"点了哪段音标、念出来的是哪个词"。 */
class FakeUtterance {
  text: string;
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}
const spoken: FakeUtterance[] = [];
let cancels = 0;
g["SpeechSynthesisUtterance"] = FakeUtterance;
g["speechSynthesis"] = {
  speak: (u: FakeUtterance) => void spoken.push(u),
  cancel: () => void cancels++,
};
const heard = (): string => spoken[spoken.length - 1]?.text ?? "";

const { Popover } = await import("../src/content/popover.ts");
type PopoverT = InstanceType<typeof Popover>;
const RECT = {
  top: 100, bottom: 120, left: 50, right: 90,
  width: 40, height: 20, x: 50, y: 100,
  toJSON: () => ({}),
} as DOMRect;

const SNIPPET = {
  id: "s1", articleId: "a", url: "u", articleTitle: "t",
  text: "leaks", kind: "word" as const, context: "Every abstraction leaks.",
  createdTs: 0, translation: "泄漏", contextNote: "本文里指抽象挡不住底层细节。",
  pos: "verb", phonetic: "/liːks/", lemma: "leak", usage: null, vocab: [], cardId: null,
};

let pop: PopoverT;
beforeEach(() => {
  document.documentElement.querySelectorAll("#focus-session-popover").forEach((n) => n.remove());
  pop = new Popover({ onConfirm: () => {}, onOpenOptions: () => {} });
  spoken.length = 0;
  cancels = 0;
});

const root = (): ShadowRoot => pop.hostElement!.shadowRoot!;
const txt = (sel: string): string => root().querySelector(sel)?.textContent ?? "";

test("showStreaming 立刻显示选中的词，译文位先放转圈", () => {
  pop.showStreaming(RECT, "leaks");
  assert.equal(txt(".term"), "leaks");
  assert.equal(txt(".tr"), ""); // 只有 spin 元素，没有文字
  assert.ok(root().querySelector(".tr .spin"), "译文到达前应当有加载指示");
});

test("译文先到就先显示，语境解释可以还没来", () => {
  pop.showStreaming(RECT, "leaks");
  pop.updateStream({ translation: "泄漏", phonetic: null, pos: null, contextNote: null, usage: null, vocab: [] });
  assert.equal(txt(".tr"), "泄漏");
  assert.equal(root().querySelector(".tr .spin"), null, "译文到了就该把转圈换掉");
  assert.equal(txt(".note"), "");
});

test("后到的字段逐个补上，不覆盖已经显示的内容", () => {
  pop.showStreaming(RECT, "leaks");
  pop.updateStream({ translation: "泄漏", phonetic: null, pos: null, contextNote: null, usage: null, vocab: [] });
  pop.updateStream({ translation: "泄漏", phonetic: "/liːks/", pos: "verb", contextNote: null, usage: null, vocab: [] });
  assert.equal(txt(".meta"), "/liːks/ · verb");
  assert.equal(txt(".tr"), "泄漏");

  pop.updateStream({ translation: "泄漏", phonetic: "/liːks/", pos: "verb", contextNote: "本文里…", usage: null, vocab: [] });
  assert.equal(txt(".note"), "本文里…");
  assert.equal(txt(".tr"), "泄漏");
});

test("最终结果就地补在流式骨架上，不重建 DOM", () => {
  pop.showStreaming(RECT, "leaks");
  pop.updateStream({ translation: "泄", phonetic: null, pos: null, contextNote: null, usage: null, vocab: [] });
  const before = root().querySelector(".tr");

  pop.showResult(RECT, SNIPPET);
  assert.equal(root().querySelector(".tr"), before, "同一个节点，整块重建会闪一下");
  assert.equal(txt(".tr"), "泄漏");
  assert.equal(txt(".meta"), "/liːks/ · verb");
  assert.equal(txt(".note"), "本文里指抽象挡不住底层细节。");
});

test("没有语境解释时把那一行删掉，不留空白", () => {
  pop.showStreaming(RECT, "leaks");
  pop.showResult(RECT, { ...SNIPPET, contextNote: "" });
  assert.equal(root().querySelector(".note"), null);
});

test("不经流式直接出结果也照样渲染", () => {
  pop.showResult(RECT, SNIPPET);
  assert.equal(txt(".term"), "leaks");
  assert.equal(txt(".tr"), "泄漏");
});

test("浮层关掉后迟到的增量不会炸，也不会把浮层拉回来", () => {
  pop.showStreaming(RECT, "leaks");
  pop.hide();
  pop.updateStream({ translation: "泄漏", phonetic: null, pos: null, contextNote: null, usage: null, vocab: [] });
  assert.equal(pop.hostElement, null);
});

test("报错会顶掉流式骨架，之后的增量不再落到已经消失的节点上", () => {
  pop.showStreaming(RECT, "leaks");
  pop.showError(RECT, "HTTP 401", true);
  assert.match(txt(".err"), /API Key/);
  pop.updateStream({ translation: "泄漏", phonetic: null, pos: null, contextNote: null, usage: null, vocab: [] });
  assert.equal(root().querySelector(".tr"), null, "增量不该在错误界面上凭空长出译文");
});

/* ---------- 生词讲解 ---------- */

const V1 = { word: "abstraction", phonetic: "/ˌæbˈstrækʃn/", pos: "noun", meaning: "抽象层", note: null };
const V2 = { word: "leak", phonetic: "/liːk/", pos: "verb", meaning: "渗漏", note: "此处是比喻" };
const partial = (over: Partial<PartialTranslation> = {}): PartialTranslation => ({
  translation: "抽象总会泄漏",
  phonetic: null,
  pos: null,
  contextNote: null,
  usage: null,
  vocab: [],
  ...over,
});
const vs = (): NodeListOf<Element> => root().querySelectorAll(".v");

test("用法和生词都渲染出来", () => {
  pop.showResult(RECT, { ...SNIPPET, usage: "常和 layer 连用", vocab: [V1, V2] });
  assert.equal(txt(".usage"), "常和 layer 连用");
  assert.equal(vs().length, 2);
  assert.equal(vs()[0]!.querySelector(".vw")!.textContent, "abstraction");
  assert.equal(vs()[0]!.querySelector(".vm")!.textContent, "/ˌæbˈstrækʃn/ · noun");
  assert.equal(vs()[0]!.querySelector(".vd")!.textContent, "抽象层");
  assert.equal(vs()[0]!.querySelector(".vn"), null, "没有提示就不留空行");
  assert.equal(vs()[1]!.querySelector(".vn")!.textContent, "此处是比喻");
});

test("没有讲解时不留空块", () => {
  pop.showResult(RECT, SNIPPET);
  assert.equal(root().querySelector(".usage"), null);
  assert.equal(root().querySelector(".vocab"), null);
});

test("流式期间生词逐条追加，已经画出来的那条不重画", () => {
  pop.showStreaming(RECT, "Every abstraction leaks.");
  pop.updateStream(partial({ vocab: [V1] }));
  assert.equal(vs().length, 1);
  const first = vs()[0]!;

  pop.updateStream(partial({ vocab: [V1, V2] }));
  assert.equal(vs().length, 2);
  assert.equal(vs()[0], first, "第一条应当原地不动——重画会让读到一半的人跳行");
  assert.equal(vs()[1]!.querySelector(".vw")!.textContent, "leak");
});

test("最终结果补上流式没赶上的那几条", () => {
  pop.showStreaming(RECT, "Every abstraction leaks.");
  pop.updateStream(partial({ vocab: [V1] }));
  pop.showResult(RECT, { ...SNIPPET, text: "Every abstraction leaks.", vocab: [V1, V2] });
  assert.equal(vs().length, 2);
});

test("最终结果比流式见过的少时整块重来，不留下多出来的那条", () => {
  pop.showStreaming(RECT, "Every abstraction leaks.");
  pop.updateStream(partial({ vocab: [V1, V2] }));
  pop.showResult(RECT, { ...SNIPPET, text: "Every abstraction leaks.", vocab: [V2] });
  assert.equal(vs().length, 1);
  assert.equal(vs()[0]!.querySelector(".vw")!.textContent, "leak");
});

test("流式骨架里没到的讲解不占位", () => {
  pop.showStreaming(RECT, "leaks");
  pop.updateStream(partial());
  // 节点在，但是空的——CSS 的 :empty 负责让它不显示，这里断言没有多余文字
  assert.equal(txt(".usage"), "");
  assert.equal(vs().length, 0);
});

test("译文到了尾灯才亮，最终结果落定时摘掉", () => {
  pop.showStreaming(RECT, "Every abstraction leaks.");
  assert.equal(root().querySelector(".more.on"), null, "译文之前不亮——.tr 里已经有一个转圈了");
  pop.updateStream(partial());
  assert.ok(root().querySelector(".more.on"), "译文到了但讲解还在写，得让人知道还有内容");
  pop.showResult(RECT, { ...SNIPPET, text: "Every abstraction leaks." });
  assert.equal(root().querySelector(".more"), null);
});

/* ---------- 点音标朗读 ---------- */

const click = (el: Element | null): void => (el as HTMLElement).click();

test("点顶部音标，念的是选中的原文", () => {
  pop.showResult(RECT, SNIPPET);
  click(root().querySelector(".meta .ph"));
  assert.equal(heard(), "leaks");
});

test("点生词的音标，念的是那一条生词而不是整个选区", () => {
  pop.showResult(RECT, { ...SNIPPET, text: "Every abstraction leaks.", vocab: [V1, V2] });
  click(vs()[1]!.querySelector(".ph"));
  assert.equal(heard(), "leak");
});

test("流式期间音标一到就能点，念的是选区原文", () => {
  pop.showStreaming(RECT, "Every abstraction leaks.");
  pop.updateStream(partial({ phonetic: "/liːks/", pos: "verb" }));
  click(root().querySelector(".meta .ph"));
  assert.equal(heard(), "Every abstraction leaks.");
});

test("流式收尾切到最终结果后，音标仍然可点", () => {
  pop.showStreaming(RECT, "leaks");
  pop.updateStream(partial({ phonetic: "/liːks/", pos: "verb" }));
  pop.showResult(RECT, SNIPPET);
  click(root().querySelector(".meta .ph"));
  assert.equal(heard(), "leaks");
});

test("整句没有音标，那一行只剩词性也不该出可点区", () => {
  pop.showResult(RECT, { ...SNIPPET, phonetic: null, pos: "sentence" });
  assert.equal(txt(".meta"), "sentence");
  assert.equal(root().querySelector(".ph"), null);
});

test("收起浮层会停掉自己发起的朗读", () => {
  pop.showResult(RECT, SNIPPET);
  click(root().querySelector(".meta .ph"));
  cancels = 0;
  pop.hide();
  assert.equal(cancels, 1);
});

test("没念过东西时收起浮层不去动网页自己的朗读", () => {
  pop.showResult(RECT, SNIPPET);
  pop.hide();
  assert.equal(cancels, 0);
});
