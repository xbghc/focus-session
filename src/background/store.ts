import type {
  Article,
  ArticleCard,
  ArticleReview,
  ExportBundle,
  ParagraphRecord,
  ReadingPosition,
  Session,
  Settings,
  Snippet,
  SpeedSummary,
  StoredCard,
} from "../types.ts";
import { DEFAULT_SETTINGS, MAX_AUTO_WORDS } from "../types.ts";
import { isFinished } from "../lib/finish.ts";
import { type DataSet, type MergeReport, describeReport, emptyDataSet, mergeData, parseBundle } from "../lib/merge.ts";
import { summarizeSpeed } from "../lib/readingTime.ts";
import { mergeEpisodes } from "../lib/stats.ts";
import { KEY_CARDS, KEY_LLM, KEY_SNIPPETS, MAX_SNIPPETS, getLlmConfig } from "./vocab.ts";
import { KEY_ARTICLE_CARDS, REVIEW_PREFIX, articleCardWrites, reviewKey, textKey } from "./articleReview.ts";

export const KEY_SETTINGS = "settings";
export const KEY_ARTICLES = "articles";
export const KEY_SESSIONS = "sessions";
export const PARA_PREFIX = "p:";
export const paraKey = (articleId: string): string => PARA_PREFIX + articleId;
export const POS_PREFIX = "pos:";
export const posKey = (articleId: string): string => POS_PREFIX + articleId;
/** 个人阅读速度的缓存摘要，见 ensureSpeedSummary。content script 直接按这个键名读。 */
export const KEY_SPEED = "speed";
/** 安卓 App 的阅读器存下的正文（洗过的 HTML），见 src/app/read.ts。扩展里不会有这种键。 */
export const READER_PREFIX = "rh:";

/** 容量上限：storage.local 默认约 10MB，超出后写入会静默失败。 */
const MAX_SESSIONS = 5_000;
const MAX_ARTICLES = 1_000;

/**
 * 写入串行化。
 * MV3 的 service worker 会并发处理多个标签页的消息，两个 read-modify-write
 * 交错会丢数据，所以所有写操作排进同一条 promise 链。
 */
let chain: Promise<unknown> = Promise.resolve();
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

const local = () => chrome.storage.local;

export async function getSettings(): Promise<Settings> {
  const got = await local().get(KEY_SETTINGS);
  const stored = (got[KEY_SETTINGS] as Partial<Settings> & LegacySettings) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored, ...migrate(stored) };
}

type Stored = Partial<Settings> & LegacySettings;

interface LegacySettings {
  /** 早期版本里自动翻译上限是字符数。 */
  maxAutoSelectionChars?: number;
  /** 一次性标记：自动翻译上限从旧默认值抬上来那次迁移已经跑过。 */
  autoWordsRaised?: boolean;
}

/**
 * 迁移只在读的时候算，写回靠 setSettings 的整体合并顺带完成。
 * 两步互斥：走过字符换算的人不会再被抬默认值。
 */
function migrate(stored: Stored): Stored {
  return { ...migrateSelectionLimit(stored), ...raiseAutoWords(stored) };
}

/**
 * 字符阈值 → 词数阈值。
 * 不做这一步的话，把上限调到过 500 字符的用户会被静默重置回 40 词的默认值。
 *
 * 旧 key 会被 setSettings 的展开原样写回，一直留在 storage 里；无害，因为
 * 只要 Words 已存在这里就短路返回，迁移是幂等的。
 */
function migrateSelectionLimit(stored: Stored): Partial<Settings> {
  if (stored.maxAutoSelectionWords !== undefined) return {};
  const chars = stored.maxAutoSelectionChars;
  if (typeof chars !== "number" || !Number.isFinite(chars)) return {};
  return { maxAutoSelectionWords: Math.min(MAX_AUTO_WORDS, Math.max(3, Math.round(chars / 5.5))) };
}

