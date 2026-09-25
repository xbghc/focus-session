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

const { Popover } = await import("../src/features/translation/popover.ts");
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

/*
 * 定位。jsdom 不排版，尺寸一律是 0，视口和浮层的尺寸都得手动喂：content 是浮层内容撑开有多高，
 * scrollHeight 照它报，offsetHeight / clientHeight 报被 max-height 截过的样子；浮层画在哪由 geom
 * 照 top 或 bottom 倒算。锚点 rect 是外面传进来的普通对象，不受这里的替换影响。
 */
const proto = dom.window.HTMLElement.prototype;
const METRICS = ["scrollHeight", "offsetHeight", "clientHeight", "offsetWidth", "getBoundingClientRect"] as const;
const originals = new Map(METRICS.map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const));
let content = 0;
/** 宿主此刻画在视口的哪里。页面往下滚 dy，宿主就到 -dy；浮层（贴屏幕顶的除外）跟着它挪。 */
let hostAt = { left: 0, top: 0 };
const boxEl = (): HTMLElement => root().querySelector(".box") as HTMLElement;
/** 浮层此刻画在哪：钉上边时照 top 算，钉下边时照 bottom 算。 */
const geom = (): { top: number; bottom: number } => {
  const s = boxEl().style;
  const height = Math.min(content, parseFloat(s.maxHeight));
  if (s.top !== "auto") return { top: parseFloat(s.top), bottom: parseFloat(s.top) + height };
  const bottom = document.documentElement.clientHeight - parseFloat(s.bottom);
  return { top: bottom - height, bottom };
};
const layout = (vh: number, h: number): void => {
  content = h;
  hostAt = { left: 0, top: 0 };
  const own = (v: number) => ({ value: v, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", own(vh));
  Object.defineProperty(document.documentElement, "clientWidth", own(1000));
  const capped = function (this: HTMLElement): number {
    const max = parseFloat(this.style.maxHeight);
    return Number.isNaN(max) ? content : Math.min(content, max);
  };
  Object.defineProperty(proto, "scrollHeight", { get: () => content, configurable: true });
  Object.defineProperty(proto, "offsetHeight", { get: capped, configurable: true });
  Object.defineProperty(proto, "clientHeight", { get: capped, configurable: true });
  Object.defineProperty(proto, "offsetWidth", { get: () => 300, configurable: true });
  Object.defineProperty(proto, "getBoundingClientRect", {
    value: function (this: HTMLElement): DOMRect {
      if (this.id === "focus-session-popover") {
        const { left, top } = hostAt;
        return { left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top, toJSON: () => ({}) } as DOMRect;
      }
      // 浮层照 geom() 摆在宿主里：页面滚过（hostAt 挪了）就跟着挪，贴屏幕顶的钉在屏幕上不跟
      const at = geom();
      const by = boxEl().classList.contains("dock") ? { left: 0, top: 0 } : hostAt;
      return { left: by.left, right: by.left + 300, top: at.top + by.top, bottom: at.bottom + by.top, width: 300,
        height: at.bottom - at.top, x: by.left, y: at.top + by.top, toJSON: () => ({}) } as DOMRect;
    },
    configurable: true, writable: true,
  });
};
const unlayout = (): void => {
  for (const [k, d] of originals) {
    if (d) Object.defineProperty(proto, k, d);
    else Reflect.deleteProperty(proto, k);
  }
  Reflect.deleteProperty(document.documentElement, "clientHeight");
  Reflect.deleteProperty(document.documentElement, "clientWidth");
};
const rectAt = (top: number): DOMRect => ({ ...RECT, top, bottom: top + 20, y: top }) as DOMRect;

test("流式时按选区种类预估的高度挑边：上方留得出就放上方，钉住预留好的上边", () => {
  layout(800, 120); // 骨架刚出来只有 120px，挑边不能照它
  try {
    pop.showStreaming(rectAt(400), "leaks", "word");
    assert.deepEqual(geom(), { top: 122, bottom: 242 }); // 400 - 8 - 270
    assert.equal(boxEl().style.maxHeight, "270px", "往下长到选区上沿为止，不压住选区");
  } finally {
    unlayout();
  }
});

test("流式内容一批批长高，浮层不挪；收尾摘掉尾灯、挂上追问入口也不挪", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(400), "leaks", "word");
    const at = { top: boxEl().style.top, left: boxEl().style.left };
    for (const h of [160, 210, 255]) {
      content = h;
      pop.updateStream(partial({ contextNote: "本文里…" }));
      assert.deepEqual({ top: boxEl().style.top, left: boxEl().style.left }, at);
    }
    content = 230;
    pop.showResult(rectAt(400), SNIPPET);
    content = 262;
    pop.enableAsk();
    assert.deepEqual({ top: boxEl().style.top, left: boxEl().style.left }, at);
  } finally {
    unlayout();
  }
});

