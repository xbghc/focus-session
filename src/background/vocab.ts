import type { LlmConfig, LlmUsage, ReviewCardView, Snippet, StoredCard, TranslationResult } from "../types.ts";
import { DEFAULT_LLM, EMPTY_USAGE } from "../types.ts";
import { cardKeyOf } from "../lib/lang.ts";
import { type GradeValue, gradeCard, newCard } from "../lib/review.ts";
import { serialize } from "./store.ts";

/**
 * 划词记录、复习卡片、LLM 配置的持久化。
 *
 * 所有写操作都走 store.ts 那条串行队列——service worker 会并发处理多个标签页
 * 的消息，两个 read-modify-write 交错会丢数据。
 */

export const KEY_SNIPPETS = "snippets";
export const KEY_CARDS = "cards";
export const KEY_LLM = "llm";
export const KEY_USAGE = "llmUsage";

/** 与 store.ts 的 MAX_SESSIONS 同源的考虑：storage.local 约 10MB，超了静默失败。 */
export const MAX_SNIPPETS = 5_000;

const local = (): chrome.storage.StorageArea => chrome.storage.local;

/* ==================== LLM 配置 ==================== */

/**
 * 单独一个 key，**绝不并进 Settings**。
 * content script 启动时会把整个 settings 对象读进页面上下文，而 content script
 * 与网页共享同一个渲染进程——API key 出现在那里等于交给了页面上的任意脚本。
 */
export async function getLlmConfig(): Promise<LlmConfig> {
  const got = await local().get(KEY_LLM);
  const stored = (got[KEY_LLM] as StoredLlm) ?? {};
  return { ...DEFAULT_LLM, ...stored, ...raiseBudget(stored) };
}

type StoredLlm = Partial<LlmConfig> & {
  /** 一次性标记：输出上限与超时的默认值那次抬升已经跑过。 */
  budgetRaised?: boolean;
};

/** 抬升前的两个默认值。 */
const OLD_MAX_TOKENS = 1024;
const OLD_TIMEOUT_MS = 30_000;

/**
 * 把停在旧默认值上的输出上限与超时抬上来。
 *
 * 1024 是照着"只翻一句、没有讲解"定的，讲解上线后就显小了——实测 200 词的选区
 * 要 671 个输出 token，只剩三成余量。而 max_tokens 压低换不来省钱（见 LlmConfig 的说明），
 * 只换来截断，所以没有理由留着。超时一起抬：上限松了而超时没松，
 * 只是把"被截断"换成了"超时"。
 *
 * 和设置里那次阈值抬升同一套做法、同一份代价（当真手填过 1024 的人也会被抬这一次），
 * 见 store.ts 的 raiseAutoWords。这里不必像那边一样主动落盘：
 * LLM 配置只有 background 读，没有绕过这一层的读法。
 */
function raiseBudget(stored: StoredLlm): StoredLlm {
  if (stored.budgetRaised) return {};
  return {
    ...(stored.maxTokens === OLD_MAX_TOKENS ? { maxTokens: DEFAULT_LLM.maxTokens } : {}),
    ...(stored.timeoutMs === OLD_TIMEOUT_MS ? { timeoutMs: DEFAULT_LLM.timeoutMs } : {}),
    budgetRaised: true,
  };
}

export async function setLlmConfig(patch: Partial<LlmConfig>): Promise<LlmConfig> {
  return serialize(async () => {
    const merged = { ...(await getLlmConfig()), ...patch };
    await local().set({ [KEY_LLM]: merged });
    return merged;
  });
}

export async function getUsage(): Promise<LlmUsage> {
  const got = await local().get(KEY_USAGE);
  return { ...EMPTY_USAGE, ...((got[KEY_USAGE] as Partial<LlmUsage>) ?? {}) };
}

export async function addUsage(input: number, output: number, failed = false): Promise<void> {
  await serialize(async () => {
    const u = await getUsage();
    await local().set({
      [KEY_USAGE]: {
        requests: u.requests + 1,
        inputTokens: u.inputTokens + input,
        outputTokens: u.outputTokens + output,
        errors: u.errors + (failed ? 1 : 0),
        lastTs: Date.now(),
      } satisfies LlmUsage,
    });
  });
}

/* ==================== 划词记录 ==================== */

/**
 * 读出全部划词。
 *
 * 顺手补齐讲解字段：**「英语老师模式」之前存下的记录没有 usage / vocab**，
 * 让它们以 undefined 流到界面上，渲染时到处都要 `?? []`。在唯一的入口补一次，
 * 类型就不必说谎；下一次写回时这两个字段会一并落盘，算是一次惰性迁移。
 */
export async function getSnippets(): Promise<Snippet[]> {
  const got = await local().get(KEY_SNIPPETS);
  const list = (got[KEY_SNIPPETS] as Snippet[]) ?? [];
  for (const s of list) {
    s.usage ??= null;
    s.vocab ??= [];
  }
  return list;
}

