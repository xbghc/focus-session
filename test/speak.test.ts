import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g["document"] = dom.window.document;
g["Element"] = dom.window.Element;

/** 记下每次 speak / cancel，用来断言"念了什么""打断了几次"。 */
class FakeUtterance {
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}
const spoken: FakeUtterance[] = [];
let cancels = 0;
const synth = {
  speak: (u: FakeUtterance) => void spoken.push(u),
  cancel: () => void cancels++,
};
g["SpeechSynthesisUtterance"] = FakeUtterance;
g["speechSynthesis"] = synth;

const { canSpeak, speak, stopSpeaking, fillMeta } = await import("../src/lib/speak.ts");

const last = (): FakeUtterance => spoken[spoken.length - 1]!;
const div = (): HTMLElement => document.createElement("div");

beforeEach(() => {
  stopSpeaking(); // 清掉上一个用例留下的"正在念"，否则 cancel 计数会串味
  spoken.length = 0;
  cancels = 0;
});

/* ==================== 朗读 ==================== */

test("念的是词本身，按英语、比默认稍慢", () => {
  assert.equal(speak("scrutiny"), true);
  assert.equal(last().text, "scrutiny");
  assert.equal(last().lang, "en-US");
  assert.ok(last().rate < 1);
});

test("空词不发声", () => {
  assert.equal(speak("   "), false);
  assert.equal(spoken.length, 0);
});

test("连点两个词时后一个顶掉前一个", () => {
  speak("first");
  assert.equal(cancels, 0, "本来就没在念，不必打断");
  speak("second");
  assert.equal(cancels, 1);
  assert.equal(last().text, "second");
});

test("stopSpeaking 只停自己发起的那条", () => {
  // 网页自己在念（我们一次都没发过）：不能替它 cancel，否则会掐掉站点的朗读功能
  stopSpeaking();
  assert.equal(cancels, 0);

  speak("mine");
  stopSpeaking();
  assert.equal(cancels, 1);

  stopSpeaking();
  assert.equal(cancels, 1, "已经停过就不再重复 cancel");
});

test("念完之后所有权就交还，不再替网页 cancel", () => {
  speak("done");
  last().onend?.();
  stopSpeaking();
  assert.equal(cancels, 0);
});

test("被打断的那条迟到的回调不会误清掉新的一条", () => {
  speak("first");
  const first = last();
  speak("second");
  cancels = 0;
  // cancel() 触发的 onerror 是异步到的，此刻 mine 已经指向第二条
  first.onerror?.();
  stopSpeaking();
  assert.equal(cancels, 1, "第二条仍然该被停掉");
});

/* ==================== 「音标 · 词性」一行 ==================== */

test("音标可点，词性只是文字", () => {
  const host = div();
  assert.equal(fillMeta(host, { phonetic: "/liːks/", pos: "verb", word: "leaks" }), true);
  assert.equal(host.textContent, "/liːks/ · verb");
  const ph = host.querySelector(".ph")!;
  assert.equal(ph.textContent, "/liːks/");
  assert.equal(ph.getAttribute("title"), "点击朗读");
});

test("点音标念的是词，不是音标", () => {
  const host = div();
  fillMeta(host, { phonetic: "/ˈskruːtəni/", pos: "noun", word: "scrutiny" });
  (host.querySelector(".ph") as HTMLElement).click();
  assert.equal(last().text, "scrutiny", "IPA 交给 TTS 只会念出一串噪音");
});

test("只有词性时不出可点区，但这一行照样要显示", () => {
  const host = div();
  assert.equal(fillMeta(host, { phonetic: null, pos: "phrase", word: "in hindsight" }), true);
  assert.equal(host.textContent, "phrase");
  assert.equal(host.querySelector(".ph"), null);
});

test("音标词性都没有时返回 false，容器留空给调用方摘掉", () => {
  const host = div();
  assert.equal(fillMeta(host, { phonetic: null, pos: null, word: "x" }), false);
  assert.equal(host.textContent, "");
});

test("重填会先清空——流式期间同一个节点要反复填", () => {
  const host = div();
  fillMeta(host, { phonetic: "/a/", pos: null, word: "a" });
  fillMeta(host, { phonetic: "/b/", pos: "noun", word: "b" });
  assert.equal(host.textContent, "/b/ · noun");
});

test("分隔符可以换，复习卡那行用的是两个空格", () => {
  const host = div();
  fillMeta(host, { phonetic: "/liːks/", pos: "verb", word: "leaks" }, "  ");
  assert.equal(host.textContent, "/liːks/  verb");
});

test("模型给出超长音标或词性时截断", () => {
  const host = div();
  fillMeta(host, { phonetic: "/x/".repeat(80), pos: "n".repeat(80), word: "w" });
  assert.ok(host.textContent!.length < 90, `实际 ${host.textContent!.length}`);
});

test("没有词可念时音标不做成按钮", () => {
  const host = div();
  fillMeta(host, { phonetic: "/liːks/", pos: null, word: "  " });
  assert.equal(host.querySelector(".ph"), null);
  assert.equal(host.textContent, "/liːks/");
});

test("环境不支持朗读时，音标画成普通文字而不是点不动的假按钮", () => {
  delete g["speechSynthesis"];
  try {
    assert.equal(canSpeak(), false);
    const host = div();
    fillMeta(host, { phonetic: "/liːks/", pos: "verb", word: "leaks" });
    assert.equal(host.querySelector(".ph"), null);
    assert.equal(host.textContent, "/liːks/ · verb");
    assert.equal(speak("leaks"), false);
  } finally {
    g["speechSynthesis"] = synth;
  }
  assert.equal(canSpeak(), true);
});