test("流式结束后内容比预留的高：钉住选区上沿往上让一次，不把尾巴藏进滚动条", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(400), "leaks", "word");
    content = 320;
    pop.updateStream(partial());
    assert.equal(geom().top, 122, "流式期间装不下先在里面滚，不挪");
    pop.showResult(rectAt(400), SNIPPET);
    assert.deepEqual(geom(), { top: 72, bottom: 392 }); // 下沿钉在 400 - 8，往上长 320
  } finally {
    unlayout();
  }
});

test("上方留不出预估的高度就放下方，之后只往下长", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(100), "leaks", "word"); // 上方只有 84px
    assert.equal(geom().top, 128); // 120 + 8
    content = 400;
    pop.updateStream(partial());
    pop.showResult(rectAt(100), SNIPPET);
    assert.equal(geom().top, 128);
  } finally {
    unlayout();
  }
});

test("两边都放不下预估的高度：挑宽的那边，收矮了在里面滚，不贴顶压住选区", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(300), "Every abstraction leaks.", "sentence"); // 整句按上限 520 预估；上方 284、下方 464
    assert.equal(geom().top, 328);
    assert.equal(boxEl().style.maxHeight, "464px");
  } finally {
    unlayout();
  }
});

test("两边都挤不出一个像样的浮层才贴顶：选区本身占了大半屏", () => {
  layout(300, 200);
  try {
    pop.showStreaming({ ...RECT, top: 90, bottom: 230, height: 140 } as DOMRect, "leaks", "word"); // 上方 74、下方 54
    assert.equal(geom().top, 8);
  } finally {
    unlayout();
  }
});

test("确认、报错这类一次成型的内容：量现在的高度，贴着选区放", () => {
  layout(800, 90);
  try {
    pop.showConfirm(rectAt(400), "hello", 201);
    assert.deepEqual(geom(), { top: 302, bottom: 392 });
    pop.showError(rectAt(100), "HTTP 500", false); // 上方 84px 放不下 90px
    assert.equal(geom().top, 128);
  } finally {
    unlayout();
  }
});

test("发出一问时给答案留出地方：上边往上提一次，之后答案怎么长浮层都不挪", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(400), "leaks", "word");
    content = 240;
    pop.showResult(rectAt(400), SNIPPET);
    pop.enableAsk();
    const shown = geom(); // 上边钉在预留的 122，长 240
    click(root().querySelector('[data-act="ask"]'));
    assert.deepEqual(geom(), shown, "点开输入框不挪");
    content = 290;
    ask(root().querySelector(".qin") as HTMLInputElement, "为什么？");
    assert.equal(geom().top, 8, "底下只剩 30px，上边提到头，给答案腾出地方");
    for (const h of [330, 380, 460]) {
      content = h;
      pop.updateAnswer("因为……");
      assert.equal(geom().top, 8, "答案流出来的时候不挪");
    }
    pop.finishAnswer("因为……");
    assert.equal(geom().top, 8);
    assert.equal(boxEl().style.maxHeight, "384px", "往下长到选区上沿为止，再长在里面滚");
  } finally {
    unlayout();
  }
});