/** 抬升前的默认值。 */
const OLD_AUTO_WORDS_DEFAULT = 40;

/**
 * 把停在旧默认值 40 词上的自动翻译上限抬到新默认值。
 *
 * 光改 DEFAULT_SETTINGS 不够：setSettings 每次都把完整的合并结果写回，
 * 所以只要在设置页动过任何一项，40 就已经固化在 storage 里，新默认值永远轮不到它。
 *
 * 代价是**当真手填过 40 的人也会被抬这一次**——40 恰好是旧默认值，存量里区分不出来。
 * 所以标记对每个人都落一次（不只落给被抬过的），否则以后有人主动填回 40，
 * 下次读取又会把它抬走，那个值就永远填不进去了。
 */
function raiseAutoWords(stored: Stored): Stored {
  if (stored.autoWordsRaised) return {};
  const stale = stored.maxAutoSelectionWords === OLD_AUTO_WORDS_DEFAULT;
  return {
    ...(stale ? { maxAutoSelectionWords: DEFAULT_SETTINGS.maxAutoSelectionWords } : {}),
    autoWordsRaised: true,
  };
}

/**
 * 把待迁移的设置**落盘**。
 *
 * 迁移平时只在 getSettings() 里现算，够不着 content script：那边读设置走的是原始的
 * `storage.local.get("settings")`（见 src/content/index.ts），绕过了这一层。
 * 不落盘的话，抬上来的阈值要等用户下次在设置页按一下保存才会到达页面——
 * 而"不用再点确认了"恰恰是这次改动唯一想让人感觉到的东西。
 *
 * service worker 每次醒来都会调它，所以先看有没有东西要迁；迁完落标记，
 * 之后这里就只剩一次小读取。写入还会顺带触发 storage.onChanged，
 * 已经打开的标签页当场热更新，不必刷新。
 */
export async function persistMigrations(): Promise<void> {
  const got = await local().get(KEY_SETTINGS);
  const stored = (got[KEY_SETTINGS] as Stored) ?? {};
  if (Object.keys(migrate(stored)).length === 0) return;
  await setSettings({});
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  return serialize(async () => {
    const merged = { ...(await getSettings()), ...patch };
    await local().set({ [KEY_SETTINGS]: merged });
    return merged;
  });
}

export async function getArticles(): Promise<Record<string, Article>> {
  const got = await local().get(KEY_ARTICLES);
  return (got[KEY_ARTICLES] as Record<string, Article>) ?? {};
}

export async function getSessions(): Promise<Session[]> {
  const got = await local().get(KEY_SESSIONS);
  return (got[KEY_SESSIONS] as Session[]) ?? [];
}

export async function getParagraphs(articleId: string): Promise<ParagraphRecord[]> {
  const key = paraKey(articleId);
  const got = await local().get(key);
  return (got[key] as ParagraphRecord[]) ?? [];
}

export async function getPosition(articleId: string): Promise<ReadingPosition | null> {
  const key = posKey(articleId);
  const got = await local().get(key);
  return (got[key] as ReadingPosition) ?? null;
}

export async function getSpeedSummary(): Promise<SpeedSummary | null> {
  const got = await local().get(KEY_SPEED);
  return (got[KEY_SPEED] as SpeedSummary) ?? null;
}

/**
 * 补一份个人阅读速度的摘要。
 *
 * 摘要平时在 commitSession 里顺手重算（那时 session 表就在手里）。但升级上来的存量用户
 * 在下一次 session 结束之前没有它，估计会退回一般速度——明明攒了几周的记录，
 * 界面却说"读得多了会更准"。所以 SW 每次启动补一次：有就什么都不做（一次小读取），
 * 没有才读整张 session 表。没有任何记录时也不写，写一份全零的没有意义。
 */
