import { Rating, State, createEmptyCard, fsrs } from "ts-fsrs";
import type { Card, Grade } from "ts-fsrs";
import type { FsrsState, ReviewStats, StoredCard } from "../types.ts";

/**
 * StoredCard ↔ ts-fsrs Card 的桥。
 *
 * ts-fsrs 用 `Date` 表示 due / last_review。chrome.storage 能存 Date，
 * 但导出成 JSON 再导入回来就变成了字符串，喂给算法会**静默**算出错误的间隔
 * ——不报错，只是复习计划悄悄乱掉。所以持久化一律用毫秒时间戳，
 * 进出算法时显式转换，并有 round-trip 测试盯着。
 */

const scheduler = fsrs();

/*
 * 调度层只认 FsrsState，不关心卡面上写的是一个单词还是一篇文章。
 * 生词卡（StoredCard）和文章卡（ArticleCard）各自在这层之上加自己的身份字段。
 */

export function toFsrs(card: Card): FsrsState {
  return {
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review ? card.last_review.getTime() : null,
  };
}

export function fromFsrs(s: FsrsState): Card {
  const card: Card = {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed_days,
    scheduled_days: s.scheduled_days,
    learning_steps: s.learning_steps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state as State,
  };
  // last_review 是可选字段：从没复习过的新卡不能带一个 Invalid Date 进去
  if (s.lastReview !== null) card.last_review = new Date(s.lastReview);
  return card;
}

export function newFsrs(now: number): FsrsState {
  return toFsrs(createEmptyCard(new Date(now)));
}

/* ---- 生词卡的薄包装，保持原有调用点不变 ---- */

export function toStored(card: Card, id: string, key: string, snippetIds: string[]): StoredCard {
  return { id, key, snippetIds, ...toFsrs(card) };
}

export const fromStored = (s: StoredCard): Card => fromFsrs(s);

export function newCard(id: string, key: string, snippetIds: string[], now: number): StoredCard {
  return { id, key, snippetIds, ...newFsrs(now) };
}

/** 四档评分。1=忘了 2=难 3=一般 4=简单，与 ts-fsrs 的 Rating 一致。 */
export type GradeValue = 1 | 2 | 3 | 4;

/**
 * 评分并推进调度。**保留卡面上的其余字段**——泛型让生词卡进来还是生词卡，
 * 文章卡进来还是文章卡，调度层不需要知道两者的区别。
 */
export function gradeFsrs<T extends FsrsState>(stored: T, grade: GradeValue, now: number): T {
  const { card } = scheduler.next(fromFsrs(stored), new Date(now), grade as Grade);
  return { ...stored, ...toFsrs(card) };
}

export const gradeCard = (stored: StoredCard, grade: GradeValue, now: number): StoredCard =>
  gradeFsrs(stored, grade, now);

/** 预览四个按钮各自会把卡推到多久之后，用来在按钮上显示"3天后""1个月后"。 */
export function previewIntervals(stored: FsrsState, now: number): Record<GradeValue, number> {
  const base = fromFsrs(stored);
  const at = new Date(now);
  const of = (g: GradeValue): number => scheduler.next(base, at, g as Grade).card.due.getTime();
  return { 1: of(1), 2: of(2), 3: of(3), 4: of(4) };
}

/** 到期的卡，最该复习的排前面（逾期越久越靠前）。 */
export function dueCards<T extends FsrsState>(cards: T[], now: number, limit?: number): T[] {
  const due = cards.filter((c) => c.due <= now).sort((a, b) => a.due - b.due);
  return limit === undefined ? due : due.slice(0, limit);
}

const DAY = 24 * 3600 * 1000;

export function reviewStats(cards: FsrsState[], now: number): ReviewStats {
  const forecast = new Array<number>(7).fill(0);
  // 以本地时间的今天零点为界，否则"明天到期"会随当前时刻漂移
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  for (const c of cards) {
    const dayIndex = Math.floor((c.due - startOfToday.getTime()) / DAY);
    if (dayIndex < 0) forecast[0]! += 1;
    else if (dayIndex < 7) forecast[dayIndex]! += 1;
  }
  return {
    total: cards.length,
    dueNow: cards.filter((c) => c.due <= now).length,
    newCount: cards.filter((c) => c.state === State.New).length,
    learningCount: cards.filter((c) => c.state === State.Learning || c.state === State.Relearning).length,
    reviewCount: cards.filter((c) => c.state === State.Review).length,
    forecast,
  };
}

export { Rating, State };
