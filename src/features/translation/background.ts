import type { TranslatePortIn, TranslatePortOut } from "../../types.ts";
import { recognize, warm } from "./ocr.ts";
import { dueCards, reviewStats } from "../../lib/review.ts";
import { handleAssist, streamAsk, streamTranslate, testConnection } from "./translate.ts";
import { recordTranslationTrace } from "./translationLog.ts";
import {
  attachSnippets,
  deleteSnippet,
  enqueueSnippet,
  getCards,
  getSnippets,
  gradeStoredCard,
} from "./vocab.ts";
import { allowTranslationSite } from "../../background/store.ts";
import type { HandlerMap } from "../../core/background/router.ts";

/*
 * 划词翻译的后台一半：翻译与追问的 port、截图翻译（截屏 + OCR）、划词记录、生词复习、翻译白名单。
 */

export const translationHandlers = {
  "translation:allow-site": (m) => allowTranslationSite(m.url),
  /*
   * 设置页的「测试连接」。连的是 core 那份模型配置，测法却是发一句最短的翻译——
   * 顺带验证了翻译那套提示词和解析在这个模型上走得通。所以归这边。
   */
  "llm:test": () => testConnection(),
  "translation:trace": async (m) => {
    await recordTranslationTrace(m.trace);
    return { ok: true };
  },

  /* ---- 截图翻译 ---- */
  "page:capture": async (_m, sender) => {
    try {
      const windowId = sender.tab?.windowId;
      const dataUrl = windowId === undefined
        ? await chrome.tabs.captureVisibleTab({ format: "png" })
        : await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      return { ok: true, dataUrl };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
  "ocr:warm": async () => {
    await warm();
    return { ok: true };
  },
  "ocr:recognize": (m) => recognize(m.png),

  /* ---- 划词记录 ---- */
  "snippets:list": async (m) => {
    const all = await getSnippets();
    const list = m.articleId ? all.filter((s) => s.articleId === m.articleId) : all;
    return { snippets: list.sort((a, b) => b.createdTs - a.createdTs) };
  },
  "snippet:delete": async (m) => {
    await deleteSnippet(m.id);
    return { ok: true };
  },
  "snippet:enqueue": async (m) => {
    const card = await enqueueSnippet(m.id, Date.now());
    return { ok: card !== null, card };
  },

  /* ---- 生词复习 ---- */
  "review:due": async (m) => {
    const [cards, snippets] = await Promise.all([getCards(), getSnippets()]);
    const now = Date.now();
    return { cards: attachSnippets(dueCards(cards, now, m.limit), snippets), stats: reviewStats(cards, now) };
  },
  "review:grade": async (m) => {
    const card = await gradeStoredCard(m.cardId, m.grade, Date.now());
    return { ok: card !== null, card };
  },
  "review:stats": async () => reviewStats(await getCards(), Date.now()),
  "review:assist": async (m) => {
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
  },
} satisfies HandlerMap;

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
  /** 这条 port 手上那件事。断开时只需要能把它掐掉，所以只认 cancel。 */
  let handle: { cancel: () => void } | null = null;
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

  /** 一问一答，答完就断——两种请求走的是同一套收尾。 */
  const settle = <T>(h: { done: Promise<T>; cancel: () => void }, reply: (res: T) => TranslatePortOut, fail: (error: string) => TranslatePortOut): void => {
    handle = h;
    void h.done.then(
      (res) => {
        post(reply(res));
        if (!closed) port.disconnect();
      },
      (err: unknown) => {
        post(fail(String(err)));
        if (!closed) port.disconnect();
      },
    );
  };

  port.onMessage.addListener((msg: TranslatePortIn) => {
    // 一条 port 只做一件事：浮层每次翻译、每次追问都新连一条
    if (handle) return;
    if (msg?.type === "start") {
      settle(
        streamTranslate(msg.req, (partial) => post({ type: "partial", partial })),
        (res) => ({ type: "done", res }),
        (error) => ({ type: "done", res: { ok: false, error, needsConfig: false } }),
      );
    } else if (msg?.type === "ask") {
      settle(
        streamAsk(msg.req, (text) => post({ type: "ask-partial", text })),
        (res) => ({ type: "ask-done", res }),
        (error) => ({ type: "ask-done", res: { ok: false, error, needsConfig: false } }),
      );
    }
  });
}
