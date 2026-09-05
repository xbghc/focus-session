import type { LlmConfig, PartialTranslation, Snippet, TranslateReply, TranslateRequest } from "../types.ts";
import { LlmError, assist, translate, translateStream } from "../lib/llm.ts";
import type { AssistMode } from "../types.ts";
import { addSnippet, addUsage, getLlmConfig } from "./vocab.ts";
import { type FailureContext, recordFailure } from "./llmLog.ts";

/**
 * 翻译请求的门面：缓存、并发去重、用量记账都在这里，
 * 让消息路由那边保持一句话。
 *
 * 之所以必须在 background 发请求：MiniMax 的端点不返回 CORS 头，
 * content script 里 fetch 会被浏览器直接拦掉；而且 API key 也不能进页面上下文。
 */

/**
 * 同一篇文章内、同一段文本重复选中不再请求。
 * 读文章时反复划同一个词是常态（回头再看一眼），每次都发请求纯属浪费。
 * 只在内存里，service worker 被回收就没了——这正合适，缓存本来就是尽力而为。
 */
const cache = new Map<string, Snippet>();

const MAX_CACHE = 500;

/*
 * 讲解开关也进缓存键：刚在设置里打开「英语老师模式」，回头再划同一个词，
 * 命中的若是关着时存下的那条，看起来就像开关没生效。
 */
const keyOf = (req: TranslateRequest): string =>
  `${req.articleId}\0${req.explainVocab ? "t" : "f"}\0${req.text.toLowerCase()}`;

function remember(key: string, snippet: Snippet): void {
  if (cache.size >= MAX_CACHE) {
    // Map 保持插入序，删最早的那个就是最朴素的 LRU 近似
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, snippet);
}

/** 失败分支单独取出来：调用方要读 error / needsConfig，联合类型上取不到。 */
type TranslateFailure = Extract<TranslateReply, { ok: false }>;

function describe(err: unknown): TranslateFailure {
  if (err instanceof LlmError) return { ok: false, error: err.message, needsConfig: err.kind === "config" };
  return { ok: false, error: String(err), needsConfig: false };
}

/**
 * 失败的统一出口：把现场记进诊断日志（见 llmLog.ts），再折成给调用方的回复。
 * 控制台那行也保留：开着 DevTools 时不用去设置页导出就能看。
 */
async function report(err: unknown, config: LlmConfig, ctx: FailureContext): Promise<TranslateFailure> {
  if (err instanceof LlmError && err.raw) {
    console.warn("[focus-session] 模型输出解析失败", err.message, `stop_reason=${err.raw.stopReason}`, err.raw.text);
  }
  await recordFailure(err, config, ctx);
  return describe(err);
}

/* ==================== 流式路径 ==================== */

/** 一次进行中的流式翻译。多个订阅者共用一条请求（双击选词会同时开两条）。 */
interface Live {
  ctrl: AbortController;
  subs: Set<(p: PartialTranslation) => void>;
  /** 最近一次快照，给中途加入的订阅者补上已经到达的字段。 */
  last: PartialTranslation | null;
  done: Promise<TranslateReply>;
}

const live = new Map<string, Live>();

export interface StreamHandle {
  done: Promise<TranslateReply>;
  /** 浮层关了就调它。是否真的中断请求见 streamTranslate 里的说明。 */
  cancel: () => void;
}

async function runStream(req: TranslateRequest, key: string, e: Live): Promise<TranslateReply> {
  const config = await getLlmConfig();
  try {
    const { result, usage } = await translateStream(
      req,
      config,
      (p) => {
        e.last = p;
        for (const fn of e.subs) {
          try {
            fn(p);
          } catch {
            /* 某个订阅者（页面已卸载的 port）出错不该掐掉整条流 */
          }
        }
      },
      e.ctrl.signal,
    );
    await addUsage(usage.inputTokens, usage.outputTokens);
    const { snippet } = await addSnippet({
      articleId: req.articleId,
      url: req.url,
      articleTitle: req.articleTitle,
      text: req.text,
      kind: req.kind,
      context: req.context,
      result,
      now: Date.now(),
    });
    remember(key, snippet);
    return { ok: true, snippet, cached: false };
  } catch (err) {
    // 主动取消和缺配置都不算"调用失败"，别污染用量统计
    const skip = err instanceof LlmError && (err.kind === "abort" || err.kind === "config");
    if (!skip) await addUsage(0, 0, true);
    return await report(err, config, {
      source: "translate",
      request: {
        kind: req.kind,
        text: req.text,
        context: req.context,
        explainVocab: req.explainVocab,
        articleTitle: req.articleTitle,
        url: req.url,
      },
      // 译文已经显示过才报错，问题在尾部；一个字都没出就报错，问题在开头——两类分开看
      partialShown: Boolean(e.last?.translation),
    });
  } finally {
    live.delete(key);
  }
}

