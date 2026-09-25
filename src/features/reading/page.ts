import type { EndReason, PageState } from "../../types.ts";
import { reasonOf } from "../../lib/reason.ts";
import type { PagePlugin, PageFeature } from "../../core/page/plugin.ts";
import { startTracking, type TrackController, type TrackOptions } from "./track.ts";

/*
 * 专注记录插件：判断这一页是不是文章，是的话划 session、记段落、跳回上次位置。
 * 本体在同目录的 track.ts；这里只把它那个要等好几秒的起步（LLM 判断、抽正文重试）
 * 包成宿主要的「同步交出实例」，等的期间由 state() 说明在等什么。
 */

export type ReadingOptions = Pick<TrackOptions, "focus" | "extract" | "approvedArticle">;

export interface ReadingFeature extends PageFeature {
  /** 宿主通知可见性变化（App 切到后台再回来）。扩展里 visibilitychange 事件自己会驱动，不必调。 */
  setVisible(visible: boolean): void;
}

export function readingPlugin(opts: ReadingOptions = {}): PagePlugin<ReadingFeature> {
  return {
    start: (ctx) => {
      let ctl: TrackController | null = null;
      let reason = "初始化中";
      let stopped: EndReason | null = null;
      void startTracking({
        ...opts,
        url: ctx.url,
        signal: ctx.signal,
        onClassifying: () => {
          reason = "LLM 正在判断是否为文章…";
          ctx.changed();
        },
        onTitle: ctx.info.setTitle,
      }).then(
        (next) => {
          // 起步期间就收摊了（页内又换了一篇、宿主整个停了）：这一轮不作数
          if (stopped !== null) next.stop(stopped);
          else ctl = next;
          ctx.changed();
        },
        (err: unknown) => {
          reason = `初始化失败：${reasonOf(err)}`;
          ctx.changed();
        },
      );
      return {
        state: (): Partial<PageState> => ctl?.state() ?? { tracked: false, reason },
        setVisible: (v) => ctl?.setVisible(v),
        stop: (r = "unload") => {
          stopped ??= r;
          ctl?.stop(r);
        },
      };
    },
  };
}
