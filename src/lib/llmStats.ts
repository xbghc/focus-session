import type { LlmTiming } from "../types.ts";

/**
 * 诊断日志里那两行摘要的文案。
 *
 * 放在 lib 而不是设置页里，是因为"怎么概括一堆耗时"是有判断的（见 median），
 * 而设置页那个模块一 import 就往 DOM 上挂监听，测不了。
 */

/** 各条路径在界面上的名字。 */
export const SOURCE_LABEL: Record<LlmTiming["source"], string> = {
  translate: "划词翻译",
  test: "测试连接",
  assist: "复习助手",
  ask: "浮层追问",
  articleReview: "文章回顾",
};

/** 毫秒折成人看的。秒以上给一位小数——1.4s 比 1437ms 更容易一眼比较。 */
export const secs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/**
 * 中位数。
 *
 * 用它不用均值：一次 60 秒的超时能把二十次调用的均值整个拖走，
 * 而"偶尔有点慢"要看的恰恰是平时多快、最坏多坏——均值两头都答不上。
 */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/**
 * 耗时那一行。几个数字各回答一个问题：
 * 平时多快（中位）、最坏多坏（最慢那次是谁）、真正让人等的那一段多久（看到译文）、
 * 以及慢是不是自己退避出来的（重试次数）。
 */
export function timingLine(ts: LlmTiming[]): string {
  if (ts.length === 0) return "还没有耗时记录。";
  const slowest = ts.reduce((a, b) => (b.totalMs > a.totalMs ? b : a));
  const parts = [
    `最近 ${ts.length} 次调用：中位 ${secs(median(ts.map((t) => t.totalMs)))}`,
    `最慢 ${secs(slowest.totalMs)}（${SOURCE_LABEL[slowest.source]}${slowest.failedKind ? "，" + slowest.failedKind : ""}）`,
  ];
  // 划词真正让人等的是"译文什么时候出现"，不是整条流跑完——后面的生词讲解晚到没人在意
  const shown = ts.map((t) => t.firstFieldMs).filter((v): v is number => v !== null);
  if (shown.length > 0) parts.push(`看到译文中位 ${secs(median(shown))}`);
  // 不点破的话，一次重试过的调用看起来就是"模型慢了 1.5 秒"
  const retried = ts.filter((t) => t.attempts > 1).length;
  if (retried > 0) parts.push(`其中 ${retried} 次撞上过载重试（那段慢是退避，不是模型）`);
  return parts.join("，") + "。";
}

