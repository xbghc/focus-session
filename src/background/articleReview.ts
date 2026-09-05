import type {
  ArticleCard,
  ArticleReview,
  ArticleReviewOutcome,
  ArticleReviewState,
  ArticleReviewView,
  ArticleText,
  ReviewStats,
} from "../types.ts";
import { LlmError } from "../lib/llm.ts";
import { MAX_REVIEW_CHARS, clipText, generateArticleReview } from "../lib/articleReview.ts";
import { type GradeValue, dueCards, gradeFsrs, newFsrs, reviewStats } from "../lib/review.ts";
import { addUsage, getLlmConfig } from "./vocab.ts";
import { recordFailure } from "./llmLog.ts";
import { getArticles, serialize } from "./store.ts";

/**
 * 文章级回顾的存储与生成编排。
 *
 * 与生词卡刻意分开存：`attachSnippets` / `dueCards` / `reviewStats` 那套
 * 全都假定卡面是一个词，混在一起要么处处加过滤，要么 7 天预测把文章数
 * 算进生词量里。调度算法（lib/review.ts）是共用的，只有身份字段不同。
 */

export const TEXT_PREFIX = "t:";
export const REVIEW_PREFIX = "r:";
export const KEY_ARTICLE_CARDS = "articleCards";

export const textKey = (articleId: string): string => TEXT_PREFIX + articleId;
export const reviewKey = (articleId: string): string => REVIEW_PREFIX + articleId;

const local = (): chrome.storage.StorageArea => chrome.storage.local;

/* ==================== 正文 ==================== */

export async function getArticleText(articleId: string): Promise<ArticleText | null> {
  const k = textKey(articleId);
  const got = await local().get(k);
  return (got[k] as ArticleText | undefined) ?? null;
}

/**
 * 存下正文。content script 在读到 finishRatio 时送来一次。
 * 已经存过就不覆盖——同一篇文章重读会再送一次，没必要写第二遍。
 */
export async function saveArticleText(articleId: string, text: string, fullChars: number): Promise<boolean> {
  return serialize(async () => {
    if (await getArticleText(articleId)) return false;
    const clipped = clipText(text, MAX_REVIEW_CHARS);
    const rec: ArticleText = { articleId, text: clipped, fullChars, savedTs: Date.now() };
    await local().set({ [textKey(articleId)]: rec });
    return true;
  });
}

/* ==================== 回顾材料 ==================== */

export async function getArticleReview(articleId: string): Promise<ArticleReview | null> {
  const k = reviewKey(articleId);
  const got = await local().get(k);
  return (got[k] as ArticleReview | undefined) ?? null;
}

/**
 * 生成中的请求按 articleId 合流。
 *
 * 触发点有两个：读到 80% 时后台自动生成，和用户在界面上点「回顾」。
 * 一篇 5000 字的文章生成要十几秒，这两件事撞在一起是常态——
 * 读完立刻打开面板正好落在生成窗口里。
 */
const generating = new Map<string, Promise<ArticleReviewOutcome>>();

/**
 * 拿到回顾材料，没有就生成。
 *
 * LLM 调用**不能**放在 serialize 里：一次要十几秒，会把所有写入堵住。
 * 只有最后写回结果的那一下进串行队列。
 */
export function ensureArticleReview(articleId: string, regenerate = false): Promise<ArticleReviewOutcome> {
  const running = generating.get(articleId);
  if (running) return running;

  const task = (async (): Promise<ArticleReviewOutcome> => {
    try {
      if (!regenerate) {
        const have = await getArticleReview(articleId);
        if (have) return { ok: true, review: have };
      }

      const text = await getArticleText(articleId);
      if (!text) return { ok: false, noText: true, error: "这篇文章的正文没有存下来" };

      const article = (await getArticles())[articleId];
      const config = await getLlmConfig();
      try {
        const { review, usage } = await generateArticleReview(
          {
            title: article?.title ?? "",
            url: article?.url ?? articleId,
            text: text.text,
            fullChars: text.fullChars,
          },
          config,
          Date.now(),
        );
        await addUsage(usage.inputTokens, usage.outputTokens);
        const full: ArticleReview = { articleId, ...review };
        await serialize(async () => {
          await local().set({ [reviewKey(articleId)]: full });
        });
        return { ok: true, review: full };
      } catch (err) {
        // 配置缺失不算一次失败的调用，别污染用量统计
        if (!(err instanceof LlmError && err.kind === "config")) await addUsage(0, 0, true);
        const needsConfig = err instanceof LlmError && err.kind === "config";
        // 只留标题、URL 和字数：正文几十 KB 一篇，且是可再抓取的输入，不该进日志
        await recordFailure(err, config, {
          source: "articleReview",
          request: { title: article?.title ?? "", url: article?.url ?? articleId, fullChars: text.fullChars },
        });
        return { ok: false, error: err instanceof Error ? err.message : String(err), needsConfig };
      }
    } finally {
      generating.delete(articleId);
    }
  })();

  generating.set(articleId, task);
  return task;
}

