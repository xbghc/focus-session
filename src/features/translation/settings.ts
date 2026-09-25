/*
 * 划词翻译自己的设置。和专注记录的设置存在同一个 `settings` 键下（存储格式是扁平的一份），
 * 但类型上分开：翻译插件只拿得到这一份，读不到、也改不着专注记录的阈值。
 */

export interface TranslationSettings {
  /**
   * 翻译白名单：命中的页面自动挂划词翻译，其余页面要用户从 popup / App 顶栏手动开，只对本次加载有效。
   * 和文章记录黑名单互不相干——一页记不记专注、翻不翻译各判各的。
   */
  translationAllowedUrls: string[];
  /** 划词翻译总开关。关掉后 content script 不再挂选区监听。 */
  translateEnabled: boolean;
  /** 短于此长度的选区不翻译（避免误点选到一两个字符）。 */
  minSelectionChars: number;
  /**
   * 超过此词数不自动翻译，改为在浮层里给一个"翻译"按钮。
   *
   * 这道闸只拦**离谱的量**（顺手整段整节地选中），不拦"有点长"。
   * 实测一段 130 词的选区连讲解一起也才 400 多个输出 token、十秒内出完，
   * 为这种量级弹一次确认，等于把"选中即翻译"改成"选中再点一下才翻译"。
   *
   * 按词而不是按字符：读英文时"这段有多长"是按词感知的，
   * `unconstitutional` 一个词能顶三个短词的字符数，字符阈值会把它误判成长选区。
   */
  maxAutoSelectionWords: number;
  /** 发给 LLM 的上下文段落最多截取多少字符。 */
  contextChars: number;
  /**
   * 「英语老师模式」：除了翻译，再讲一句用法，并把多词选区里的生词逐个讲开。
   *
   * 关掉能省掉一半左右的输出 token，也让浮层早一两秒定住。
   * 只想要个译文的时候，这两样都是噪音。
   */
  explainVocab: boolean;
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  translationAllowedUrls: [],
  translateEnabled: true,
  minSelectionChars: 2,
  maxAutoSelectionWords: 200, // ≈ 1100 字符（英文均值 5.5 字符/词），大致是三四段
  contextChars: 600,
  explainVocab: true,
};

/**
 * 自动翻译上限能填到的最大值（设置页的区间上界，迁移换算也夹到这里）。
 *
 * 按英文均值 5.5 字符/词，360 词 ≈ 1980 字符，刚好压在 HARD_MAX_CHARS 之下——
 * 再往上填是空档：那些选区根本到不了这道闸，会先被硬上限拦掉。
 */
export const MAX_AUTO_WORDS = 360;