test("底下本来就留得出答案的地方：发出一问也不挪", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(700), "Every abstraction leaks.", "sentence"); // 整句预留 520：上边钉在 172
    content = 200;
    pop.showResult(rectAt(700), { ...SNIPPET, text: "Every abstraction leaks." });
    pop.enableAsk();
    click(root().querySelector('[data-act="ask"]'));
    content = 240;
    ask(root().querySelector(".qin") as HTMLInputElement, "为什么？");
    assert.equal(geom().top, 172);
    content = 380;
    pop.updateAnswer("因为……");
    assert.equal(geom().top, 172);
  } finally {
    unlayout();
  }
});

test("收尾往上让过一次、钉着下沿的浮层：发出一问时改钉上边，答案往下长", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(400), "leaks", "word");
    content = 320;
    pop.showResult(rectAt(400), SNIPPET); // 比预留的 270 高：下沿钉在 392
    pop.enableAsk();
    click(root().querySelector('[data-act="ask"]'));
    ask(root().querySelector(".qin") as HTMLInputElement, "为什么？");
    const { top } = geom();
    for (const h of [360, 420, 500]) {
      content = h;
      pop.updateAnswer("因为……");
      assert.equal(geom().top, top, "答案流出来的时候不挪");
    }
  } finally {
    unlayout();
  }
});

test("放在选区下方的浮层：发出一问不挪，答案往下长", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(100), "leaks", "word"); // 上方只有 84px，落到下方：上边钉在 128
    content = 240;
    pop.showResult(rectAt(100), SNIPPET);
    pop.enableAsk();
    click(root().querySelector('[data-act="ask"]'));
    ask(root().querySelector(".qin") as HTMLInputElement, "为什么？");
    content = 400;
    pop.updateAnswer("因为……");
    assert.equal(geom().top, 128);
  } finally {
    unlayout();
  }
});

test("截图识别转翻译沿用同一个框，不按单词重新挑边", () => {
  layout(800, 100);
  try {
    pop.showRecognizing(rectAt(700)); // 认出来之前按整句预留：700 - 8 - 520
    assert.equal(geom().top, 172);
    pop.setTerm("hello");
    pop.showStreaming(rectAt(700), "hello", "word");
    assert.equal(geom().top, 172);
  } finally {
    unlayout();
  }
});

test("换一段选区就重新挑边", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(400), "leaks", "word");
    assert.equal(geom().top, 122);
    pop.showStreaming(rectAt(100), "another", "word");
    assert.equal(geom().top, 128);
  } finally {
    unlayout();
  }
});

/** 手机：主指针是手指；insetTop 是宿主写进 --inset-top 的状态栏高度。返回还原函数。 */
const phone = (insetTop = 0): (() => void) => {
  g["matchMedia"] = (q: string) => ({ matches: q === "(pointer: coarse)" });
  g["getComputedStyle"] = () => ({ getPropertyValue: (p: string) => (p === "--inset-top" ? `${insetTop}px` : "") });
  return () => {
    delete g["matchMedia"];
    delete g["getComputedStyle"];
  };
};

test("手机上浮层贴屏幕顶：让开状态栏，左右居中，往下长到选区上沿为止", () => {
  const restore = phone(24);
  layout(900, 120);
  try {
    pop.showStreaming(rectAt(600), "leaks", "word");
    assert.equal(geom().top, 32); // 8 + 24
    assert.equal(boxEl().style.left, "350px"); // (1000 - 300) / 2
    assert.equal(boxEl().style.maxHeight, "520px"); // 顶边到选区上沿有 560px，被 520 封顶
  } finally {
    unlayout();
    restore();
  }
});

