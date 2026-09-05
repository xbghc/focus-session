/**
 * 朗读生词，以及「音标 · 词性」那一行的公共渲染。
 *
 * 用浏览器自带的 speechSynthesis：不联网、不花 token、不需要额外权限，
 * 断网也能用。发音这种事没必要走模型。
 *
 * 渲染 helper 一并放在这里，是因为四处（浮层 / 侧栏 / 生词本 / 复习卡）画的是同一行，
 * 而「哪一段可点、点了念什么」正是这个模块的知识。
 */

/** 朗读的语言。选区判定已经保证含拉丁字母，一律按英语读。 */
const LANG = "en-US";

/**
 * 比默认稍慢。默认语速是给整句设计的，单个生词一闪而过，
 * 听不清就等于没读。
 */
const RATE = 0.9;

/**
 * 正在念的那条**我们自己的** utterance。
 *
 * 必须记住所有权：content script 用的是宿主页面同一个语音引擎，
 * 无条件 cancel() 会掐掉网页自己的朗读功能（不少阅读类站点有）。
 * 只打断自己发起的那条。
 */
let mine: SpeechSynthesisUtterance | null = null;

function engine(): SpeechSynthesis | null {
  try {
    return typeof speechSynthesis === "undefined" ? null : speechSynthesis;
  } catch {
    return null; // 某些沙箱化的 iframe 里访问会抛
  }
}

/** 环境是否支持朗读。不支持时音标就画成普通文字，不给出点不动的假按钮。 */
export function canSpeak(): boolean {
  return engine() !== null && typeof SpeechSynthesisUtterance !== "undefined";
}

/**
 * 念一个词。
 *
 * 传进来的是**词**不是音标：TTS 不认 IPA，把 `/ˈskruːtəni/` 交给它
 * 只会得到一串斜杠和字母的噪音。
 */
export function speak(word: string): boolean {
  const text = word.trim();
  if (!text) return false;
  const synth = engine();
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") return false;
  try {
    // 连点两个词时后一个应当立刻顶掉前一个，而不是排队等它念完
    stopSpeaking();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LANG;
    u.rate = RATE;
    // 认对象而不是认标志位：cancel() 触发的 onerror 是异步到的，
    // 那时 mine 可能已经指向新的一条了，认标志位会把新的误清掉。
    const done = (): void => {
      if (mine === u) mine = null;
    };
    u.onend = done;
    u.onerror = done;
    mine = u;
    synth.speak(u);
    return true;
  } catch {
    mine = null;
    return false;
  }
}

/** 收起浮层、离开页面时调。只停自己那条，网页在念的东西不动。 */
export function stopSpeaking(): void {
  if (!mine) return;
  mine = null;
  engine()?.cancel();
}

/* ==================== 「音标 · 词性」一行 ==================== */

const SEP = " · ";
/** 音标和词性各自的显示上限。内容直接来自模型，得留个闸。 */
const MAX_PHONETIC = 48;
const MAX_POS = 24;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface MetaParts {
  phonetic: string | null;
  pos: string | null;
  /** 点音标时念的词。音标描述的是它，所以这里给的是原形式，不是词元。 */
  word: string;
}

/**
 * 把「音标 · 词性」填进容器，音标做成可点朗读的 `.ph`。
 *
 * 会先清空容器：流式期间同一个节点要被反复填。
 * 返回是否填进了内容，调用方据此决定要不要把容器挂出来。
 */
export function fillMeta(host: Element, m: MetaParts, sep: string = SEP): boolean {
  host.textContent = "";
  const ph = m.phonetic?.trim() ?? "";
  const pos = m.pos?.trim() ?? "";
  if (!ph && !pos) return false;
  const doc = host.ownerDocument;
  if (ph) host.append(phoneticNode(doc, ph, m.word));
  if (ph && pos) host.append(doc.createTextNode(sep));
  if (pos) host.append(doc.createTextNode(cut(pos, MAX_POS)));
  return true;
}

function phoneticNode(doc: Document, phonetic: string, word: string): HTMLElement {
  const span = doc.createElement("span");
  span.textContent = cut(phonetic, MAX_PHONETIC);
  if (!word.trim() || !canSpeak()) return span;
  span.className = "ph";
  span.title = "点击朗读";
  span.addEventListener("click", () => void speak(word));
  return span;
}
