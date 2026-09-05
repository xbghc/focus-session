import type {
  AnyMessage,
  ContentToBg,
  Overview,
  PopupToBg,
  ReadingPosition,
  Session,
  Settings,
  TranslatePortIn,
  TranslatePortOut,
} from "../types.ts";
import { buildOverview } from "../lib/stats.ts";
import { samePosition } from "../lib/position.ts";
import { dueCards, reviewStats } from "../lib/review.ts";
import { type StreamHandle, handleAssist, streamTranslate, testConnection } from "./translate.ts";
import { clearLlmLog, llmLogBundle } from "./llmLog.ts";
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
  attachSnippets,
  deleteSnippet,
  enqueueSnippet,
  getCards,
  getLlmConfig,
  getSnippets,
  getUsage,
  gradeStoredCard,
  setLlmConfig,
} from "./vocab.ts";
import {
  clearData,
  commitSession,
  ensureSpeedSummary,
  exportAll,
  getArticles,
  getParagraphs,
  getSessions,
  getSettings,
  getSpeedSummary,
  importBundle,
  markFinished,
  persistMigrations,
  savePosition,
  serialize,
  setFinished,
  setSettings,
  upsertArticleMeta,
} from "./store.ts";

/**
 * 消息处理的本体。
 *
 * 从 index.ts 里拆出来，是因为它有**两个宿主**：扩展的 service worker
 * （index.ts 把它挂到 chrome.runtime.onMessage 上），以及安卓 App 的页面
 * （src/app/shim.ts 把 chrome.runtime.sendMessage 直接接到这个函数上）。
 * 这里只认 `chrome.storage` / `chrome.tabs.create` / `chrome.runtime.openOptionsPage`
 * 这几个能被垫片提供的 API，不碰 onMessage / onConnect 之类只有扩展才有的注册点。
 */

/** 启动路径上的两件补课。不 await：没人等它，做不完下次醒来会再来一遍。 */
export function boot(): void {
  // 设置迁移要真写进 storage 才算数，见 persistMigrations 的说明。
  void persistMigrations();
  // 存量用户升级上来时还没有阅读速度的摘要，补一次；已有就只是一次小读取。
  void ensureSpeedSummary();
}

/** 发消息的一方。扩展里是 chrome.runtime.MessageSender，App 里由垫片造一个带 tab id 的。 */
export interface Sender {
  tab?: { id?: number };
}