/* ==================== 回顾卡 ==================== */

export async function getArticleCards(): Promise<ArticleCard[]> {
  const got = await local().get(KEY_ARTICLE_CARDS);
  return (got[KEY_ARTICLE_CARDS] as ArticleCard[] | undefined) ?? [];
}

/**
 * 算出「读完状态变化」需要写入的文章卡集合。
 *
 * **不自己 serialize**：唯二的调用方 commitSession / setFinished 本身就跑在
 * 串行队列里，内层再排一次会和外层互相等待——死锁，而且悄无声息。
 * 返回的键值对由调用方并进它那一次 `local().set`。
 */
export async function articleCardWrites(
  articleId: string,
  finished: boolean,
  now: number,
): Promise<Record<string, unknown>> {
  const cards = await getArticleCards();
  const at = cards.findIndex((c) => c.articleId === articleId);

  if (finished) {
    if (at >= 0) return {}; // 已经有卡，重读一遍不该把调度重置
    return { [KEY_ARTICLE_CARDS]: [...cards, { articleId, ...newFsrs(now) }] };
  }
  // 手动取消「读完」时把卡撤掉，否则它还赖在回顾队列里
  if (at < 0) return {};
  return { [KEY_ARTICLE_CARDS]: cards.filter((c) => c.articleId !== articleId) };
}

/**
 * 给「已经读完、正文也在，却还没有卡」的文章补一张。
 *
 * 为什么需要：articleCardWrites 只在 finished **从 false 翻成 true** 的那一刻建卡。
 * 这个功能上线之前读完的文章，finished 早就是 true 了，那次翻转永远不会再发生，
 * 于是它们永远进不了回顾队列。
 *
 * 只在用户主动点「回顾」时调，不做 onInstalled 全量迁移——那会让几十篇没有正文的
 * 老文章同时「到期」，队列里全是「还没有回顾材料」。
 * 也因此**要求正文在**：没正文就补卡，等于往循环队列里塞一堆看不了的东西。
 */
export async function ensureArticleCard(articleId: string, now: number): Promise<void> {
  await serialize(async () => {
    const [cards, articles, got] = await Promise.all([
      getArticleCards(),
      getArticles(),
      local().get(textKey(articleId)),
    ]);
    if (!articles[articleId]?.finished) return;
    if (got[textKey(articleId)] === undefined) return;
    if (cards.some((c) => c.articleId === articleId)) return;
    await local().set({ [KEY_ARTICLE_CARDS]: [...cards, { articleId, ...newFsrs(now) }] });
  });
}

export async function gradeArticleCard(articleId: string, grade: GradeValue, now: number): Promise<ArticleCard | null> {
  return serialize(async () => {
    const cards = await getArticleCards();
    const at = cards.findIndex((c) => c.articleId === articleId);
    if (at < 0) return null;
    const next = gradeFsrs(cards[at]!, grade, now);
    cards[at] = next;
    await local().set({ [KEY_ARTICLE_CARDS]: cards });
    return next;
  });
}

/**
 * 取回顾视图，附上文章元信息和已生成的材料。
 *
 * 指定 articleId 时**不看到期时间**——从文章列表点「回顾」是随时想看就看，
 * 和排期队列是两回事。
 */
export async function articleReviewViews(
  now: number,
  opts: { limit?: number; articleId?: string } = {},
): Promise<ArticleReviewView[]> {
  const [cards, articles] = await Promise.all([getArticleCards(), getArticles()]);
  const due = opts.articleId
    ? cards.filter((c) => c.articleId === opts.articleId)
    : dueCards(cards, now, opts.limit);
  if (due.length === 0) return [];

  // 一次取回所有材料，别一篇一篇 get
  const got = await local().get(due.map((c) => reviewKey(c.articleId)));
  const views: ArticleReviewView[] = [];
  for (const card of due) {
    const article = articles[card.articleId];
    // 文章记录被容量淘汰后，卡就成了孤儿，跳过
    if (!article) continue;
    views.push({ card, article, review: (got[reviewKey(card.articleId)] as ArticleReview | undefined) ?? null });
  }
  return views;
}

/** 只读，不触发生成。popup 每次打开都会问一次，得便宜。 */
export async function articleReviewState(articleId: string): Promise<ArticleReviewState> {
  // 顺手把老文章的卡补上：用户能看到这一行，说明他正看着这篇
  await ensureArticleCard(articleId, Date.now());
  const [got, cards, articles] = await Promise.all([
    local().get([textKey(articleId), reviewKey(articleId)]),
    getArticleCards(),
    getArticles(),
  ]);
  return {
    finished: articles[articleId]?.finished === true,
    hasText: got[textKey(articleId)] !== undefined,
    hasReview: got[reviewKey(articleId)] !== undefined,
    carded: cards.some((c) => c.articleId === articleId),
  };
}

export async function articleReviewStats(now: number): Promise<ReviewStats> {
  return reviewStats(await getArticleCards(), now);
}