test("手机上贴顶的浮层怎么长都不挪：内容超出不往上让，点开追问也不改钉下边", () => {
  const restore = phone();
  layout(900, 120);
  try {
    pop.showStreaming(rectAt(300), "leaks", "word"); // 顶边 8 到选区上沿 292 有 284px，放得下 270
    const at = { top: boxEl().style.top, left: boxEl().style.left, bottom: boxEl().style.bottom };
    assert.equal(at.top, "8px");
    content = 320;
    pop.updateStream(partial());
    pop.showResult(rectAt(300), SNIPPET); // 比 284px 高：贴着选区的会往上让，贴顶的只能在里面滚
    pop.enableAsk();
    assert.deepEqual({ top: boxEl().style.top, left: boxEl().style.left, bottom: boxEl().style.bottom }, at);
    assert.equal(boxEl().style.maxHeight, "284px");
    click(root().querySelector('[data-act="ask"]'));
    ask(root().querySelector(".qin") as HTMLInputElement, "为什么？");
    content = 420;
    pop.updateAnswer("因为……");
    assert.deepEqual({ top: boxEl().style.top, left: boxEl().style.left, bottom: boxEl().style.bottom }, at);
  } finally {
    unlayout();
    restore();
  }
});

test("手机上选区太靠上、顶上放不下：照旧落到选区下方", () => {
  const restore = phone();
  layout(900, 120);
  try {
    pop.showStreaming(rectAt(150), "leaks", "word"); // 顶边 8 到选区上沿 142 只有 134px
    assert.equal(geom().top, 178); // 170 + 8
  } finally {
    unlayout();
    restore();
  }
});

/* ---- 滚动：浮层挂在冻结的宿主里跟着原文走，看不见了才关 ---- */

const hostOf = (): HTMLElement => pop.hostElement!;

/** 让浮层以为页面滚到了 (x, y)。返回还原函数。 */
const scrolledTo = (x: number, y: number): (() => void) => {
  Object.defineProperty(document, "defaultView", { value: { scrollX: x, scrollY: y }, configurable: true });
  return () => void Reflect.deleteProperty(document, "defaultView");
};

test("定位时宿主冻结成这一刻的视口，浮层照旧按视口坐标摆在里面", () => {
  layout(800, 120);
  const restore = scrolledTo(40, 1200);
  try {
    pop.showStreaming(rectAt(400), "leaks", "word");
    const s = hostOf().style;
    assert.deepEqual([s.left, s.top, s.width, s.height], ["40px", "1200px", "1000px", "800px"]);
    assert.deepEqual(geom(), { top: 122, bottom: 242 }, "框的算法不变");
    assert.equal(boxEl().classList.contains("dock"), false);
  } finally {
    restore();
    unlayout();
  }
});

test("站点给 html 加了 margin：宿主量一次，补回视口原点", () => {
  layout(800, 120);
  hostAt = { left: 0, top: 32 };
  try {
    pop.showStreaming(rectAt(400), "leaks", "word");
    assert.equal(hostOf().style.top, "-32px");
  } finally {
    unlayout();
  }
});

test("内容真溢出才挡住滚动接力；放得下时不挡，滚轮照常滚页面", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(400), "leaks", "word"); // 预留 270
    assert.equal(boxEl().classList.contains("scrolls"), false);
    content = 320;
    pop.updateStream(partial());
    assert.equal(boxEl().classList.contains("scrolls"), true);
    content = 200;
    pop.updateStream(partial());
    assert.equal(boxEl().classList.contains("scrolls"), false);
  } finally {
    unlayout();
  }
});

test("贴选区的浮层跟着页面滚走，滚到只露出不到 40px 才算看不见", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(400), "leaks", "word"); // 上边 122，高 120
    const scroll = (dy: number): boolean => {
      hostAt = { left: 0, top: -dy };
      return pop.followAnchor(rectAt(400 - dy));
    };
    assert.equal(scroll(120), true);
    assert.equal(boxEl().style.transform, "", "原文跟着文档走，不用补");
    assert.equal(scroll(200), true, "还露出 42px");
    assert.equal(scroll(210), false, "只露出 32px");
    assert.equal(scroll(-700), false, "往回滚，浮层从视口底下出去了");
  } finally {
    unlayout();
  }
});

test("原文在内部滚动容器里、没跟着文档走：浮层补上差值跟过去，scrollShift 算上这一截", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(400), "leaks", "word");
    assert.equal(pop.followAnchor(rectAt(300)), true);
    assert.equal(boxEl().style.transform, "translate(0px, -100px)");
    assert.deepEqual(pop.scrollShift(), { x: 0, y: -100 });
    hostAt = { left: 0, top: -50 };
    pop.followAnchor(rectAt(350)); // 文档也滚了 50，原文跟着文档走的那一截不用补
    assert.equal(boxEl().style.transform, "");
    assert.deepEqual(pop.scrollShift(), { x: 0, y: -50 });
  } finally {
    unlayout();
  }
});