export async function ensureSpeedSummary(): Promise<void> {
  if ((await getSpeedSummary()) !== null) return;
  await serialize(async () => {
    if ((await getSpeedSummary()) !== null) return;
    const sessions = await getSessions();
    if (sessions.length === 0) return;
    await local().set({ [KEY_SPEED]: summarizeSpeed(sessions, Date.now()) });
  });
}

/**
 * 记下「上次读到哪」。
 *
 * **刻意不走 serialize**：这是一次整键覆盖写，没有读改写，没有可交错丢失的东西。
 * 同一篇文章开了两个标签页时最后写的赢——那正是想要的语义（最后离开的那一眼
 * 就是下次的落点），排队反而会让先写的那个赢。
 */
export async function savePosition(pos: ReadingPosition): Promise<void> {
  await local().set({ [posKey(pos.articleId)]: pos });
}

/** 注册/更新一篇文章的静态元信息（字数、标题），不触碰阅读进度。 */
export async function upsertArticleMeta(meta: {
  articleId: string;
  url: string;
  title: string;
  totalWords: number;
  trackedWords: number;
  paragraphCount: number;
  /** 按一般速度读完全部可观测段落要多久。老的调用方不带，退回上次记的。 */
  expectedMs?: number;
  now: number;
}): Promise<void> {
  await serialize(async () => {
    const articles = await getArticles();
    const prev = articles[meta.articleId];
    articles[meta.articleId] = {
      id: meta.articleId,
      url: meta.url,
      title: meta.title || prev?.title || meta.url,
      totalWords: meta.totalWords,
      trackedWords: meta.trackedWords,
      paragraphCount: meta.paragraphCount,
      wordsRead: prev?.wordsRead ?? 0,
      readParagraphCount: prev?.readParagraphCount ?? 0,
      sessionCount: prev?.sessionCount ?? 0,
      totalMs: prev?.totalMs ?? 0,
      maxSessionMs: prev?.maxSessionMs ?? 0,
      episodeCount: prev?.episodeCount ?? 0,
      maxEpisodeMs: prev?.maxEpisodeMs ?? 0,
      // 不补 0：老记录没有这个字段时要能退回 totalMs，见 lib/readingTime.ts 的 estimateArticle
      readingMs: prev?.readingMs,
      expectedMs: meta.expectedMs ?? prev?.expectedMs ?? 0,
      firstSeenTs: prev?.firstSeenTs ?? meta.now,
      lastSeenTs: meta.now,
      // 读完状态是 sticky 的：重新打开一篇读过的文章不该把它变回没读完
      reachedBottom: prev?.reachedBottom ?? false,
      finished: prev?.finished ?? false,
      finishedTs: prev?.finishedTs ?? null,
    };
    await local().set({ [KEY_ARTICLES]: prune(articles) });
  });
}

/**
 * 落库一个已完成的 session，并把段落快照合并进该文章的记录。
 * 段落按 hash 归并：firstSeenTs 取最早，dwellMs 累加——快照里的 dwellMs 是
 * **自上次快照以来的增量**（见 ParagraphTracker.snapshot），累加才是对的。
 */