/**
 * 发起一次流式翻译。命中缓存时不开流，直接给结果——
 * 回头再划同一个词应当是瞬时的。
 */
export function streamTranslate(req: TranslateRequest, onPartial: (p: PartialTranslation) => void): StreamHandle {
  const key = keyOf(req);

  const hit = cache.get(key);
  if (hit) {
    return { done: Promise.resolve({ ok: true, snippet: hit, cached: true }), cancel: () => undefined };
  }

  let entry = live.get(key);
  if (!entry) {
    // 先入表再起跑：runStream 的 finally 会 live.delete(key)，顺序反了就删了个空
    const e: Live = { ctrl: new AbortController(), subs: new Set(), last: null, done: null as never };
    live.set(key, e);
    e.done = runStream(req, key, e);
    entry = e;
  }
  const shared = entry;
  shared.subs.add(onPartial);
  if (shared.last) onPartial(shared.last);

  let off = false;
  return {
    done: shared.done,
    cancel: () => {
      if (off) return;
      off = true;
      shared.subs.delete(onPartial);
      /*
       * 只有「一个字段都还没回来」才真的中断。
       *
       * 读得快的人常常是：划词 → 800ms 看到译文 → 立刻划下一个词。第二次
       * mousedown 会 dismiss 掉浮层，若就此掐断请求，这个**用户已经看过的词**
       * 就不会入库、不会进复习队列——而"划词即记录"正是这个功能的本分。
       * 让它跑完只多花 context_note 那几十个 token，还顺带进了缓存。
       *
       * 反过来，一个字都没回来就取消，多半是误选或反悔，中断得干脆。
       */
      if (shared.subs.size === 0 && shared.last === null) shared.ctrl.abort();
    },
  };
}

export interface AssistOutcome {
  ok: boolean;
  text?: string;
  error?: string;
  needsConfig?: boolean;
}

/** 复习卡片上的「再给个例句 / 换个说法讲 / 考我一下」。翻卡本身不花 token，这里才花。 */
export async function handleAssist(
  mode: AssistMode,
  input: { key: string; translation: string; originalText: string; context: string; articleTitle: string },
): Promise<AssistOutcome> {
  const config = await getLlmConfig();
  try {
    const { text, usage } = await assist(mode, input, config);
    await addUsage(usage.inputTokens, usage.outputTokens);
    return { ok: true, text };
  } catch (err) {
    if (!(err instanceof LlmError && err.kind === "config")) await addUsage(0, 0, true);
    const f = await report(err, config, { source: "assist", request: { mode, key: input.key, articleTitle: input.articleTitle } });
    return { ok: false, error: f.error, needsConfig: f.needsConfig };
  }
}

/** 设置页的「测试连接」。故意用一句极短的输入，别为了测连通烧 token。 */
export async function testConnection(): Promise<{ ok: boolean; error?: string; model?: string }> {
  const config = await getLlmConfig();
  try {
    const { result } = await translate(
      // 测连通不需要讲解，别为了一次握手多烧半份输出
      {
        articleId: "test",
        url: "test",
        articleTitle: "",
        text: "hello",
        context: "hello",
        kind: "word",
        explainVocab: false,
      },
      config,
    );
    return { ok: true, model: `${config.model} → ${result.translation}` };
  } catch (err) {
    return { ok: false, error: (await report(err, config, { source: "test", request: { text: "hello" } })).error };
  }
}
