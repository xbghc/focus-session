import { localStorage, hasSyncStorage } from "../../sync/storage.ts";
import type { ReviewCardView, Snippet, StoredCard, TranslationResult } from "../../types.ts";
import { cardKeyOf } from "../../lib/lang.ts";
import { type GradeValue, gradeCard, newCard } from "../../lib/review.ts";
import { serialize } from "../../background/store.ts";

/**
 * 划词记录与生词复习卡片的持久化。模型配置在 core/background/llm.ts。
 *
 * 所有写操作都走 store.ts 那条串行队列——service worker 会并发处理多个标签页
 * 的消息，两个 read-modify-write 交错会丢数据。
 */

export const KEY_SNIPPETS = "snippets";
export const KEY_CARDS = "cards";

/** 与 store.ts 的 MAX_SESSIONS 同源的考虑：storage.local 约 10MB，超了静默失败。 */
export const MAX_SNIPPETS = 5_000;

const local = (): chrome.storage.StorageArea => localStorage();

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

/**
 * 划词和卡片一次读出来。分开读是两次整库读取（状态库是一整个值，读哪个键都得把它全读出来），
 * `addSnippet` 挡在翻译回复前面，前后各读一次，省下的两趟在五千条记录的库上是一两百毫秒。
 */
async function getSnippetsAndCards(): Promise<[Snippet[], StoredCard[]]> {
  const got = await local().get([KEY_SNIPPETS, KEY_CARDS]);
  const snippets = (got[KEY_SNIPPETS] as Snippet[]) ?? [];
  for (const s of snippets) {
    s.usage ??= null;
    s.vocab ??= [];
  }
  return [snippets, (got[KEY_CARDS] as StoredCard[]) ?? []];
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
    const [snippets, cards] = await getSnippetsAndCards();

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
    const trimmed = !hasSyncStorage() && snippets.length > MAX_SNIPPETS ? snippets.slice(-MAX_SNIPPETS) : snippets;
    await local().set({ [KEY_SNIPPETS]: trimmed, [KEY_CARDS]: cards });
    if (hasSyncStorage()) {
      // 写回去之后按投影出来的为准（卡片的 id、来源会被同步层规整），划词和卡片一趟读完
      const [savedSnippets, savedCards] = await getSnippetsAndCards();
      return { snippet: savedSnippets.find((s) => s.id === snippet.id) ?? snippet, card: card ? savedCards.find((c) => c.key === card!.key) ?? null : null };
    }
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
    return hasSyncStorage() ? (await getCards()).find(c=>c.key===card!.key)??null : card;
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
    const prior = cards[i]!;
    const history = await local().get(["reviewEvents","reviewBases"]);
    const bases = (history.reviewBases ?? {}) as Record<string, unknown>;
    const baseKey = `word:${prior.key}`;
    if (!bases[baseKey]) bases[baseKey] = prior;
    const events = (history.reviewEvents ?? []) as unknown[];
    events.push({id:crypto.randomUUID(),kind:"word",cardKey:prior.key,grade,ts:now,algorithm:"fsrs-5-default-v1"});
    cards[i] = next;
    await local().set({ [KEY_CARDS]: cards, reviewEvents:events, reviewBases:bases });
    return hasSyncStorage() ? (await getCards()).find(c=>c.key===prior.key)??null : next;
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