export async function commitSession(
  session: Session,
  paragraphs: Array<{ index: number; hash: string; words: number; firstSeenTs: number; dwellMs: number }>,
  reachedBottom = false,
): Promise<void> {
  await serialize(async () => {
    const [sessions, articles] = await Promise.all([getSessions(), getArticles()]);

    // 同一片段可能被上报两次：后台先按最后一次心跳补记过，随后 content script
    // 又送来真正的结束消息。用 (articleId, startTs) 认身份，覆盖而不是追加。
    // 只在新来的那份更完整时才覆盖：补记的 endTs 必然 <= 真实结束时刻，
    // 这样两条消息谁先到都不影响结果。
    const dup = sessions.findIndex((s) => s.articleId === session.articleId && s.startTs === session.startTs);
    if (dup >= 0) {
      const prev = sessions[dup]!;
      if (session.endTs > prev.endTs) sessions[dup] = { ...session, id: prev.id };
    } else {
      sessions.push(session);
    }
    sessions.sort((a, b) => a.startTs - b.startTs);
    const trimmed = sessions.length > MAX_SESSIONS ? sessions.slice(-MAX_SESSIONS) : sessions;

    const writes: Record<string, unknown> = { [KEY_SESSIONS]: trimmed };
    // 个人阅读速度的摘要顺手重算：session 表此刻就在手里，不必另开一次全表读取
    writes[KEY_SPEED] = summarizeSpeed(trimmed, Date.now());

    if (paragraphs.length > 0) {
      const existing = await getParagraphs(session.articleId);
      const byHash = new Map(existing.map((r) => [r.hash, r]));
      for (const p of paragraphs) {
        const prev = byHash.get(p.hash);
        if (prev) {
          prev.index = p.index;
          prev.words = p.words;
          prev.dwellMs += p.dwellMs;
          if (p.firstSeenTs > 0 && (prev.firstSeenTs === 0 || p.firstSeenTs < prev.firstSeenTs)) {
            prev.firstSeenTs = p.firstSeenTs;
          }
        } else {
          byHash.set(p.hash, { ...p });
        }
      }
      const merged = [...byHash.values()].sort((a, b) => a.index - b.index);
      writes[paraKey(session.articleId)] = merged;

      const a = articles[session.articleId];
      if (a) {
        // 已读 = 曾累计到阅读阈值的段落。这里以存量记录为准重算，避免多标签页重复累加。
        const read = merged.filter((r) => r.firstSeenTs > 0);
        a.readParagraphCount = read.length;
        a.wordsRead = read.reduce((n, r) => n + r.words, 0);
      }
    }

    const a = articles[session.articleId];
    if (a) {
      const settings = await getSettings();
      // 从 session 列表重算而不是累加：这样覆盖式写入、历史漂移都会自动修正。
      // 代价是超出容量被淘汰的旧 session 会一并从聚合里消失。
      const mine = trimmed.filter((s) => s.articleId === session.articleId);
      a.sessionCount = mine.length;
      a.totalMs = mine.reduce((n, s) => n + (s.endTs - s.startTs), 0);
      a.maxSessionMs = mine.reduce((n, s) => Math.max(n, s.endTs - s.startTs), 0);
      // 只算读到新内容的片段：重读与停留的时间不该拉低这篇的阅读速度
      a.readingMs = mine.filter((s) => s.wordsRead > 0).reduce((n, s) => n + (s.endTs - s.startTs), 0);
      const episodes = mergeEpisodes(mine, settings.episodeGapMs);
      a.episodeCount = episodes.length;
      a.maxEpisodeMs = episodes.reduce((n, e) => Math.max(n, e.activeMs), 0);
      a.lastSeenTs = Math.max(a.lastSeenTs, session.endTs);
      a.title = session.title || a.title;
      if (reachedBottom) a.reachedBottom = true;
      // 一旦置位不再回退——否则事后调高阈值会把已经读完的文章批量变回未读。
      // 判定本身见 lib/finish.ts，content script 用的是同一把尺子。
      if (!a.finished) {
        if (isFinished({ ...a, finishRatio: settings.finishRatio })) {
          a.finished = true;
          a.finishedTs = session.endTs;
          // 读完的那一刻进回顾队列。articleCardWrites 是裸函数，不能换成
          // 自带 serialize 的写法——这里已经在串行队列里了，内层再排会死锁。
          Object.assign(writes, await articleCardWrites(a.id, true, session.endTs));
        }
      }
      writes[KEY_ARTICLES] = prune(articles);
    }

    await local().set(writes);
  });
}

