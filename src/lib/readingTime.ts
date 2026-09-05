import type { Article, ReadingEstimate, ReadingTarget, Session, SpeedEvidence, SpeedSummary } from "../types.ts";
import { LATIN_WPM } from "./reading.ts";

/**
 * 「这篇还要读多久」的估计，用阅读历史校准。
 *
 * 一般速度（lib/reading.ts 的 238 wpm / 400 字/分）是人群均值，个体差异很大：
 * Brysbaert 给的常见区间是 175–300，读外语还要再打折。所以估计分三层，每一层都拿上一层
 * 当先验、用自己的证据往回拉：
 *
 *   一般速度 ──(近 30 天的整体记录)──▶ 你的速度 ──(这一篇自己的记录)──▶ 这一篇的节奏
 *
 * 融合就是加权平均：把先验当作「按先验速度读了 W 毫秒」的一段虚拟记录，和真实记录合在
 * 一起算字数 ÷ 时长。证据少时几乎就是先验，证据一多先验就淡出，中间没有跳变。
 *
 * 速度的口径与界面上的「字/分」一致：中日韩按字、拉丁按词，字数除以**读到了新内容的**
 * 片段时长。不用段落 dwellMs——同屏的几段各自都在累计停留，加起来是重复计时；
 * 存量数据里它还因为早期的重复累加而虚高。
 *
 * 已知的粗糙处：历史速度是混合口径，中英文都读得多的人，估计会偏向读得多的那种文字。
 * 要分文种就得在 session 上分开记字数，目前不值得为此改存储结构。
 */

/** 先验权重：一般速度相当于多长的阅读记录。读满这么久，你自己的数据就和先验各占一半。 */
export const PERSONAL_PRIOR_MS = 5 * 60_000;
/** 同上，用在「这一篇自己的节奏」对「你的整体速度」上。文章之间难度差得远，让本篇更快说话。 */
export const ARTICLE_PRIOR_MS = 3 * 60_000;
/** 个人速度只看近这么多天：读的东西换了类型、状态变了，几个月前的速度不再代表现在。 */
export const SPEED_WINDOW_DAYS = 30;

const DAY_MS = 24 * 3600 * 1000;

/**
 * 从 session 历史归纳个人阅读速度的证据。
 *
 * 只取读到新内容（wordsRead > 0）的片段：重读、翻回去找一句话、页面开着没在读，
 * 这些时间不该算进"读一个字要多久"。近 30 天的证据不足先验权重时退回全部历史——
 * 旧数据也比人群均值更像你；`windowDays` 记着用的是哪一种。
 */
export function summarizeSpeed(sessions: readonly Session[], now: number): SpeedSummary {
  const reading = sessions.filter((s) => s.wordsRead > 0 && s.endTs > s.startTs);
  const since = now - SPEED_WINDOW_DAYS * DAY_MS;
  const recent = total(reading.filter((s) => s.endTs >= since));
  if (recent.ms >= PERSONAL_PRIOR_MS) return { ...recent, windowDays: SPEED_WINDOW_DAYS, updatedTs: now };
  return { ...total(reading), windowDays: 0, updatedTs: now };
}

function total(list: readonly Session[]): SpeedEvidence & { sessions: number } {
  let words = 0;
  let ms = 0;
  for (const s of list) {
    words += s.wordsRead;
    ms += s.endTs - s.startTs;
  }
  return { words, ms, sessions: list.length };
}

/** 先验速度与证据的加权平均，单位字/毫秒。没有证据就是先验本身。 */
function blend(evidence: SpeedEvidence | null | undefined, prior: number, priorMs: number): number {
  if (!evidence || evidence.ms <= 0 || evidence.words <= 0) return prior;
  return (evidence.words + prior * priorMs) / (evidence.ms + priorMs);
}

export interface EstimateEvidence {
  /** 这一篇自己的记录：已读字数与读到新内容的时长。 */
  article?: SpeedEvidence | null;
  /** 你的整体记录，一般就是后台缓存的 SpeedSummary。 */
  personal?: (SpeedEvidence & { windowDays?: number }) | null;
}

