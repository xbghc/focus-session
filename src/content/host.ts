import type { PageState } from "../types.ts";
import { normalizeUrl } from "../lib/url.ts";
import type { TrackController } from "./track.ts";

/*
 * 一页之内可以重来的追踪。
 *
 * content script 只在文档加载时开张一次，而单页应用换文章并不重新加载文档：追踪认死了
 * 开张那一刻的地址，此后读的每一篇都会记到它头上，读完角标也会一直挂在右下角。地址变化
 * 只有后台看得见（tabs.onUpdated），通知过来之后由这里原地再起一轮——旧的一轮走和离开
 * 页面同一条收尾路径（结算最后一段、摘掉全部监听、收掉角标），新的一轮按新地址重抽正文。
 * 效果等同刷新一次，只是不用真刷新。
 *
 * 同一个文档还有第二种「重来」：从 bfcache 回来。后退/前进时浏览器把整页原样端回来，
 * 文档不重新加载，content script 也不会再跑一次——而离开这一页时 pagehide 已经把那一轮
 * 收摊了（见 track.ts 的 finish），不重起的话回到的这一页从此既不计时也不划词翻译。
 * 地址没变，urlChanged 那条路认不出该重来，所以另给一个入口。
 *
 * 从 index.ts 里拆出来是为了能单独测：它只认一个「按地址起一轮」的函数，不碰 chrome
 * 也不碰 DOM。安卓 App 的阅读器没有这个问题（自己渲染正文），所以不经过这里。
 */

/** 按地址起一轮追踪。作废时 signal 会 abort，那一轮就该尽早收手（见 TrackOptions.signal）。 */
export type Begin = (url: string, signal: AbortSignal) => Promise<TrackController>;

export interface PageHost {
  /** 开张：按这个地址起第一轮。 */
  start(url: string): void;
  /** 当前状态，popup 每次询问都现算。 */
  state(): PageState;
  /** popup 的「本页启用划词翻译」，转给手上这一轮。 */
  translateHere(): void;
  /**
   * 后台通知的同文档导航。归一化之后还是同一篇就什么都不做——长文加目录锚点
   * （#section）正是这个工具最常见的用法。判定口径与后台一致（normalizeUrl）。
   */
  urlChanged(url: string): void;
  /**
   * 从 bfcache 回来（后退/前进）。地址一样也要原地再起一轮：离开时那一轮已经收摊，
   * 而文档不重新加载，没有第二个人会把它拉起来。
   */
  restored(url: string): void;
}

export function createPageHost(begin: Begin): PageHost {
  /** 手上这一轮。还在抽正文时是 null——那几秒里 popup 看到的和刚打开一个页面时一样。 */
  let ctl: TrackController | null = null;
  /** 这一轮认的是哪一篇。null 表示还没开张过。 */
  let articleId: string | null = null;
  /**
   * 轮次。抽正文最长要重试到 4 秒，这期间足够再换两次页；每一轮 resolve 时都要
   * 对一次号，过期的那些直接收掉，否则最后活下来的未必是最新那一轮。
   */
  let round = 0;
  /** 手上这一轮的作废开关，只对还没 resolve 的有意义。 */
  let pending: AbortController | null = null;
  /** 还没就绪时 popup 看到的说法。 */
  let reason = "初始化中";

  /** translateHere：新的一轮就绪后替用户再点一次「本页启用划词翻译」，见 restored。 */
  const run = (url: string, translateHere = false): void => {
    const gen = ++round;
    pending?.abort(); // 上一轮若还在抽正文，让它就地收手
    ctl?.stop("unload"); // 已经开张的，走和离开页面同一条收尾路径
    ctl = null;
    articleId = normalizeUrl(url);
    reason = "初始化中";
    const ac = new AbortController();
    pending = ac;
    void begin(url, ac.signal).then(
      (next) => {
        // 抽正文期间又换了一篇：这一轮认的地址已经过时，接手的是后来那轮
        if (gen !== round) {
          next.stop("unload");
          return;
        }
        pending = null;
        ctl = next;
        if (translateHere) next.translateHere();
      },
      (err: unknown) => {
        if (gen !== round) return;
        pending = null;
        reason = `初始化失败：${String(err)}`;
      },
    );
  };

  return {
    start: (url) => run(url),
    state: () => ctl?.state() ?? { tracked: false, reason },
    translateHere: () => ctl?.translateHere(),
    urlChanged: (url) => {
      if (articleId !== null && normalizeUrl(url) === articleId) return;
      run(url);
    },
    restored: (url) => {
      /*
       * 非文章页上的「本页启用划词翻译」是用户亲手点出来的，而新起的一轮默认不挂
       * （见 track.ts 的 translateOnly）。bfcache 回来还是同一次加载——那句
       * 「只对本次加载有效」在这里的意思是它该跟着回来，不能被这次重起悄悄关掉。
       */
      run(url, ctl?.state().translateHere === "on");
    },
  };
}