test("贴屏幕顶的浮层不跟：原文挪开 1/4 屏以上，并且被浮层遮住或出了屏幕，才算看不见", () => {
  const restore = phone();
  layout(900, 120);
  try {
    pop.showStreaming(rectAt(600), "leaks", "word"); // 顶上 8，高 120
    assert.equal(boxEl().classList.contains("dock"), true);
    hostAt = { left: 0, top: -500 };
    assert.equal(pop.followAnchor(rectAt(400)), true, "挪了 200，不到 225");
    assert.equal(pop.followAnchor(rectAt(300)), true, "挪够了，词还露在浮层下面");
    assert.equal(pop.followAnchor(rectAt(100)), false, "挪够了，整个压在浮层底下");
    assert.equal(pop.followAnchor(rectAt(-40)), false, "滚出了屏幕顶");
    assert.equal(pop.followAnchor(rectAt(950)), false, "往回滚，从屏幕底下出去了");
    assert.equal(pop.followAnchor(rectAt(880)), true, "挪了 280，词还在屏幕上");
    assert.deepEqual(pop.scrollShift(), { x: 0, y: 0 }, "钉在屏幕上，不算被滚动带着挪");
  } finally {
    unlayout();
    restore();
  }
});

test("滚过之后再追问：给答案留地方照框里的坐标算，不被页面滚动带偏", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(700), "Every abstraction leaks.", "sentence"); // 上边钉在 172
    content = 200;
    pop.showResult(rectAt(700), { ...SNIPPET, text: "Every abstraction leaks." });
    pop.enableAsk();
    click(root().querySelector('[data-act="ask"]'));
    hostAt = { left: 0, top: -100 };
    content = 240;
    ask(root().querySelector(".qin") as HTMLInputElement, "为什么？");
    assert.equal(geom().top, 172);
  } finally {
    unlayout();
  }
});

test("识别标题转圈，译文空着；切换流式沿用同一骨架", () => {
  pop.showRecognizing(RECT);
  assert.equal(txt(".term"), "正在识别图中文字… ");
  assert.ok(root().querySelector(".term .spin"));
  assert.equal(root().querySelector(".tr")!.childNodes.length, 0);
  const tr = root().querySelector(".tr");
  pop.setTerm("hello");
  assert.equal(txt(".term"), "hello");
  assert.equal(root().querySelector(".term .spin"), null);
  pop.showStreaming(RECT, "hello");
  assert.equal(root().querySelector(".tr"), tr);
  assert.ok(root().querySelector(".tr .spin"));
});

test("setTerm 与流式标题使用相同的 90 字截断", () => {
  const text = "a".repeat(120);
  pop.showStreaming(RECT, text);
  const expected = txt(".term");
  pop.showRecognizing(RECT);
  pop.setTerm(text);
  assert.equal(txt(".term"), expected);
});

test("长文本确认按来源区分选中和识别", () => {
  pop.showConfirm(RECT, "hello", 201);
  assert.equal(txt(".meta"), "选中了 201 个词，较长，确认后再翻译");
  pop.showConfirm(RECT, "hello", 201, "image");
  assert.equal(txt(".meta"), "识别出 201 个词，较长，确认后再翻译");
});

/* ---- 原文：长了只露开头，点一下展开全文，再点收起 ---- */

const LONG = "Leaky abstractions are the ones that fail to hide the details they were meant to hide, so you end up learning those details anyway.";
const term = (): HTMLElement => root().querySelector(".term") as HTMLElement;
/** 在节点上按一个键；返回 dispatchEvent 的结果，默认动作被拦掉时是 false。 */
const press = (el: Element, key: string): boolean =>
  el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

