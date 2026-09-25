/*
 * 专注记录自己的设置：走神阈值、段落已读判定、读完判定、续读、文章回顾、文章记录黑名单。
 * 和划词翻译的设置存在同一个 `settings` 键下，类型上分开（见 features/translation/settings.ts）。
 */

export interface ReadingSettings {
  idleTimeoutMs: number;
  stallTimeoutMs: number;
  /** 短于此长度的 session 直接丢弃（alt-tab 抖动会产生大量碎片）。 */
  minSessionMs: number;
  /**
   * 走神阈值的自适应上限（毫秒）。
   *
   * 实际的静默上限 = max(idle/stall 阈值, 视口文字预计阅读时间 × READ_GRACE)，再夹到这个数以下。
   * 阅读本身不产生输入，一屏 400 词要读 100 秒；不自适应的话每读一屏就被切一刀。
   * 代价是真离开时最多高估这么长，有界。0 关闭自适应，退回固定阈值。
   */
  maxQuietMs: number;
  /** 段落在视口内至少停留多久才可能算"已读"——已读阈值的下限。 */
  paragraphDwellMs: number;
  /**
   * 段落已读阈值：停留达到「按正常速度读完这段所需时间」的这个比例即记为已读。
   * 正常阅读的停留 ≥ 0.8 倍、跳读（~650 wpm）只有 ~0.37 倍，0.5 落在两者之间。
   */
  readFraction: number;
  /** 同一篇文章内间隔不超过这个值（毫秒）的片段合成一个「回合」。 */
  episodeGapMs: number;
  /** 旧版共用黑名单，仅用于迁移。 */
  excludedDomains: string[];
  articleExcludedUrls: string[];
  /** 已读比例达到多少算读完（与触底是且的关系）。 */
  finishRatio: number;
  /**
   * 重新打开一篇读过的文章时，跳回上次读到的位置。
   *
   * 只在**网页自己没有定位过**时才跳：URL 带锚点、或浏览器已经恢复了滚动位置，
   * 都说明这一页已经有人安排好了落点，插件不该再抢。
   */
  restorePositionEnabled: boolean;
  /**
   * 文章回顾总开关。
   * 关掉后不再保存正文、也不再自动生成回顾材料——这是唯一一处**无需用户动作
   * 就会花 token** 的地方，得给个能关的闸。已生成的材料不受影响。
   */
  articleReviewEnabled: boolean;
}

export const DEFAULT_READING_SETTINGS: ReadingSettings = {
  idleTimeoutMs: 30_000,
  stallTimeoutMs: 90_000,
  minSessionMs: 3_000,
  maxQuietMs: 300_000, // ActivityWatch 的 AFK 默认是 180s、RescueTime 是 5 分钟；一屏文字读满也就这个量级
  paragraphDwellMs: 1_000,
  readFraction: 0.5,
  episodeGapMs: 300_000,
  excludedDomains: [],
  articleExcludedUrls: [],
  finishRatio: 0.8,
  restorePositionEnabled: true,
  articleReviewEnabled: true,
};