/** 进行中的 session。存在 storage.session 里：SW 被回收后仍在，浏览器关闭即弃。 */
interface OpenSession {
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
  await mutateOpen((m) => {
    delete m[String(tabId)];
  });
  const s = settings ?? (await getSettings());
  const endTs = Math.max(o.startTs, o.lastBeatTs);
  if (endTs - o.startTs < s.minSessionMs) return;
  await commitSession(
    {
      id: crypto.randomUUID(),
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
}

/** 近 7 天概览。口径全在 lib/stats.ts，这里只负责取数。 */
async function overview(): Promise<Overview> {
  const [sessions, settings] = await Promise.all([getSessions(), getSettings()]);
  return buildOverview(sessions, Date.now(), {
    windowMs: 7 * 24 * 3600 * 1000,
    episodeGapMs: settings.episodeGapMs,
  });
}

export async function handle(msg: AnyMessage, sender: Sender): Promise<unknown> {
  const tabId = sender.tab?.id;

  switch (msg.type) {
    /* ---- content script ---- */
    case "article:meta": {
      const m = (msg as Extract<ContentToBg, { type: "article:meta" }>).meta;
      await upsertArticleMeta({ ...m, now: Date.now() });
      return { ok: true };
    }
    case "session:start": {
      if (tabId === undefined) return { ok: false };
      const m = msg as Extract<ContentToBg, { type: "session:start" }>;
      // 同一标签页若还挂着旧 session，说明结束消息丢了，先补记
      await recoverOpen(tabId);
      await mutateOpen((open) => {
        open[String(tabId)] = {
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
    }
    case "session:heartbeat": {
      if (tabId === undefined) return { ok: false };
      const m = msg as Extract<ContentToBg, { type: "session:heartbeat" }>;
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
    }
    case "session:end": {
      const m = msg as Extract<ContentToBg, { type: "session:end" }>;
      // 位置先存，且**不看 discard**：discard 过滤的是不值得入库的时长碎片，
      // 而"翻了两页就被叫走"的那两页照样要记住落点。
      if (m.position) await savePosition(m.position);
      // url/title 从进行中的记录里取，省一次文章表查询，也不受消息乱序影响
      const o = tabId === undefined ? undefined : (await getOpen())[String(tabId)];
      if (tabId !== undefined) {
        await mutateOpen((open) => {
          delete open[String(tabId)];
        });
      }
      if (m.discard) return { ok: true, discarded: true };
      const known = (await getArticles())[m.articleId];
      const session: Session = {
        id: crypto.randomUUID(),
        articleId: m.articleId,
        url: o?.url ?? known?.url ?? m.articleId,
        title: o?.title ?? known?.title ?? "",
        startTs: m.startTs,
        endTs: m.endTs,
        wordsRead: m.wordsRead,
        endReason: m.endReason,
      };
      await commitSession(session, m.paragraphs, m.reachedBottom);
      return { ok: true };
    }

    case "article:text": {
      const m = msg as Extract<ContentToBg, { type: "article:text" }>;
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
    }

    case "article:finished": {
      const m = msg as Extract<ContentToBg, { type: "article:finished" }>;
      // marked 是"这篇现在算不算读完"。content script 据此决定弹不弹角标：
      // SW 正在重启时这条消息直接失败，下一拍心跳自然重试，
      // 好过弹一个点进去还没建卡的按钮。
      const marked = await markFinished(m.articleId, m.ts);
      return { ok: true, marked };
    }
    case "review:open": {
      const m = msg as Extract<ContentToBg, { type: "review:open" }>;
      await chrome.tabs.create({
        url: chrome.runtime.getURL("dashboard.html") + "#review:" + encodeURIComponent(m.articleId),
      });
      return { ok: true };
    }

    /* ---- popup / options ---- */
    case "articles:list": {
      const articles = Object.values(await getArticles()).sort((a, b) => b.lastSeenTs - a.lastSeenTs);
      // 速度摘要一并带上：列表里每篇「还需多久」都要拿它当先验
      return { articles, speed: await getSpeedSummary() };
    }
    case "article:sessions": {
      const id = (msg as Extract<PopupToBg, { type: "article:sessions" }>).articleId;
      const sessions = (await getSessions()).filter((s) => s.articleId === id).sort((a, b) => a.startTs - b.startTs);
      return { sessions, paragraphs: await getParagraphs(id) };
    }
    case "stats:overview":
      return await overview();
    case "data:export":
      return await exportAll();
    case "data:import":
      return await importBundle((msg as Extract<PopupToBg, { type: "data:import" }>).bundle);
    case "data:clear":
      await clearData();
      return { ok: true };
    case "settings:get":
      return await getSettings();
    case "settings:set":
      return await setSettings((msg as Extract<PopupToBg, { type: "settings:set" }>).settings);

    /* ---- 划词翻译 ---- */
    // 翻译本身走 port（见 attachTranslatePort），这里只剩两条轻消息
    case "sw:ping":
      // 空消息，唯一作用是唤醒 service worker——MV3 里 SW 空闲 30s 就休眠，
      // 冷启动要 200–500ms。content script 在 mousedown 时打这一下，
      // 等选完、过完防抖再发翻译请求时 SW 已经醒着了。
      return { ok: true };
    case "options:open":
      // content script 打不开扩展页，只能请后台代劳
      await chrome.runtime.openOptionsPage();
      return { ok: true };

    case "snippets:list": {
      const { articleId } = msg as Extract<PopupToBg, { type: "snippets:list" }>;
      const all = await getSnippets();
      const list = articleId ? all.filter((s) => s.articleId === articleId) : all;
      return { snippets: list.sort((a, b) => b.createdTs - a.createdTs) };
    }
    case "snippet:delete":
      await deleteSnippet((msg as Extract<PopupToBg, { type: "snippet:delete" }>).id);
      return { ok: true };
    case "snippet:enqueue": {
      const card = await enqueueSnippet((msg as Extract<PopupToBg, { type: "snippet:enqueue" }>).id, Date.now());
      return { ok: card !== null, card };
    }
    case "article:finish": {
      const m = msg as Extract<PopupToBg, { type: "article:finish" }>;
      const article = await setFinished(m.articleId, m.finished);
      return { ok: article !== null, article };
    }

    /* ---- 复习 ---- */
    case "review:due": {
      const m = msg as Extract<PopupToBg, { type: "review:due" }>;
      const [cards, snippets] = await Promise.all([getCards(), getSnippets()]);
      const now = Date.now();
      return { cards: attachSnippets(dueCards(cards, now, m.limit), snippets), stats: reviewStats(cards, now) };
    }
    case "review:grade": {
      const m = msg as Extract<PopupToBg, { type: "review:grade" }>;
      const card = await gradeStoredCard(m.cardId, m.grade, Date.now());
      return { ok: card !== null, card };
    }
    case "review:stats":
      return reviewStats(await getCards(), Date.now());
    case "review:assist": {
      const m = msg as Extract<PopupToBg, { type: "review:assist" }>;
      const [cards, snippets] = await Promise.all([getCards(), getSnippets()]);
      const card = cards.find((c) => c.id === m.cardId);
      if (!card) return { ok: false, error: "卡片不存在" };
      const view = attachSnippets([card], snippets)[0]!;
      const s = view.snippet;
      return await handleAssist(m.mode, {
        key: card.key,
        translation: s?.translation ?? "",
        originalText: s?.context || s?.text || card.key,
        context: s?.context ?? "",
        articleTitle: s?.articleTitle ?? "",
      });
    }

    /* ---- 文章回顾 ---- */
    case "article:review": {
      const m = msg as Extract<PopupToBg, { type: "article:review" }>;
      return await ensureArticleReview(m.articleId, m.regenerate === true);
    }
    case "article:review-due": {
      const m = msg as Extract<PopupToBg, { type: "article:review-due" }>;
      const now = Date.now();
      // 指定某一篇 = 用户主动点了「回顾」，顺手把上线前读完的老文章补上卡
      if (m.articleId) await ensureArticleCard(m.articleId, now);
      const items = await articleReviewViews(now, { limit: m.limit, articleId: m.articleId });
      return { items, stats: await articleReviewStats(now) };
    }
    case "article:review-state":
      return await articleReviewState((msg as Extract<PopupToBg, { type: "article:review-state" }>).articleId);
    case "article:review-grade": {
      const m = msg as Extract<PopupToBg, { type: "article:review-grade" }>;
      const card = await gradeArticleCard(m.articleId, m.grade, Date.now());
      return { ok: card !== null, card };
    }

    /* ---- LLM 配置 ---- */
    case "llm:get": {
      const cfg = await getLlmConfig();
      // 密钥只回传"设没设过"，不回显——popup/options 都没有必要拿到明文
      return { ...cfg, apiKey: "", apiKeySet: cfg.apiKey.length > 0 };
    }
    case "llm:set":
      await setLlmConfig((msg as Extract<PopupToBg, { type: "llm:set" }>).config);
      return { ok: true };
    case "llm:test":
      return await testConnection();
    case "llm:usage":
      return await getUsage();

    /* ---- 诊断日志 ---- */
    case "llm:log":
      return await llmLogBundle(chrome.runtime.getManifest().version);
    case "llm:log-clear":
      await clearLlmLog();
      return { ok: true };

    default:
      return { ok: false, error: "unknown message" };
  }
}

/**
 * 流式翻译用的 port 的最小形状。chrome.runtime.Port 天然满足；
 * App 里的垫片造一个同形的对象接进来。
 */
export interface PortLike {
  postMessage(msg: TranslatePortOut): void;
  disconnect(): void;
  onMessage: { addListener(fn: (msg: TranslatePortIn) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

/**
 * 划词翻译走 port 而不是 sendMessage：一次请求要推多次增量，
 * 而 sendMessage 一个请求只允许一次应答。
 *
 * 附带一个好处：port 开着期间 service worker 不会被回收，流不会被腰斩。
 */
export function attachTranslatePort(port: PortLike): void {
  let handle: StreamHandle | null = null;
  let closed = false;

  const post = (msg: TranslatePortOut): void => {
    if (closed) return;
    try {
      port.postMessage(msg);
    } catch {
      /* 页面已卸载，port 已失效 */
    }
  };

  port.onDisconnect.addListener(() => {
    closed = true;
    // 浮层关了 / 页面走了，别再烧 token
    handle?.cancel();
  });

  port.onMessage.addListener((msg: TranslatePortIn) => {
    if (msg?.type !== "start" || handle) return;
    const h = streamTranslate(msg.req, (partial) => post({ type: "partial", partial }));
    handle = h;
    void h.done.then(
      (res) => {
        post({ type: "done", res });
        if (!closed) port.disconnect();
      },
      (err: unknown) => {
        post({ type: "done", res: { ok: false, error: String(err), needsConfig: false } });
        if (!closed) port.disconnect();
      },
    );
  });
}
