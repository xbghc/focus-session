import type { SnippetKind } from "../types.ts";

/**
 * 选区的语言学判定。
 *
 * 这些规则**只跑在客户端**，不问 LLM。原因是入队规则（词/短语进复习队列、
 * 整句只记录）依赖它，而模型偶尔会把一整句标成 "word"——那会让复习队列
 * 慢慢被长句淹没，正是用户明确不想要的。
 */

/** 连续空白（含换行）压成单空格。选区跨越换行时很常见。 */
export function normalizeSelection(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 拉丁字母检测。
 * 用户是在读英文文章、复习英文，选中中文（比如页面里的中文注释）不该触发翻译，
 * 更不该进复习队列。
 */
export function hasLatin(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

/** 按空白切出的词数。带连字符的算一个词。 */
export function wordCountOf(text: string): number {
  const t = normalizeSelection(text);
  return t ? t.split(" ").length : 0;
}

/**
 * 词数 → 粒度。
 * 1 词是词；2-4 词按短语（"give up on"、"in the wild" 这类值得背）；
 * 再长就是句子，只记录不排期。
 */
export function classifyKind(text: string): SnippetKind {
  const n = wordCountOf(text);
  if (n <= 1) return "word";
  if (n <= 4) return "phrase";
  return "sentence";
}

export interface SelectionVerdict {
  ok: boolean;
  /** ok 为 false 时说明原因，浮层不弹或显示提示用。 */
  reason?: string;
  text: string;
  kind: SnippetKind;
  /** 词数。判定与浮层文案共用一次计算。 */
  words: number;
  /** 超过自动阈值：弹浮层但不自动请求，由用户点按钮确认。 */
  needsConfirm: boolean;
}

export interface SelectionLimits {
  minSelectionChars: number;
  maxAutoSelectionWords: number;
}

/**
 * 硬上限：再长就完全不处理，跟设置无关。整页 Ctrl+A 不该发出去。
 *
 * 这条**必须**留成字符数，不能跟着自动阈值改成词数：`wordCountOf` 按空白切，
 * 一整块 URL / base64 / 压缩过的代码是"1 个词"，纯词数的闸拦不住它。
 */
export const HARD_MAX_CHARS = 2_000;

export function judgeSelection(raw: string, limits: SelectionLimits): SelectionVerdict {
  const text = normalizeSelection(raw);
  const kind = classifyKind(text);
  const words = wordCountOf(text);
  const base = { text, kind, words, needsConfirm: false };
  if (text.length < Math.max(1, limits.minSelectionChars)) return { ...base, ok: false, reason: "选区太短" };
  if (text.length > HARD_MAX_CHARS) return { ...base, ok: false, reason: "选区过长" };
  if (!hasLatin(text)) return { ...base, ok: false, reason: "不含英文" };
  return { ...base, ok: true, needsConfirm: words > limits.maxAutoSelectionWords };
}

/**
 * 复习卡片的标识。
 * 同一个词在不同文章里被划到，应当合成一张卡（否则 leak / leaks / leaked
 * 会变成三张卡轮流来烦你），所以优先用 LLM 给的词元，没有就退回原文。
 */
export function cardKeyOf(text: string, lemma: string | null): string {
  return (lemma ?? text).toLowerCase().trim();
}
