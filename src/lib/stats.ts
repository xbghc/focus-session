import type { EndReason, Episode, Overview, ReasonBreakdown, Session } from "../types.ts";

/** 线性插值分位数；输入无需预先排序。 */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loV = sorted[lo] ?? 0;
  if (lo === hi) return loV;
  const hiV = sorted[hi] ?? loV;
  return loV + (hiV - loV) * (pos - lo);
}

/** 字/分钟。时长为 0 时返回 0 而不是 Infinity。 */
export function wordsPerMinute(words: number, ms: number): number {
  if (ms <= 0) return 0;
  return (words / ms) * 60_000;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const REASONS: readonly EndReason[] = ["idle", "stall", "hidden", "blur", "unload", "recovered"];

/**
 * 把同一篇文章内间隔不超过 gapMs 的相邻 session 合成一个「回合」。
 *
 * session 的边界是「输入信号中断」，而阅读本身不产生输入：切去查个东西再回来、
 * 安静读一屏后被 idle 切断，都会把一次连续投入切成一串片段。回合把它们接回去。
 *
 * 阈值怎么选：Halfaker 等人 (2015) 在七个系统上发现 inter-activity time 的对数直方图
 * 普遍双峰——within-session 模式在 ~1 分钟、between-session 在 ~1 天——切分点该放在两峰之间的谷。
 * 本项目实测数据的谷在 5–30 分钟，默认取 5 分钟。**阈值是结果的一部分**，所以它随
 * Overview 一并回传，界面上要写明。
 */
export function mergeEpisodes(sessions: readonly Session[], gapMs: number): Episode[] {
  const byArticle = new Map<string, Session[]>();
  for (const s of sessions) {
    const list = byArticle.get(s.articleId);
    if (list) list.push(s);
    else byArticle.set(s.articleId, [s]);
  }
  const out: Episode[] = [];
  for (const list of byArticle.values()) {
    list.sort((a, b) => a.startTs - b.startTs);
    let cur: Episode | null = null;
    for (const s of list) {
      const ms = s.endTs - s.startTs;
      if (cur && s.startTs - cur.endTs <= gapMs) {
        cur.endTs = Math.max(cur.endTs, s.endTs);
        cur.sessionCount += 1;
        cur.activeMs += ms;
        cur.wordsRead += s.wordsRead;
      } else {
        if (cur) out.push(cur);
        cur = {
          articleId: s.articleId,
          startTs: s.startTs,
          endTs: s.endTs,
          sessionCount: 1,
          activeMs: ms,
          wordsRead: s.wordsRead,
        };
      }
    }
    if (cur) out.push(cur);
  }
  return out.sort((a, b) => a.startTs - b.startTs);
}

/** 各结束原因的片段数与时长。所有原因都在，没出现的为 0，界面不用判空。 */
export function breakdownByReason(sessions: readonly Session[]): ReasonBreakdown {
  const out = Object.fromEntries(REASONS.map((r) => [r, { count: 0, ms: 0 }])) as ReasonBreakdown;
  for (const s of sessions) {
    const slot = out[s.endReason];
    slot.count += 1;
    slot.ms += s.endTs - s.startTs;
  }
  return out;
}

/**
 * 近 N 天概览。原始片段的分位数保留，但它量的是「两次输入事件的间隔」，不是注意力长度；
 * 回合、结束原因构成、切换频率、读到新内容的时长占比才是能指导行为的数字。
 */
export function buildOverview(
  sessions: readonly Session[],
  now: number,
  opts: { windowMs: number; episodeGapMs: number },
): Overview {
  const since = now - opts.windowMs;
  const recent = sessions.filter((s) => s.endTs >= since);
  const durations = recent.map((s) => s.endTs - s.startTs);
  const totalMs = durations.reduce((a, b) => a + b, 0);
  const episodes = mergeEpisodes(recent, opts.episodeGapMs);
  const episodeMs = episodes.map((e) => e.activeMs);
  const byReason = breakdownByReason(recent);
  const switches = byReason.blur.count + byReason.hidden.count;
  return {
    windowMs: opts.windowMs,
    episodeGapMs: opts.episodeGapMs,
    sessionCount: recent.length,
    totalMs,
    medianMs: quantile(durations, 0.5),
    p90Ms: quantile(durations, 0.9),
    articleCount: new Set(recent.map((s) => s.articleId)).size,
    wordsRead: recent.reduce((n, s) => n + s.wordsRead, 0),
    readingMs: recent.filter((s) => s.wordsRead > 0).reduce((n, s) => n + (s.endTs - s.startTs), 0),
    episodeCount: episodes.length,
    episodeMedianMs: quantile(episodeMs, 0.5),
    episodeP90Ms: quantile(episodeMs, 0.9),
    longestEpisodeMs: episodeMs.reduce((a, b) => Math.max(a, b), 0),
    byReason,
    switchesPerHour: totalMs > 0 ? switches / (totalMs / 3_600_000) : 0,
  };
}

/**
 * Gloria Mark 等人对信息工作者的日志测量：屏幕上的停留中位 40 秒、均值 47 秒
 * （CHI 2016，40 人两周），折成每小时约 76 次切换。只作对照，不作评判。
 */
export const MARK_SWITCHES_PER_HOUR = 3600 / 47;

/**
 * 只在数据支持时才说话的解读。每一条都有触发条件——一句在任何数据下都显示的解读，
 * 等于没有解读。
 */
export function overviewInsights(o: Overview): string[] {
  const out: string[] = [];
  if (o.sessionCount === 0) return out;

  if (o.episodeCount > 0 && o.sessionCount / o.episodeCount >= 1.5) {
    out.push(
      `${o.sessionCount} 个片段合成 ${o.episodeCount} 个回合：注意力常在几分钟内回到同一篇文章，` +
        `片段中位数（${formatDuration(o.medianMs)}）低估了连续投入，回合中位 ${formatDuration(o.episodeMedianMs)} 更接近真实。`,
    );
  }

  const switching = o.byReason.blur.count + o.byReason.hidden.count;
  if (o.totalMs >= 10 * 60_000 && switching / o.sessionCount >= 0.5) {
    out.push(
      `每小时切换 ${Math.round(o.switchesPerHour)} 次：一半以上的片段以切到别处结束` +
        `（对照：Mark 等人测得信息工作者约每 47 秒切换一次，≈ ${Math.round(MARK_SWITCHES_PER_HOUR)} 次/时）。`,
    );
  }

  if (o.totalMs >= 10 * 60_000 && o.readingMs / o.totalMs < 0.5) {
    out.push(
      `只有 ${Math.round((o.readingMs / o.totalMs) * 100)}% 的专注时长读到了新段落——其余是回看、停留，或页面开着没在读。`,
    );
  }
  return out;
}
