import type { ArticleReview, LlmConfig } from "../types.ts";
import { LlmError, type LlmDeps, type RawUsage, callMessages, extractJson } from "./llm.ts";

/**
 * 文章级回顾材料的生成。
 *
 * 和划词翻译解决的是两个问题：翻译对付的是"这个词什么意思"，
 * 这里对付的是"这篇文章讲了什么，我已经想不起来了"。所以产出是
 * 大纲 + 回想问题，而不是逐句译文；调度也走独立的一套卡片。
 */

/** 发给模型的正文上限。也是入库上限——正文按这个尺寸存，不留两份。 */
export const MAX_REVIEW_CHARS = 30_000;

/**
 * 回顾材料的输出**下限**：大纲加三个问题约 300–500 个输出 token。
 *
 * 是下限不是上限——用户把 max_tokens 调得更大时按用户的来（见下面的 Math.max）。
 * 这两个常量当初是为了兜住 DEFAULT_LLM 偏紧的默认值，默认值放宽之后
 * 再当成封顶用就反了。
 */
export const REVIEW_MAX_TOKENS = 1_500;

/**
 * 超时下限。实测输出 token 数与耗时成正比，且服务端抖动很大：
 * 80 token 曾抖到 4.9s（合 60ms/token），500 token 撞上同样的抖动就是 30s。
 */
export const REVIEW_TIMEOUT_MS = 60_000;

const REVIEW_SYSTEM = `你在帮一位读者回顾他前些天读过的一篇文章。他要的是"全貌"——文章讲了什么、怎么一步步论证的、结论是什么。不是逐段翻译，也不是读后感。
只输出一个 JSON 对象，不要代码块，不要前言。字段：
- outline: 中文字符串数组，4 到 6 条，按文章自己的脉络排。每条一句话，说清这一步在论证链条上做了什么：提出了什么、拿什么支撑、推出了什么。不要写"本文介绍了…"这类空话，也不要把小标题原样抄一遍。
- questions: 中文字符串数组，正好 3 条，用来考读者还记不记得。问具体的东西——某个论点的依据、文中举过的例子、某个结论的适用边界。不要问"这篇文章讲了什么"这种怎么答都不算错的问题。`;

export interface ReviewInput {
  title: string;
  url: string;
  /** 已按 MAX_REVIEW_CHARS 截断过的正文。 */
  text: string;
  /** 截断前的字符数。 */
  fullChars: number;
}

/**
 * 按上限截断正文，尽量断在段落边界。
 * 把一句话切成两半会让模型在结尾处胡猜；宁可少给一段。
 */
export function clipText(text: string, max = MAX_REVIEW_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf("\n\n");
  // 段落边界太靠前就算了，硬截也比只留一小半强
  return at > max * 0.6 ? cut.slice(0, at) : cut;
}

export function buildReviewPrompt(input: ReviewInput): string {
  const parts = [`标题：${input.title || "(无标题)"}`, `来源：${input.url}`];
  if (input.fullChars > input.text.length) {
    const pct = Math.max(1, Math.round((input.text.length / input.fullChars) * 100));
    // 不点明的话，模型会把截断处当成文章结尾，给出一个根本不存在的"结论"
    parts.push(`注意：以下只是正文的前 ${pct}%，后面截掉了。只根据看到的部分写，不要编造结尾。`);
  }
  parts.push("正文：", input.text);
  return parts.join("\n");
}

/** 去掉模型可能带上的项目符号或编号——它偶尔会把"数组"理解成"排好版的列表"。 */
const BULLET = /^\s*(?:[-*·•]|\d+\s*[.、)．]|[（(]\d+[)）])\s*/;

/**
 * 宽容地把一个字段读成字符串数组。
 * 模型偶尔会把数组写成一整段带换行的文本，按行救回来——
 * 和 extractJson 救 markdown 围栏是同一种防御。
 */
export function toList(v: unknown, max: number): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : [];
  const out: string[] = [];
  for (const item of raw) {
    const s = (typeof item === "string" ? item : String(item ?? "")).replace(BULLET, "").trim();
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function normalizeArticleReview(raw: unknown): Pick<ArticleReview, "outline" | "questions"> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const outline = toList(o["outline"], 8);
  // 大纲是这份材料的本体，没有它就没有回顾可言；问题少几条还能用
  if (outline.length === 0) throw new LlmError("模型没有返回可用的 outline", "parse");
  return { outline, questions: toList(o["questions"], 5) };
}

export async function generateArticleReview(
  input: ReviewInput,
  config: LlmConfig,
  now: number,
  deps?: LlmDeps,
): Promise<{ review: Omit<ArticleReview, "articleId">; usage: RawUsage }> {
  // 取大值而不是覆写：这两个常量是回顾材料的**下限**，
  // 不该把用户自己在设置里调宽的额度又收回去
  const cfg: LlmConfig = {
    ...config,
    maxTokens: Math.max(config.maxTokens, REVIEW_MAX_TOKENS),
    timeoutMs: Math.max(config.timeoutMs, REVIEW_TIMEOUT_MS),
  };
  const res = await callMessages(cfg, REVIEW_SYSTEM, buildReviewPrompt(input), deps);
  try {
    if (res.truncated) throw new LlmError(`回顾材料被 max_tokens(${cfg.maxTokens}) 截断`, "parse");
    const { outline, questions } = normalizeArticleReview(extractJson(res.text));
    return { review: { outline, questions, generatedTs: now, model: cfg.model }, usage: res.usage };
  } catch (err) {
    // 和 llm.ts 的 finishTranslation 同一条规矩：解析阶段的失败把完整原文挂上，给诊断日志
    if (err instanceof LlmError) err.raw = { text: res.text, stopReason: res.stopReason };
    throw err;
  }
}
