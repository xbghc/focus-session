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
/** 浮层递出来的追问。断言"点了发送之后外面收到的是哪一句"。 */
let asked: string[] = [];
let optionsOpened = 0;
beforeEach(() => {
  document.documentElement.querySelectorAll("#focus-session-popover").forEach((n) => n.remove());
  asked = [];
  optionsOpened = 0;
  pop = new Popover({
    onConfirm: () => {},
    onOpenOptions: () => void optionsOpened++,
    onAsk: (q) => void asked.push(q),
  });
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

/* ---- 追问：译文出来之后，就着这一段再问一句 ---- */

/** 走一遍「翻完 → 点问一句」，返回输入框。 */
function openAsk(): HTMLInputElement {
  pop.showResult(RECT, SNIPPET);
  pop.enableAsk();
  click(root().querySelector('[data-act="ask"]'));
  return root().querySelector(".qin") as HTMLInputElement;
}

/** 在输入框里敲一句并发送。 */
function ask(input: HTMLInputElement, q: string): void {
  input.value = q;
  click(root().querySelector('[data-act="send"]'));
}

test("译文还没到就没有追问入口——没有译文可倚，追问问的是空气", () => {
  pop.showStreaming(RECT, "leaks");
  assert.equal(root().querySelector('[data-act="ask"]'), null);
  assert.equal(pop.asking, false);
});

test("翻完之后挂上追问入口，但那时选区还在，浮层照常该关就关", () => {
  pop.showResult(RECT, SNIPPET);
  pop.enableAsk();
  const entry = root().querySelector('[data-act="ask"]')!;
  assert.equal(entry.textContent, "问", "一个字符当图标，不写文字标签");
  assert.equal(root().querySelector(".qin"), null, "先只给按钮，别一上来就摆个表单");
  assert.equal(pop.asking, false, "还没点开，选区还作数");
});

test("纯图标按钮必须带无障碍名字——不然读屏软件读出来是空的", () => {
  const input = openAsk();
  for (const act of ["ask", "send"]) {
    // 收起态只有 ask，展开态只有 send；各查各的那一刻
    const btn = root().querySelector(`[data-act="${act}"]`);
    if (!btn) continue;
    assert.ok((btn.getAttribute("aria-label") ?? "").length > 0, `${act} 缺 aria-label`);
    assert.ok((btn.getAttribute("title") ?? "").length > 0, `${act} 缺 title`);
  }
  assert.equal(root().querySelector('[data-act="send"]')!.textContent, "↵");
  assert.notEqual(input, null);
});

test("点开输入框之后 asking 为真——此后选区塌了也不能关浮层", () => {
  const input = openAsk();
  assert.notEqual(input, null);
  assert.equal(pop.asking, true);
});

test("发出一问：外面收到原话，问题挂上去，答案位先转圈", () => {
  const input = openAsk();
  ask(input, "  它和 leak 有什么区别？  ");
  assert.deepEqual(asked, ["它和 leak 有什么区别？"], "两头的空白要去掉");
  assert.equal(txt(".qq"), "它和 leak 有什么区别？");
  assert.ok(root().querySelector(".aa .spin"), "答案到达前应当有加载指示");
  assert.equal(input.value, "", "发出去之后输入框要清空");
  assert.equal(input.disabled, true, "上一问还没答完，别让人接着发");
});

test("空白问题不发", () => {
  const input = openAsk();
  ask(input, "   ");
  assert.deepEqual(asked, []);
  assert.equal(root().querySelector(".qa"), null);
});

test("答案流式填进来，答完解禁输入框", () => {
  const input = openAsk();
  ask(input, "为什么用复数？");
  pop.updateAnswer("主语是");
  assert.equal(txt(".aa"), "主语是");
  pop.updateAnswer("主语是 abstraction");
  assert.equal(txt(".aa"), "主语是 abstraction", "增量是累积值，直接覆盖");
  pop.finishAnswer("主语是 abstraction，复数指每一次抽象。");
  assert.equal(txt(".aa"), "主语是 abstraction，复数指每一次抽象。");
  assert.equal(input.disabled, false, "答完了要能接着问");
});

test("一个字都没答出来时也不留个空框在那儿转", () => {
  const input = openAsk();
  ask(input, "?");
  pop.finishAnswer("");
  assert.equal(root().querySelector(".aa .spin"), null);
  assert.ok(txt(".aa").length > 0);
});

test("接着问第二问：前一轮留在上面，不被顶掉", () => {
  const input = openAsk();
  ask(input, "第一问");
  pop.finishAnswer("第一答");
  ask(input, "第二问");
  pop.finishAnswer("第二答");
  const qs = [...root().querySelectorAll(".qq")].map((n) => n.textContent);
  const as = [...root().querySelectorAll(".aa")].map((n) => n.textContent);
  assert.deepEqual(qs, ["第一问", "第二问"]);
  assert.deepEqual(as, ["第一答", "第二答"]);
});

test("上一问还没答完，第二问按不出去", () => {
  const input = openAsk();
  ask(input, "第一问");
  ask(input, "第二问");
  assert.deepEqual(asked, ["第一问"]);
});

test("回车发送；输入法选词时的那一下回车不算", () => {
  const input = openAsk();
  const enter = (isComposing: boolean): void => {
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing, bubbles: true }));
  };

  input.value = "选词中按的回车";
  enter(true);
  assert.deepEqual(asked, [], "中文输入第一下就会撞上：那是确认候选，不是发送");

  input.value = "真的要问";
  enter(false);
  assert.deepEqual(asked, ["真的要问"]);
});

test("追问失败：缺配置时给一个「去设置」", () => {
  const input = openAsk();
  ask(input, "为什么？");
  pop.failAnswer("尚未填写 MiniMax API Key", true);
  assert.ok(txt(".aa").includes("API Key"));
  click(root().querySelector('[data-act="opt"]'));
  assert.equal(optionsOpened, 1);
  assert.equal(input.disabled, false, "失败之后也要能再问");
});

test("追问失败：一般错误照原样显示，不给「去设置」", () => {
  const input = openAsk();
  ask(input, "为什么？");
  pop.failAnswer("网络错误：Failed to fetch", false);
  assert.ok(txt(".aa").includes("网络错误"));
  assert.equal(root().querySelector('[data-act="opt"]'), null);
});

test("收起浮层之后 asking 回到假——不然换一段选区就再也关不掉了", () => {
  openAsk();
  assert.equal(pop.asking, true);
  pop.hide();
  assert.equal(pop.asking, false);
});

test("重新划一个词：追问那块跟着整块作废", () => {
  const input = openAsk();
  ask(input, "上一段的问题");
  pop.finishAnswer("上一段的答案");
  pop.showStreaming(RECT, "another");
  assert.equal(root().querySelector(".qa"), null, "上一段的问答不能留在新的一段上");
  assert.equal(pop.asking, false);
});