test("长原文只露前 90 个字，点一下展开全文，再点收起", () => {
  pop.showResult(RECT, { ...SNIPPET, text: LONG });
  assert.equal(txt(".term"), `${LONG.slice(0, 90)}…`);
  assert.equal(term().getAttribute("aria-expanded"), "false");
  click(term());
  assert.equal(txt(".term"), LONG);
  assert.equal(term().getAttribute("aria-expanded"), "true");
  click(term());
  assert.equal(txt(".term"), `${LONG.slice(0, 90)}…`);
  assert.equal(term().getAttribute("aria-expanded"), "false");
});

test("没截断的原文不可点：点了不变，也不挂按钮的角色", () => {
  pop.showResult(RECT, SNIPPET);
  assert.equal(term().getAttribute("role"), null);
  assert.equal(term().getAttribute("aria-expanded"), null);
  click(term());
  assert.equal(txt(".term"), "leaks");
});

test("长选区等确认时也能点开，看清要翻的是哪一整段", () => {
  pop.showConfirm(RECT, LONG, 201);
  assert.equal(txt(".term"), `${LONG.slice(0, 80)}…`);
  click(term());
  assert.equal(txt(".term"), LONG);
});

test("流式期间点开的原文，收尾补最终结果时不收回去", () => {
  pop.showStreaming(RECT, LONG, "sentence");
  click(term());
  const node = term();
  pop.updateStream(partial());
  pop.showResult(RECT, { ...SNIPPET, text: LONG });
  assert.equal(term(), node, "同一个节点，就地补的最终值");
  assert.equal(txt(".term"), LONG);
  click(term());
  assert.equal(txt(".term"), `${LONG.slice(0, 90)}…`, "收尾之后照样能收起");
});

test("截图认出的长段落也能点开；识别转翻译沿用骨架，展开着的不收回", () => {
  pop.showRecognizing(RECT);
  assert.equal(term().getAttribute("aria-expanded"), null, "识别中的标题不可点");
  pop.setTerm(LONG);
  click(term());
  assert.equal(txt(".term"), LONG);
  pop.showStreaming(RECT, LONG, "sentence");
  assert.equal(txt(".term"), LONG);
});

test("换一段选区回到收起", () => {
  pop.showStreaming(RECT, LONG, "sentence");
  click(term());
  pop.showStreaming(RECT, `${LONG} Again.`, "sentence");
  assert.equal(term().getAttribute("aria-expanded"), "false");
  assert.equal(txt(".term"), `${LONG.slice(0, 90)}…`);
});

test("截断的原文当按钮用：Tab 能到，回车、空格都能展开收起", () => {
  pop.showResult(RECT, { ...SNIPPET, text: LONG });
  assert.equal(term().getAttribute("role"), "button");
  assert.equal(term().getAttribute("tabindex"), "0");
  press(term(), "Enter");
  assert.equal(txt(".term"), LONG);
  assert.equal(press(term(), " "), false, "空格的默认动作是滚动浮层，得拦掉");
  assert.equal(txt(".term"), `${LONG.slice(0, 90)}…`);
  press(term(), "a");
  assert.equal(txt(".term"), `${LONG.slice(0, 90)}…`, "别的键不算");
});

test("追问框里的回车不去动原文", () => {
  pop.showResult(RECT, { ...SNIPPET, text: LONG });
  pop.enableAsk();
  click(root().querySelector('[data-act="ask"]'));
  press(root().querySelector(".qin")!, "Enter");
  assert.equal(term().getAttribute("aria-expanded"), "false");
});

test("展开后比预留的那一格高：同流式收尾，钉住选区上沿往上让一次；收起不再挪回去", () => {
  layout(800, 120);
  try {
    pop.showStreaming(rectAt(500), LONG, "phrase"); // 预留 400：上边钉在 500 - 8 - 400
    content = 350;
    pop.showResult(rectAt(500), { ...SNIPPET, text: LONG });
    assert.deepEqual(geom(), { top: 92, bottom: 442 });
    content = 480;
    click(term());
    assert.deepEqual(geom(), { top: 12, bottom: 492 }); // 下沿钉在 500 - 8，往上长 480
    content = 350;
    click(term());
    assert.deepEqual(geom(), { top: 142, bottom: 492 });
  } finally {
    unlayout();
  }
});

