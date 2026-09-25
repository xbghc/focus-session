import type { PageState } from "../../types.ts";
import { normalizeUrl } from "../../lib/url.ts";
import type { FeatureOf, PageFeature, PageInfo, PagePlugin } from "./plugin.ts";

/*
 * 一页之内可以重来的一组功能插件。
 *
 * content script 只在文档加载时开张一次，而单页应用换文章并不重新加载文档：插件认死了
 * 开张那一刻的地址，此后读的每一篇都会记到它头上。地址变化只有后台看得见（tabs.onUpdated），
 * 通知过来之后由这里原地再起一轮——旧的一轮每个插件都走和离开页面同一条收尾路径，
 * 新的一轮按新地址重来。效果等同刷新一次，只是不用真刷新。
 *
 * 同一个文档还有第二种「重来」：从 bfcache 回来。后退/前进时浏览器把整页原样端回来，
 * 文档不重新加载，content script 也不会再跑一次——而离开这一页时 pagehide 已经让插件
 * 收摊了，不重起的话回到的这一页从此既不计时也不划词翻译。地址没变，urlChanged 那条路
 * 认不出该重来，所以另给一个入口；这时用户在本页做过的选择要带过去（见 PagePlugin.carry）。
 *
 * 宿主不知道有哪些功能、各自什么时候算「就绪」：插件同步交出实例，要等的在实例里自己等。
 * 它只认「按地址起一轮 / 收一轮」和把各家的状态拼起来，不碰 chrome，便于单独测。
 */

// 各插件的 F、C 各不相同，这里只要求「是个插件」；取用时由 FeatureOf 还原出具体类型
type Plugins = Record<string, PagePlugin<any, any>>;

export interface PageHost<P extends Plugins> {
  /** 开张：按这个地址起第一轮。 */
  start(url: string): void;
  /** 各插件状态拼成的一份，popup 每次询问都现算。 */
  state(): PageState;
  /** 手上这一轮里的某个功能。还没开张时是 null。 */
  get<K extends keyof P>(id: K): FeatureOf<P[K]> | null;
  /**
   * 后台通知的同文档导航。归一化之后还是同一篇就什么都不做——长文加目录锚点
   * （#section）正是这个工具最常见的用法。判定口径与后台一致（normalizeUrl）。
   */
  urlChanged(url: string): void;
  /** 从 bfcache 回来（后退/前进）。地址一样也要原地再起一轮，带着用户在本页的选择。 */
  restored(url: string): void;
  /** 全部收摊。重复调用无害。 */
  stop(): void;
}

export interface PageHostOptions {
  /** 没有插件写过标题时用什么。缺省是 document.title；App 的阅读器知道确切的标题。 */
  title?: () => string;
  /** 某个插件的状态自己变了。作废了的那几轮发来的不转。 */
  onChange?: () => void;
}

export function createPageHost<P extends Plugins>(plugins: P, opts: PageHostOptions = {}): PageHost<P> {
  const ids = Object.keys(plugins) as Array<keyof P & string>;
  let features: Partial<Record<keyof P, PageFeature>> | null = null;
  /** 这一轮认的是哪一篇。null 表示还没开张过。 */
  let articleId: string | null = null;
  let round: AbortController | null = null;

  const stopAll = (): void => {
    round?.abort(); // 还在起步的插件就地收手
    round = null;
    if (features) for (const id of ids) features[id]?.stop("unload");
    features = null;
  };

  const run = (url: string, carried: Partial<Record<keyof P, unknown>> = {}): void => {
    stopAll();
    articleId = normalizeUrl(url);
    const ac = new AbortController();
    round = ac;
    let title: string | null = null;
    const info: PageInfo = {
      title: () => title ?? opts.title?.() ?? document.title,
      setTitle: (t) => {
        title = t;
      },
    };
    const next: Partial<Record<keyof P, PageFeature>> = {};
    features = next;
    for (const id of ids) {
      const plugin = plugins[id] as PagePlugin<PageFeature, unknown>;
      const changed = (): void => {
        if (round === ac) opts.onChange?.();
      };
      next[id] = plugin.start({ url, signal: ac.signal, info, changed }, carried[id]);
    }
  };

  return {
    start: (url) => run(url),
    state: () => {
      if (!features) return { tracked: false, reason: "初始化中" };
      const st: PageState = { tracked: false };
      for (const id of ids) Object.assign(st, features[id]?.state());
      return st;
    },
    get: (id) => (features?.[id] as FeatureOf<P[typeof id]> | undefined) ?? null,
    urlChanged: (url) => {
      if (articleId !== null && normalizeUrl(url) === articleId) return;
      run(url);
    },
    restored: (url) => {
      const carried: Partial<Record<keyof P, unknown>> = {};
      if (features) {
        for (const id of ids) {
          const plugin = plugins[id] as PagePlugin<PageFeature, unknown>;
          const f = features[id];
          if (f && plugin.carry) carried[id] = plugin.carry(f);
        }
      }
      run(url, carried);
    },
    stop: stopAll,
  };
}
