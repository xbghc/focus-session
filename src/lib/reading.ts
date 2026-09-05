import { countByScript } from "./wordcount.ts";

/**
 * 阅读时间的估计。所有「这段文字读完要多久」的判断都从这里出：
 * 段落已读阈值、走神阈值的自适应、统计层的口径共用同一套数字，不各算各的。
 *
 * 拉丁文字按词：Brysbaert (2019) 对 190 项研究、18,573 人的元分析给出成人英文
 * 非虚构默读 238 wpm，常见区间 175–300。
 * 中日韩按字：没有同等分量的元分析可引，取 400 字/分——义务教育课标要求初中生默读
 * 一般现代文不少于 500 字/分，成人读技术类文本会慢一些。这是个保守的近似，不是测量值。
 */
export const LATIN_WPM = 238;
export const CJK_CPM = 400;

/**
 * 走神判定给「安静读完当前一屏」留的余量：静默上限 = 视口文字预计阅读时间 × 1.5。
 * 175 wpm 的慢读者需要 1.36 倍的时间，再给回看一句留一点。
 *
 * 为什么必须自适应：Turner、Iqbal & Dumais (2015) 测得阅读时平均每 19 秒滚一次，
 * 那还是 32px 大字、每屏 22 行的实验设置；正常网页一屏 400 词按 238 wpm 要读 100 秒，
 * 期间可以一个输入事件都没有。固定 30 秒的 idle 阈值落在正常阅读的间隔分布中间，
 * 每读一屏就切一刀。
 */
export const READ_GRACE = 1.5;

/** 按正常速度读完这段文字需要的毫秒数。 */
export function expectedReadMs(text: string): number {
  const { cjk, latin } = countByScript(text);
  return Math.round((latin / LATIN_WPM + cjk / CJK_CPM) * 60_000);
}

/**
 * 段落记为已读所需的停留时长。
 *
 * 取「预计阅读时间 × fraction」与「最短停留」中的大者：几个字的标题也得看上一眼，
 * 而一段 76 词的正文光露出一秒不能算读过（238 wpm 下读完要 19 秒）。
 * 固定阈值的问题正是 Kim 等人 (WSDM 2014) 对搜索领域 30 秒 dwell 启发式指出的那个：
 * 单一阈值假定读任何内容都花同样的时间。
 */
export function readThresholdMs(expectedMs: number, fraction: number, floorMs: number): number {
  return Math.max(floorMs, Math.round(expectedMs * fraction));
}

/**
 * 当前允许的静默上限：固定阈值与「视口文字预计阅读时间 × READ_GRACE」取大，再夹到 maxQuietMs。
 * maxQuietMs 为 0 表示关闭自适应，退回固定阈值。
 */
export function quietLimitMs(baseMs: number, visibleExpectedMs: number, maxQuietMs: number): number {
  if (maxQuietMs <= 0) return baseMs;
  const budget = Math.min(maxQuietMs, Math.round(visibleExpectedMs * READ_GRACE));
  return Math.max(baseMs, budget);
}