test("收起时滚回浮层顶上：不然还停在读全文时滚到的地方，刚收起的原文反倒看不见", () => {
  pop.showResult(RECT, { ...SNIPPET, text: LONG });
  const box = boxEl();
  // jsdom 不排版，scrollTop 恒为 0；挂一个能写的值，当作读全文时往下滚过
  Object.defineProperty(box, "scrollTop", { value: 300, writable: true, configurable: true });
  click(term());
  assert.equal(box.scrollTop, 300, "展开不去动滚动位置");
  click(term());
  assert.equal(box.scrollTop, 0);
});

/* ---- 浮层里的字能选中复制 ---- */

/** 在节点上按下鼠标；返回 dispatchEvent 的结果，默认动作被拦掉时是 false。 */
const mousedown = (el: Element): boolean =>
  el.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));

/** 让浮层以为页面的选区落在 node 上。jsdom 的 Selection 没有 getComposedRanges，桩一个。返回还原函数。 */
const selectAt = (node: Node, collapsed = false): (() => void) => {
  const fake = { rangeCount: 1, getComposedRanges: () => [{ collapsed, startContainer: node }] };
  (document as unknown as { getSelection: () => unknown }).getSelection = () => fake;
  return () => void Reflect.deleteProperty(document, "getSelection");
};

test("按在字上不拦默认动作，浮层里的字选得中；按在按钮上照旧拦住，页面上的选区不塌", () => {
  pop.showResult(RECT, SNIPPET);
  pop.enableAsk();
  assert.equal(mousedown(root().querySelector(".tr")!), true, "拦住就选不了字");
  assert.equal(mousedown(root().querySelector(".note")!), true);
  assert.equal(mousedown(term()), true);
  assert.equal(mousedown(root().querySelector('[data-act="ask"]')!), false);
});

test("浮层说得出自己手里有没有选区：选在浮层里才算，光标和页面上的选区不算", () => {
  pop.showResult(RECT, SNIPPET);
  const inside = root().querySelector(".tr")!.firstChild!;
  for (const [node, collapsed, want] of [[inside, false, true], [inside, true, false], [document.body, false, false]] as const) {
    const restore = selectAt(node, collapsed);
    try {
      assert.equal(pop.holdsSelection(), want);
    } finally {
      restore();
    }
  }
  assert.equal(pop.holdsSelection(), false, "jsdom 自己的 Selection 没有 getComposedRanges，也不该炸");
});

test("在原文上拖着选字，松手那一下不算点：不展开也不收起", () => {
  pop.showResult(RECT, { ...SNIPPET, text: LONG });
  const restore = selectAt(term().firstChild!);
  try {
    click(term());
    assert.equal(term().getAttribute("aria-expanded"), "false");
  } finally {
    restore();
  }
  click(term());
  assert.equal(term().getAttribute("aria-expanded"), "true", "没选着字时照常展开");
});

test("流式里原样再带来的字段不换文本节点，选着的字不会被下一批冲掉", () => {
  pop.showStreaming(RECT, "Every abstraction leaks.", "sentence");
  pop.updateStream(partial());
  const tr = root().querySelector(".tr")!.firstChild;
  pop.updateStream(partial({ contextNote: "本文里…" }));
  pop.showResult(RECT, { ...SNIPPET, text: "Every abstraction leaks.", translation: "抽象总会泄漏" });
  assert.equal(root().querySelector(".tr")!.firstChild, tr);
  assert.equal(txt(".tr"), "抽象总会泄漏");
});

test("答案越写越长只接上新长出来的那截，已经写出的字不换节点", () => {
  const input = openAsk();
  ask(input, "为什么？");
  pop.updateAnswer("主语是");
  const node = root().querySelector(".aa")!.firstChild;
  pop.updateAnswer("主语是 abstraction");
  pop.finishAnswer("主语是 abstraction");
  assert.equal(root().querySelector(".aa")!.firstChild, node);
  assert.equal(txt(".aa"), "主语是 abstraction");
});
