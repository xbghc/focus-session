import type { EndReason, PageState } from "../../types.ts";

/*
 * 页面上的功能插件。
 *
 * 专注记录和划词翻译是两个互不知道对方的功能：一个页面上记不记、翻不翻各判各的，
 * 谁关掉、谁出错都不牵连另一个。它们都挂在同一个页面宿主上（见 host.ts），
 * 宿主只负责「按地址起一轮 / 收一轮」和把各自的状态拼成一份给 popup。
 *
 * 往后加功能就是再写一个 PagePlugin，不必去动已有的那几个。
 */

/**
 * 插件之间共享的页面信息。谁知道得更准谁来写，想用的人现取——插件之间不直接引用。
 *
 * 眼下只有标题：专注记录抽出正文后知道真正的文章标题（document.title 常带着站名），
 * 划词翻译落库时要拿它做出处；没人写就是 document.title。
 */
export interface PageInfo {
  title(): string;
  setTitle(title: string): void;
}

export interface PageContext {
  /**
   * 本页代表的内容地址。扩展里就是 location.href；App 的阅读器里是原文地址，
   * 页面自己的地址是 read.html，不代表内容。
   */
  url: string;
  /** 这一轮作废了（页内换了一篇）。起步要花时间的插件每个 await 之后查一次。 */
  signal: AbortSignal;
  info: PageInfo;
  /**
   * 状态自己变了（不是因为宿主调了它）：起步等完了、设置读回来了。
   * 宿主据此让界面当场重画，不必等下一次轮询——App 阅读器的顶栏就是这样。
   */
  changed(): void;
}

export interface PageFeature {
  /** 这个功能在本页的状态，宿主把各家的拼成一份 PageState。popup 每次询问都现算。 */
  state(): Partial<PageState>;
  /** 收摊：摘掉全部监听、结算该结算的。重复调用无害。 */
  stop(reason?: EndReason): void;
}

/**
 * 一个功能插件。`C` 是从 bfcache 回来时要从旧一轮带到新一轮的东西（比如用户在本页手动开的翻译），
 * 由旧实例的 carry() 交出、新一轮 start 时收下；换了一篇（urlChanged）不带。
 */
export interface PagePlugin<F extends PageFeature = PageFeature, C = unknown> {
  /**
   * 同步交出这一轮的实例。起步要等的插件（专注记录要等 LLM 判断是不是文章）在实例内部等，
   * 等的期间由它自己的 state() 说明在等什么——宿主不替任何插件管异步。
   */
  start(ctx: PageContext, carried?: C): F;
  carry?(feature: F): C;
}

export type FeatureOf<P> = P extends PagePlugin<infer F, infer _C> ? F : never;
