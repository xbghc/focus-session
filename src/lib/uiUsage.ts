/**
 * 界面埋点：首页上每个能点的东西各被用了多少次。
 *
 * 为什么要有——改界面全凭感觉。搜索框占着一整行是不是值得、「黑名单建议」有没有人点过，
 * 以前只能猜。这里只记**次数**，按天分桶：不记点的是哪篇文章、搜了什么词、什么时刻点的，
 * 所以这份东西里没有阅读内容，只有「哪个按钮、哪天、几次」。
 *
 * 事件是一张写死的表而不是随手起的字符串，两个原因：
 * 一，要回答「哪些极少用到」就得知道**全集**——从没被点过的按钮在计数里根本不出现，
 * 只有拿这张表去对，才列得出那些零；二，表外的名字一律不收，存下来的东西有上限。
 *
 * 纯函数，不碰 storage；落盘在 background/uiUsage.ts，按天分桶是为了改完界面之后
 * 能比「改之前的三十天」和「改之后的七天」，只留一个总数的话这件事做不了。
 */

/** 表里的顺序就是报表里同次数时的顺序：按页面从上到下、从左到右排。 */
export const UI_EVENTS = {
  "page.open": "打开首页",
  "nav.articles": "导航 · 文章",
  "nav.review": "导航 · 复习",
  "nav.words": "导航 · 生词本",
  "nav.options": "导航 · 设置",

  "articles.filter.all": "文章 · 筛选「全部」",
  "articles.filter.reading": "文章 · 筛选「未读完」",
  "articles.filter.done": "文章 · 筛选「已读完」",
  "articles.search.open": "文章 · 展开搜索",
  "articles.search.query": "文章 · 输入了搜索词",
  "articles.manage": "文章 · 进入批量管理",
  "articles.open": "文章 · 点标题打开原文",
  "articles.detail": "文章 · 展开详情",
  "articles.detail.more": "文章 · 详情里「显示全部」",
  "articles.review": "文章 · 回顾",
  "articles.finish": "文章 · 标记读完",
  "articles.unfinish": "文章 · 标记未读完",
  "articles.select-all": "批量 · 全选",
  "articles.delete": "批量 · 删除所选",
  "articles.classify": "批量 · LLM 筛选",
  "articles.classify.pick": "批量 · 勾选非文章",
  "articles.classify.retry": "批量 · 重试失败项",
  "articles.classify.stop": "批量 · 停止后续请求",
  "articles.blacklist.suggest": "批量 · 黑名单建议",
  "articles.blacklist.apply": "批量 · 采用黑名单建议",

  "review.queue.words": "复习 · 切到生词队列",
  "review.queue.articles": "复习 · 切到文章队列",
  "review.words.reveal": "生词卡 · 显示答案",
  "review.words.grade": "生词卡 · 评分",
  "review.assist.example": "生词卡 · 再给个例句",
  "review.assist.explain": "生词卡 · 换个说法讲",
  "review.assist.quiz": "生词卡 · 考我一下",
  "review.articles.reveal": "文章卡 · 翻开看大纲",
  "review.articles.grade": "文章卡 · 评分",
  "review.articles.source": "文章卡 · 打开原文",
  "review.articles.generate": "文章卡 · 生成 / 重新生成回顾材料",
  /** 和上面四个翻卡、评分的事件**叠着记**：占比 = 它 ÷ 那四个之和，看键盘流有没有人用。 */
  "review.by-key": "复习 · 其中用键盘（空格、1–4）",

  "words.search": "生词本 · 输入了搜索词",
  "words.kind": "生词本 · 按粒度筛选",
  "words.enqueue": "生词本 · 加入复习",
  "words.delete": "生词本 · 删除（确认之后）",
  "words.source": "生词本 · 点出处打开原文",
  "speak": "点音标朗读",
} as const;

export type UiEvent = keyof typeof UI_EVENTS;

export const isUiEvent = (name: unknown): name is UiEvent =>
  typeof name === "string" && Object.hasOwn(UI_EVENTS, name);

export interface UiUsageLog {
  /** 第一次记数的那天。装上才三天的话什么都是零，看报表得先知道统计了多久。 */
  since: string | null;
  /** 日期（本地，`2026-09-19`）→ 事件 → 次数。 */
  days: Record<string, Record<string, number>>;
}

export const emptyUiUsage = (): UiUsageLog => ({ since: null, days: {} });

/** 留这么多天。一天一桶、一桶至多几十个数，整份也就几十 KB。 */
export const UI_USAGE_DAYS = 90;