export async function getCards(): Promise<StoredCard[]> {
  const got = await local().get(KEY_CARDS);
  return (got[KEY_CARDS] as StoredCard[]) ?? [];
}

export interface AddSnippetInput {
  articleId: string;
  url: string;
  articleTitle: string;
  text: string;
  kind: Snippet["kind"];
  context: string;
  result: TranslationResult;
  now: number;
}

/**
 * 记下一条划词，并按需要挂到复习卡片上。
 *
 * 入队规则（用户定的）：词与短语自动入队，整句只记录不排期。
 * 合并规则（我定的）：同一个词元跨文章只有**一张**卡，多条 snippet 挂在它下面
 * ——否则 leak / leaks / leaked 会变成三张卡轮流来烦你。
 */
export async function addSnippet(input: AddSnippetInput): Promise<{ snippet: Snippet; card: StoredCard | null }> {
  return serialize(async () => {
    const [snippets, cards] = await Promise.all([getSnippets(), getCards()]);

    const snippet: Snippet = {
      id: crypto.randomUUID(),
      articleId: input.articleId,
      url: input.url,
      articleTitle: input.articleTitle,
      text: input.text,
      kind: input.kind,
      context: input.context,
      createdTs: input.now,
      translation: input.result.translation,
      contextNote: input.result.contextNote,
      pos: input.result.pos,
      phonetic: input.result.phonetic,
      lemma: input.result.lemma,
      usage: input.result.usage,
      vocab: input.result.vocab,
      cardId: null,
    };

    let card: StoredCard | null = null;
    if (input.kind !== "sentence") {
      const key = cardKeyOf(input.text, input.result.lemma);
      const existing = cards.find((c) => c.key === key);
      if (existing) {
        existing.snippetIds.push(snippet.id);
        card = existing;
      } else {
        card = newCard(crypto.randomUUID(), key, [snippet.id], input.now);
        cards.push(card);
      }
      snippet.cardId = card.id;
    }

    snippets.push(snippet);
    const trimmed = snippets.length > MAX_SNIPPETS ? snippets.slice(-MAX_SNIPPETS) : snippets;
    await local().set({ [KEY_SNIPPETS]: trimmed, [KEY_CARDS]: cards });
    return { snippet, card };
  });
}

/** 手动把一条整句记录加入复习队列。 */
export async function enqueueSnippet(snippetId: string, now: number): Promise<StoredCard | null> {
  return serialize(async () => {
    const [snippets, cards] = await Promise.all([getSnippets(), getCards()]);
    const s = snippets.find((x) => x.id === snippetId);
    if (!s || s.cardId) return null;
    const key = cardKeyOf(s.text, s.lemma);
    let card = cards.find((c) => c.key === key);
    if (card) {
      card.snippetIds.push(s.id);
    } else {
      card = newCard(crypto.randomUUID(), key, [s.id], now);
      cards.push(card);
    }
    s.cardId = card.id;
    await local().set({ [KEY_SNIPPETS]: snippets, [KEY_CARDS]: cards });
    return card;
  });
}

/**
 * 删一条划词。若它是所属卡片的最后一条来源，卡片一并删除——
 * 留下一张没有任何语境的卡，复习时只能看到一个孤零零的单词。
 */
export async function deleteSnippet(snippetId: string): Promise<void> {
  await serialize(async () => {
    const [snippets, cards] = await Promise.all([getSnippets(), getCards()]);
    const s = snippets.find((x) => x.id === snippetId);
    if (!s) return;
    const rest = snippets.filter((x) => x.id !== snippetId);
    let nextCards = cards;
    if (s.cardId) {
      const card = cards.find((c) => c.id === s.cardId);
      if (card) {
        card.snippetIds = card.snippetIds.filter((id) => id !== snippetId);
        if (card.snippetIds.length === 0) nextCards = cards.filter((c) => c.id !== card.id);
      }
    }
    await local().set({ [KEY_SNIPPETS]: rest, [KEY_CARDS]: nextCards });
  });
}

export async function gradeStoredCard(cardId: string, grade: GradeValue, now: number): Promise<StoredCard | null> {
  return serialize(async () => {
    const cards = await getCards();
    const i = cards.findIndex((c) => c.id === cardId);
    if (i < 0) return null;
    const next = gradeCard(cards[i]!, grade, now);
    cards[i] = next;
    await local().set({ [KEY_CARDS]: cards });
    return next;
  });
}

/** 给一批卡片配上展示用的 snippet：取最近划到的那条，它的语境最新鲜。 */
export function attachSnippets(cards: StoredCard[], snippets: Snippet[]): ReviewCardView[] {
  const byId = new Map(snippets.map((s) => [s.id, s]));
  return cards.map((card) => {
    const mine = card.snippetIds.map((id) => byId.get(id)).filter((s): s is Snippet => s !== undefined);
    mine.sort((a, b) => b.createdTs - a.createdTs);
    return {
      card,
      snippet: mine[0] ?? null,
      articleCount: new Set(mine.map((s) => s.articleId)).size,
    };
  });
}
