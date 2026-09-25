import { classifyPage, classifyHistoryArticle, suggestBlacklist } from "./articleFilter.ts";
import { localStorage } from "../../sync/storage.ts";
import { syncBefore } from "../../sync/engine.ts";
import { saveArchive } from "../../archive/background.ts";
import { normalizeUrl } from "../../lib/url.ts";
import type { Overview, ReadingPosition, Session, Settings } from "../../types.ts";
import { buildOverview } from "../../lib/stats.ts";
import { samePosition } from "../../lib/position.ts";
import {
  articleReviewState,
  articleReviewStats,
  articleReviewViews,
  getArticleReview,
  ensureArticleCard,
  ensureArticleReview,
  gradeArticleCard,
  saveArticleText,
} from "./articleReview.ts";
import {
  deleteArticles,
  commitSession,
  ensureSpeedSummary,
  getArticles,
  getParagraphs,
  getSessions,
  getSettings,
  getSpeedSummary,
  markFinished,
  savePosition,
  serialize,
  setFinished,
  upsertArticleMeta,
} from "../../background/store.ts";
import type { HandlerMap } from "../../core/background/router.ts";

/*
 * 专注记录的后台一半：进行中的 session、文章与段落、LLM 文章判别、读完与文章回顾、存档。
 */

/** 启动时补一次：存量用户升级上来时还没有阅读速度的摘要；已有就只是一次小读取。 */
export function bootReading(): void {
  void ensureSpeedSummary();
}

/** 进行中的 session。存在 storage.session 里：SW 被回收后仍在，浏览器关闭即弃。 */
interface OpenSession {
  id?: string;
  tabId: number;
  articleId: string;
  url: string;
  title: string;
  startTs: number;
  /** 最后一次心跳时刻，标签页被关时用它作为 endTs 补记。 */
  lastBeatTs: number;
  wordsRead: number;
  /**
   * 最后一次落盘的阅读位置。**只用来去重**——位置本身已经写进 storage.local 了，
   * 这里留一份是为了让「安静读一屏、位置没变」的心跳不必每 5 秒重写一次。
   */
  position?: ReadingPosition;
}

const KEY_OPEN = "open";
/** Firefox 128 之前没有 storage.session，退回 local。 */
const ephemeral = (): chrome.storage.StorageArea => chrome.storage.session ?? chrome.storage.local;

export async function getOpen(): Promise<Record<string, OpenSession>> {
  const got = await ephemeral().get(KEY_OPEN);
  return (got[KEY_OPEN] as Record<string, OpenSession>) ?? {};
}

/** 走同一条串行队列：多个标签页的消息交错读改写会丢掉其中一份。 */
async function mutateOpen(fn: (open: Record<string, OpenSession>) => void): Promise<void> {
  await serialize(async () => {
    const open = await getOpen();
    fn(open);
    await ephemeral().set({ [KEY_OPEN]: open });
  });
}

/**
 * 把一个悬空的 session 补记入库。
 * 触发时机：标签页被关、导航离开、或同一标签页又开了新 session 而旧的没收到结束消息。
 * 结束时刻取最后一次心跳——之后发生了什么无从得知，不该凭空计入。
 */
export async function recoverOpen(tabId: number, settings?: Settings): Promise<void> {
  const open = await getOpen();
  const o = open[String(tabId)];
  if (!o) return;
  const s = settings ?? (await getSettings());
  const endTs = Math.max(o.startTs, o.lastBeatTs);
  if (endTs - o.startTs >= s.minSessionMs) await commitSession(
    {
      id: o.id ?? crypto.randomUUID(),
      articleId: o.articleId,
      url: o.url,
      title: o.title,
      startTs: o.startTs,
      endTs,
      wordsRead: o.wordsRead,
      endReason: "recovered",
    },
    [],
  );
  // Keep the recovery checkpoint until the durable session/outbox commit succeeds.
  await mutateOpen(m=>{if(m[String(tabId)]?.startTs===o.startTs)delete m[String(tabId)];});
}