/**
 * content script 在页内判定读完时调用。
 *
 * 和 `setFinished` 分开：那个是手动语义，无条件重置 `finishedTs`，取消分支还清
 * `reachedBottom`。这里必须**幂等**——心跳每 5s 判定一次，重复到达是常态，
 * 已经置位就直接走人，否则每一拍都在重写完成时刻。
 *
 * 为什么不等 session 结算：`commitSession` 只在 session 结束时跑，而 session
 * 结束意味着用户已经走神或离开了。要在他读完的当下弹回顾按钮，就得当场落盘，
 * 否则按钮点进去是「这篇还没读完」。之后那次 commitSession 会因 `!a.finished`
 * 守卫自然跳过，不会重复建卡。
 *
 * 返回的是**调用后这篇算不算读完**，不是"这次有没有翻转"。调用方（content script）
 * 只据此决定弹不弹角标：已经读完过同样该弹；文章没登记过（article:meta 丢了）
 * 才是唯一不该弹的情况——那时候点进去是死路。
 */
export async function markFinished(articleId: string, ts: number): Promise<boolean> {
  return serialize(async () => {
    const articles = await getArticles();
    const a = articles[articleId];
    if (!a) return false;
    if (a.finished) return true;
    a.finished = true;
    a.finishedTs = ts;
    // 判定是 content script 做的，这里把依据一并记下，免得后台自己的记录还说没触底
    a.reachedBottom = true;
    const writes: Record<string, unknown> = { [KEY_ARTICLES]: articles };
    // 同 commitSession：已经在 serialize 内，只能用裸函数把写入并进来
    Object.assign(writes, await articleCardWrites(articleId, true, ts));
    await local().set(writes);
    return true;
  });
}

/** 手动标记/取消"读完"。手动结果优先于自动判定，取消后也不会被下次 session 再自动置位。 */
export async function setFinished(articleId: string, finished: boolean): Promise<Article | null> {
  return serialize(async () => {
    const articles = await getArticles();
    const a = articles[articleId];
    if (!a) return null;
    a.finished = finished;
    a.finishedTs = finished ? Date.now() : null;
    // 手动取消时把触底标记也清掉，否则下一个 session 结算立刻又把它置回已读完
    if (!finished) a.reachedBottom = false;
    const writes: Record<string, unknown> = { [KEY_ARTICLES]: articles };
    // 同上：已经在 serialize 内，只能用裸函数把写入并进来
    Object.assign(writes, await articleCardWrites(articleId, finished, a.finishedTs ?? Date.now()));
    await local().set(writes);
    return a;
  });
}

/**
 * 超出上限时按最近访问时间淘汰，并连带删除段落记录、正文和回顾材料。
 *
 * 已知边界：articleCards 里对应的那张卡没有一起删，`reviewStats` 的总数会比
 * 队列里实际能渲染的多几张（articleReviewViews 会跳过孤儿卡）。要读满 1000 篇
 * 才碰得到，不值得为它在这条热路径上再读一次卡表。
 */
function prune(articles: Record<string, Article>): Record<string, Article> {
  const entries = Object.entries(articles);
  if (entries.length <= MAX_ARTICLES) return articles;
  entries.sort((a, b) => b[1].lastSeenTs - a[1].lastSeenTs);
  const keep = entries.slice(0, MAX_ARTICLES);
  const drop = entries.slice(MAX_ARTICLES);
  // 正文、回顾材料、阅读位置、App 阅读器缓存的正文都挂在文章上，文章没了它们就是孤儿
  void local().remove(drop.flatMap(([id]) => [paraKey(id), posKey(id), textKey(id), reviewKey(id), READER_PREFIX + id]));
  return Object.fromEntries(keep);
}

