/**
 * 混合语言字数统计。
 * 中文/日文/韩文按字符计，拉丁及其它按词计，两者相加。
 * 例："读 React docs" = 1(读) + 2(React, docs) = 3。
 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’._-]*/gu;

/** 分文种计数：阅读速度按文种不同，估阅读时间时两边不能混在一起。 */
export function countByScript(text: string): { cjk: number; latin: number } {
  if (!text) return { cjk: 0, latin: 0 };
  const cjk = text.match(CJK)?.length ?? 0;
  // 去掉 CJK 后再数词，避免"读React"这类无空格混排被算成一个词
  const latin = text.replace(CJK, " ").match(WORD)?.length ?? 0;
  return { cjk, latin };
}

export function countWords(text: string): number {
  const { cjk, latin } = countByScript(text);
  return cjk + latin;
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}