const DAY_MS = 86_400_000;

/** 本地日期。按用户的「今天」分桶，不按 UTC——东八区早上八点之前点的不该算到昨天头上。 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 存下来的东西不一定是这一版写的，也可能被手改过；形状不对的部分当没有。 */
export function normalizeUiUsage(value: unknown): UiUsageLog {
  const raw = (value ?? {}) as Partial<UiUsageLog>;
  const log = emptyUiUsage();
  if (typeof raw.since === "string") log.since = raw.since;
  if (raw.days && typeof raw.days === "object") {
    for (const [day, counts] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !counts || typeof counts !== "object") continue;
      const kept: Record<string, number> = {};
      for (const [name, n] of Object.entries(counts)) {
        if (isUiEvent(name) && Number.isSafeInteger(n) && n > 0) kept[name] = n;
      }
      if (Object.keys(kept).length > 0) log.days[day] = kept;
    }
  }
  return log;
}

/** 记一批。表外的名字丢掉；顺手把过期的桶清了。返回新对象，不改传进来的。 */
export function bumpUiUsage(log: UiUsageLog, names: readonly unknown[], now: number): UiUsageLog {
  const today = dayKey(now);
  const oldest = dayKey(now - (UI_USAGE_DAYS - 1) * DAY_MS);
  const days: UiUsageLog["days"] = {};
  // 日期是补零的 ISO 形式，字符串比较就是日期比较
  for (const [day, counts] of Object.entries(log.days)) if (day >= oldest) days[day] = { ...counts };
  const valid = names.filter(isUiEvent);
  if (valid.length > 0) {
    const bucket = (days[today] ??= {});
    for (const name of valid) bucket[name] = (bucket[name] ?? 0) + 1;
  }
  return { since: log.since ?? (valid.length > 0 ? today : null), days };
}

export interface UiUsageRow {
  name: UiEvent;
  label: string;
  last7: number;
  last30: number;
  /** 保留期（90 天）内的总数。 */
  total: number;
}

export interface UiUsageSummary {
  since: string | null;
  /** 有过记录的天数。「90 天里只用过 4 天」和「天天用」读数的方式不一样。 */
  activeDays: number;
  /** 表里的**每一个**事件都有一行，零也列；次数多的在前，同次数按表里的顺序。 */
  rows: UiUsageRow[];
}

export function summarizeUiUsage(log: UiUsageLog, now: number): UiUsageSummary {
  const from7 = dayKey(now - 6 * DAY_MS);
  const from30 = dayKey(now - 29 * DAY_MS);
  const oldest = dayKey(now - (UI_USAGE_DAYS - 1) * DAY_MS);
  const rows = (Object.keys(UI_EVENTS) as UiEvent[]).map((name): UiUsageRow => ({
    name, label: UI_EVENTS[name], last7: 0, last30: 0, total: 0,
  }));
  const byName = new Map(rows.map((row) => [row.name as string, row]));
  let activeDays = 0;
  for (const [day, counts] of Object.entries(log.days)) {
    if (day < oldest) continue;
    activeDays += 1;
    for (const [name, n] of Object.entries(counts)) {
      const row = byName.get(name);
      if (!row) continue;
      row.total += n;
      if (day >= from30) row.last30 += n;
      if (day >= from7) row.last7 += n;
    }
  }
  const order = new Map(rows.map((row, i) => [row.name, i]));
  rows.sort((a, b) => b.total - a.total || order.get(a.name)! - order.get(b.name)!);
  return { since: log.since, activeDays, rows };
}

/* ==================== 页面这一头：攒一攒再发 ==================== */

/**
 * 点一下发一条的话，每一下都是一次整库读改写（见 sync/storage.ts 的 set），还会顺带排一轮同步。
 * 复习时两三秒翻一张卡，没必要这么勤。攒几秒一起发；页面要走的时候把手里的先交掉。
 */
export const UI_FLUSH_MS = 5_000;

export interface UiTracker {
  track(name: UiEvent): void;
  /** 立刻把攒着的发掉。页面隐藏、离开时调。 */
  flush(): void;
}

export function createUiTracker(deliver: (events: UiEvent[]) => void, delayMs = UI_FLUSH_MS): UiTracker {
  let pending: UiEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    // 埋点是附属品：发不出去就丢掉，不能反过来让按钮的正事报错
    try { deliver(batch); } catch { /* 见上 */ }
  };
  return {
    track(name) {
      pending.push(name);
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
  };
}