/** storage 里的全部记录，按 lib/merge.ts 的形状整理好。导出与导入共用。 */
function collect(all: Record<string, unknown>): DataSet {
  const data = emptyDataSet();
  data.articles = (all[KEY_ARTICLES] as Record<string, Article>) ?? {};
  data.sessions = (all[KEY_SESSIONS] as Session[]) ?? [];
  data.snippets = (all[KEY_SNIPPETS] as Snippet[]) ?? [];
  data.cards = (all[KEY_CARDS] as StoredCard[]) ?? [];
  data.articleCards = (all[KEY_ARTICLE_CARDS] as ArticleCard[]) ?? [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(PARA_PREFIX)) data.paragraphs[k.slice(PARA_PREFIX.length)] = v as ParagraphRecord[];
    else if (k.startsWith(POS_PREFIX)) data.positions[k.slice(POS_PREFIX.length)] = v as ReadingPosition;
    else if (k.startsWith(REVIEW_PREFIX)) data.articleReviews[k.slice(REVIEW_PREFIX.length)] = v as ArticleReview;
  }
  return data;
}

export async function exportAll(): Promise<ExportBundle> {
  const data = collect(await local().get(null));
  const llm = await getLlmConfig();
  return {
    schema: 4,
    exportedAt: Date.now(),
    settings: await getSettings(),
    articles: Object.values(data.articles),
    sessions: data.sessions,
    paragraphs: data.paragraphs,
    positions: Object.values(data.positions),
    snippets: data.snippets,
    cards: data.cards,
    articleReviews: Object.values(data.articleReviews),
    articleCards: data.articleCards,
    // 导出文件常被随手分享，密钥只导出"有没有设过"这一个 bit
    llm: {
      baseUrl: llm.baseUrl,
      model: llm.model,
      maxTokens: llm.maxTokens,
      timeoutMs: llm.timeoutMs,
      apiKeySet: llm.apiKey.length > 0,
    },
  };
}

export type ImportOutcome = { ok: true; report: MergeReport; message: string } | { ok: false; error: string };

/**
 * 把另一台设备的导出文件合并进来。规则全在 lib/merge.ts，这里只管读写。
 *
 * 整个过程在串行队列里：合并是一次大的读改写，中途插进来一条 session 结算就会丢东西。
 * 写回时只碰被对方数据触及的键：本机独有的文章一个字节都不动。
 * 容量上限照旧生效——超出的按最近访问淘汰，和平时一样。
 */
export async function importBundle(raw: unknown): Promise<ImportOutcome> {
  let incoming: DataSet;
  try {
    incoming = parseBundle(raw);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return serialize(async () => {
    const before = collect(await local().get(null));
    const settings = await getSettings();
    const { data, report } = mergeData(before, incoming, {
      now: Date.now(),
      finishRatio: settings.finishRatio,
      episodeGapMs: settings.episodeGapMs,
    });

    const sessions = data.sessions.length > MAX_SESSIONS ? data.sessions.slice(-MAX_SESSIONS) : data.sessions;
    const writes: Record<string, unknown> = {
      [KEY_ARTICLES]: prune(data.articles),
      [KEY_SESSIONS]: sessions,
      [KEY_SNIPPETS]: data.snippets.length > MAX_SNIPPETS ? data.snippets.slice(-MAX_SNIPPETS) : data.snippets,
      [KEY_CARDS]: data.cards,
      [KEY_ARTICLE_CARDS]: data.articleCards,
      // 速度摘要跟着重算：对方的片段也是你读的
      [KEY_SPEED]: summarizeSpeed(sessions, Date.now()),
    };
    for (const id of Object.keys(incoming.paragraphs)) writes[paraKey(id)] = data.paragraphs[id];
    for (const id of Object.keys(incoming.positions)) writes[posKey(id)] = data.positions[id];
    for (const id of Object.keys(incoming.articleReviews)) writes[reviewKey(id)] = data.articleReviews[id];
    await local().set(writes);
    return { ok: true, report, message: describeReport(report) };
  });
}

/** 清空全部记录，但保留设置与 LLM 配置（重填 API key 很烦）。 */
export async function clearData(): Promise<void> {
  await serialize(async () => {
    const all = await local().get(null);
    const keep = new Set<string>([KEY_SETTINGS, KEY_LLM]);
    await local().remove(Object.keys(all).filter((k) => !keep.has(k)));
  });
}