/** 近 7 天概览。口径全在 lib/stats.ts，这里只负责取数。 */
async function overview(): Promise<Overview> {
  const [sessions, settings] = await Promise.all([getSessions(), getSettings()]);
  return buildOverview(sessions, Date.now(), {
    windowMs: 7 * 24 * 3600 * 1000,
    episodeGapMs: settings.episodeGapMs,
  });
}

export const readingHandlers = {
  "archive:save": (msg, sender) => {
    if (sender.url && new URL(sender.url).protocol !== "chrome-extension:" && normalizeUrl(sender.url) !== msg.payload.articleId) throw new Error("只能保存当前页面的文章");
    return saveArchive(msg.payload);
  },
  "article:local-state": async (msg) => {
    // 续读位置可能是另一台设备几秒前才写的：先等一轮拉取（有上限），再读
    await syncBefore();
    return localStorage().get([`p:${msg.articleId}`, `pos:${msg.articleId}`, "articles", "speed"]);
  },
  "article:classify": (msg) => {
    // 判别要问模型，少说一两秒。同步趁这会儿先跑起来，等轮到上面那条读位置时多半已经是新的了，不用再等
    void syncBefore();
    return classifyPage(msg.url, msg.title, msg.text);
  },
  "article:classify-history": (msg) => classifyHistoryArticle(msg.articleId),
  "articles:blacklist-suggest": (msg) => suggestBlacklist(msg.articleIds),
  "articles:delete": async (msg) => {
    const deleted = await deleteArticles(msg.articleIds);
    await mutateOpen(open => {
      for (const [key, session] of Object.entries(open)) if (msg.articleIds.includes(session.articleId)) delete open[key];
    });
    return { ok: true, deleted };
  },

  /* ---- content script ---- */
  "article:meta": async (msg) => {
    await upsertArticleMeta({ ...msg.meta, now: Date.now() });
    return { ok: true };
  },
  "session:start": async (m, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { ok: false };
    // 同一标签页若还挂着旧 session，说明结束消息丢了，先补记
    await recoverOpen(tabId);
    await mutateOpen((open) => {
      open[String(tabId)] = {
        id: crypto.randomUUID(),
        tabId,
        articleId: m.articleId,
        url: m.url,
        title: m.title,
        startTs: m.startTs,
        lastBeatTs: m.startTs,
        wordsRead: 0,
      };
    });
    return { ok: true };
  },
  "session:heartbeat": async (m, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { ok: false };
    // 没有 open 记录（浏览器重启后 storage.session 已空）时按"变了"处理：
    // 宁可多写一次，也不要把这一拍的位置丢掉。
    let moved = m.position !== undefined;
    await mutateOpen((open) => {
      const o = open[String(tabId)];
      if (!o) return;
      o.lastBeatTs = m.now;
      o.wordsRead = m.wordsRead;
      if (!m.position) return;
      moved = !samePosition(o.position, m.position);
      if (moved) o.position = m.position;
    });
    if (m.position && moved) await savePosition(m.position);
    return { ok: true };
  },
  "session:end": async (m, sender) => {
    const tabId = sender.tab?.id;
    // 位置先存，且**不看 discard**：discard 过滤的是不值得入库的时长碎片，
    // 而"翻了两页就被叫走"的那两页照样要记住落点。
    if (m.position) await savePosition(m.position);
    // url/title 从进行中的记录里取，省一次文章表查询，也不受消息乱序影响
    const candidate = tabId === undefined ? undefined : (await getOpen())[String(tabId)];
    const o = candidate?.startTs === m.startTs ? candidate : undefined;
    const close = async () => {
      if (tabId !== undefined) {
        await mutateOpen((open) => {
          if (open[String(tabId)]?.startTs === m.startTs) delete open[String(tabId)];
        });
      }
    };
    if (m.discard) { await close(); return { ok: true, discarded: true }; }
    const known = (await getArticles())[m.articleId];
    const session: Session = {
      id: o?.id ?? crypto.randomUUID(),
      articleId: m.articleId,
      url: o?.url ?? known?.url ?? m.articleId,
      title: o?.title ?? known?.title ?? "",
      startTs: m.startTs,
      endTs: m.endTs,
      wordsRead: m.wordsRead,
      endReason: m.endReason,
    };
    await commitSession(session, m.paragraphs, m.reachedBottom);
    await close();
    return { ok: true };
  },
  "article:text": async (m) => {
    const stored = await saveArticleText(m.articleId, m.text, m.fullChars);
    // 存下的那一刻就开始生成：这时用户通常还在读最后 20%，
    // 等他读完，材料已经备好，点开是秒开的。失败不上报——
    // 用户没主动要这次调用，界面上也没有等它的地方；真要用时会按需重试。
    // 不能只在"这次刚存下"时生成：首读时没配 key 会失败，之后重读 stored 是 false，
    // 80% 预生成的承诺就落空了。只要还没有材料就再试一次。
    if (stored || (await getArticleReview(m.articleId)) === null) {
      void ensureArticleReview(m.articleId).catch(() => undefined);
    }
    return { ok: true, stored };
  },
  "article:finished": async (m) => {
    // marked 是"这篇现在算不算读完"。content script 据此决定弹不弹角标：
    // SW 正在重启时这条消息直接失败，下一拍心跳自然重试，
    // 好过弹一个点进去还没建卡的按钮。
    const marked = await markFinished(m.articleId, m.ts);
    return { ok: true, marked };
  },
  "review:open": async (m) => {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("dashboard.html") + "#review:" + encodeURIComponent(m.articleId),
    });
    return { ok: true };
  },

  /* ---- popup / 首页 ---- */
  "articles:list": async () => {
    /*
     * 有人要看文章列表了——多半是刚放下手机、来电脑上找那篇。列表照旧立刻用本机的答，不等网络；
     * 同时催一轮同步（十秒内刚同步过、正在退避都不跑），拉到新东西会广播 `sync:updated`，页面再取一次。
     * 扩展平时一分钟才拉一回，不催的话「刚读的那篇」最坏要等满一分钟才进得了本机。
     */
    void syncBefore();
    const articles = Object.values(await getArticles()).sort((a, b) => b.lastSeenTs - a.lastSeenTs);
    // 速度摘要一并带上：列表里每篇「还需多久」都要拿它当先验
    return { articles, speed: await getSpeedSummary() };
  },
  "article:sessions": async (msg) => {
    const id = msg.articleId;
    const sessions = (await getSessions()).filter((s) => s.articleId === id).sort((a, b) => a.startTs - b.startTs);
    return { sessions, paragraphs: await getParagraphs(id) };
  },
  "stats:overview": () => overview(),
  "article:finish": async (m) => {
    const article = await setFinished(m.articleId, m.finished);
    return { ok: article !== null, article };
  },

  /* ---- 文章回顾 ---- */
  "article:review": (m) => ensureArticleReview(m.articleId, m.regenerate === true),
  "article:review-due": async (m) => {
    const now = Date.now();
    // 指定某一篇 = 用户主动点了「回顾」，顺手把上线前读完的老文章补上卡
    if (m.articleId) await ensureArticleCard(m.articleId, now);
    const items = await articleReviewViews(now, { limit: m.limit, articleId: m.articleId });
    return { items, stats: await articleReviewStats(now) };
  },
  "article:review-state": (m) => articleReviewState(m.articleId),
  "article:review-grade": async (m) => {
    const card = await gradeArticleCard(m.articleId, m.grade, Date.now());
    return { ok: card !== null, card };
  },
} satisfies HandlerMap;