/**
 * 估计读完 `target` 需要多久。
 *
 * `target.expectedMs` 是按一般速度、分文种算出来的预计时长（见 lib/reading.ts），
 * 它决定了先验：同样 1000 字，中文 2.5 分钟、英文 4.2 分钟。老记录没有它时按英文均速——
 * 这个工具主要用来读英文，而且有了个人数据之后先验本来就没多少分量。
 */
export function estimateReading(target: ReadingTarget, evidence: EstimateEvidence = {}): ReadingEstimate {
  const words = Math.max(0, target.words);
  const general = words > 0 && target.expectedMs > 0 ? words / target.expectedMs : LATIN_WPM / 60_000;
  const personal = blend(evidence.personal, general, PERSONAL_PRIOR_MS);
  const article = blend(evidence.article, personal, ARTICLE_PRIOR_MS);
  // 夹在一般速度的 1/4–4 倍之间：时钟跳变、补记出来的超长片段这类坏数据不该把估计推到荒谬
  const speed = Math.min(general * 4, Math.max(general / 4, article));

  const articleMs = evidence.article?.ms ?? 0;
  const personalMs = evidence.personal?.ms ?? 0;
  // 证据量过了先验权重（自己的数据占到一半以上）才敢说"按你的速度"
  const basis = articleMs >= ARTICLE_PRIOR_MS ? "article" : personalMs >= PERSONAL_PRIOR_MS ? "personal" : "default";

  return {
    words,
    ms: words > 0 ? Math.round(words / speed) : 0,
    wordsPerMinute: Math.round(speed * 60_000),
    basis,
    windowDays: evidence.personal?.windowDays ?? 0,
  };
}

/**
 * 对一条文章记录估「还需多久」。
 *
 * 剩余部分的文种构成按整篇的比例折算——已读的具体是哪几段这里不知道，
 * 但一篇文章内部的文种通常是均匀的。没有可观测段落（抽取失败）的记录估不了，返回 null。
 */
export function estimateArticle(
  a: Pick<Article, "trackedWords" | "wordsRead" | "totalMs" | "readingMs" | "expectedMs">,
  personal: EstimateEvidence["personal"],
): ReadingEstimate | null {
  if (a.trackedWords <= 0) return null;
  const words = Math.max(0, a.trackedWords - a.wordsRead);
  const known = a.expectedMs ?? 0;
  const expectedMs = known > 0 ? (known * words) / a.trackedWords : (words / LATIN_WPM) * 60_000;
  return estimateReading(
    { words, expectedMs },
    // 老记录没有 readingMs，退回总时长——重读的时间也被算进去，估得偏慢，但有总比没有强
    { article: { words: a.wordsRead, ms: a.readingMs ?? a.totalMs }, personal },
  );
}

/**
 * 「约 12 分钟」这样的说法。
 *
 * 20 分钟以内按分钟给，再往上按 5 分钟取整、过了一小时报小时——
 * 这个估计本来就没有分钟级的精度，写成「约 47 分钟」是在假装。
 */
export function formatEstimate(ms: number): string {
  const min = Math.round(Math.max(0, ms) / 60_000);
  if (min < 1) return "不到 1 分钟";
  if (min < 20) return `约 ${min} 分钟`;
  const rounded = Math.round(min / 5) * 5;
  if (rounded < 60) return `约 ${rounded} 分钟`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `约 ${h} 小时` : `约 ${h} 小时 ${m} 分钟`;
}

/** 估计是怎么来的，一句话。放在数字旁边，让人知道该信几分。 */
export function describeBasis(e: ReadingEstimate): string {
  switch (e.basis) {
    case "article":
      return `按你读这篇的节奏（${e.wordsPerMinute} 字/分）`;
    case "personal":
      return e.windowDays > 0
        ? `按你近 ${e.windowDays} 天的速度（${e.wordsPerMinute} 字/分）`
        : `按你过往的速度（${e.wordsPerMinute} 字/分）`;
    default:
      return "按一般速度估计，读得多了会改按你自己的速度";
  }
}
