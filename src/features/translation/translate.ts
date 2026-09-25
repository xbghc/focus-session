import type {
  AskReply,
  AskRequest,
  LlmConfig,
  PartialTranslation,
  Snippet,
  TranslateReply,
  TranslateRequest,
} from "../../types.ts";
import { LlmError, askStream, assist, translate, translateStream } from "../../lib/llm.ts";
import type { AssistMode } from "../../types.ts";
import { addSnippet } from "./vocab.ts";
import { getLlmConfig } from "../../core/background/llm.ts";
import { type FailureContext, later, recordCall, recordFailure, recordTiming } from "../../background/llmLog.ts";
import type { TranslationBackendTiming } from "../../lib/translationDiagnostics.ts";

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
 *
 * 现场、耗时和「失败一次」的用量一笔写完，而且**不等它**：报错要紧，账随后记（见 llmLog.ts 的 `later`）。
 * `count` 为 false 的是测连通——那条路不记用量。
 */
function report(err: unknown, config: LlmConfig, ctx: FailureContext, count = true): TranslateFailure {
  if (err instanceof LlmError && err.raw) {
    console.warn("[focus-session] 模型输出解析失败", err.message, `stop_reason=${err.raw.stopReason}`, err.raw.text);
  }
  later(() => recordFailure(err, config, { ...ctx, countUsage: count }));
  return describe(err);
}

/* ==================== 流式路径 ==================== */

/** 一次进行中的流式翻译。多个订阅者共用一条请求（双击选词会同时开两条）。 */
interface Live {
  timing: TranslationBackendTiming;
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
  const start = performance.now();
  const metrics = e.timing;
  const config = await getLlmConfig();
  metrics.configMs = performance.now() - start;
  const modelStart = performance.now();
  const context = (): FailureContext => ({
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
  try {
    const { result, usage, timing, recovered } = await translateStream(
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
    metrics.modelMs = performance.now() - modelStart;
    metrics.firstTextMs = timing.firstTextMs;
    metrics.firstFieldMs = timing.firstFieldMs;
    metrics.attempts = timing.attempts;
    /*
     * 模型答完之后，挡在回复前面的只剩存划词这一笔——回复里要带它的 id。用量和耗时随后再记，不让人等：
     * 早先三笔串着写，诊断日志里这一段的中位数是一秒（最长 4.1 秒），译文早就流完了，浮层的收尾却迟迟不来。
     * accountingMs / diagnosticWriteMs 因此不再有数：它们量的那两笔已经不在这条路上了。
     */
    const stageStart = performance.now();
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
    metrics.snippetWriteMs = performance.now() - stageStart;
    remember(key, snippet);
    later(() => recordCall("translate", config, timing, usage));
    // 自动重发、抢救回来的，人没看见失败，日志里照样留一条（带 recovered 标记）
    if (recovered) {
      const ctx = { ...context(), recovered: recovered.by };
      later(() => recordFailure(recovered.error, config, ctx));
    }
    return { ok: true, snippet, cached: false };
  } catch (err) {
    metrics.modelMs ??= performance.now() - modelStart;
    if (err instanceof LlmError && err.timing) {
      metrics.firstTextMs = err.timing.firstTextMs;
      metrics.firstFieldMs = err.timing.firstFieldMs;
      metrics.attempts = err.timing.attempts;
    }
    // 主动取消和缺配置都不算"调用失败"，不记用量也不进日志（recordFailure 里挡）
    return report(err, config, context());
  } finally {
    metrics.totalMs = performance.now() - start;
    live.delete(key);
  }
}

/**
 * 发起一次流式翻译。命中缓存时不开流，直接给结果——
 * 回头再划同一个词应当是瞬时的。
 */
export function streamTranslate(req: TranslateRequest, onPartial: (p: PartialTranslation) => void): StreamHandle {
  const subscribed = performance.now();
  const timing = (cache: TranslationBackendTiming["cache"]): TranslationBackendTiming => ({
    cache, subscriberMs: 0, totalMs: 0, configMs: null, modelMs: null, firstTextMs: null, firstFieldMs: null,
    attempts: 0, accountingMs: null, diagnosticWriteMs: null, snippetWriteMs: null,
  });
  const key = keyOf(req);

  const hit = cache.get(key);
  if (hit) {
    const diagnostics = timing("hit");
    diagnostics.totalMs = diagnostics.subscriberMs = performance.now() - subscribed;
    return { done: Promise.resolve({ ok: true, snippet: hit, cached: true, diagnostics }), cancel: () => undefined };
  }

  let entry = live.get(key);
  const joined = !!entry;
  if (!entry) {
    // 先入表再起跑：runStream 的 finally 会 live.delete(key)，顺序反了就删了个空
    const e: Live = { ctrl: new AbortController(), subs: new Set(), last: null, done: null as never, timing: timing("miss") };
    live.set(key, e);
    e.done = runStream(req, key, e);
    entry = e;
  }
  const shared = entry;
  shared.subs.add(onPartial);
  if (shared.last) onPartial(shared.last);

  let off = false;
  return {
    done: shared.done.then(res => ({ ...res, diagnostics: { ...shared.timing,
      cache: joined ? "shared" : "miss", subscriberMs: performance.now() - subscribed } })),
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

/* ==================== 追问 ==================== */

export interface AskHandle {
  done: Promise<AskReply>;
  /** 浮层关了 / 用户又划了别的词就调它。 */
  cancel: () => void;
}

/**
 * 浮层里的一次追问。
 *
 * 和翻译的三点不同，都是「追问不入库」推出来的：
 * 不进缓存（同一个词问两次多半是问不同的事），不做并发合流（每一问都是独立的一句），
 * 取消就真的中断（翻译要跑完才好把这个词记进复习队列，追问没有这层价值，
 * 见 streamTranslate 里 cancel 的说明）。
 */
export function streamAsk(req: AskRequest, onDelta: (text: string) => void): AskHandle {
  const ctrl = new AbortController();
  return { done: runAsk(req, onDelta, ctrl.signal), cancel: () => ctrl.abort() };
}

async function runAsk(req: AskRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<AskReply> {
  const config = await getLlmConfig();
  try {
    const { text, usage, timing } = await askStream(req, config, onDelta, signal);
    later(() => recordCall("ask", config, timing, usage));
    return { ok: true, text };
  } catch (err) {
    // 同 runStream：主动取消和缺配置都不算"调用失败"
    const f = report(err, config, {
      source: "ask",
      request: { text: req.text, question: req.question, articleTitle: req.articleTitle, turns: req.history.length },
    });
    return { ok: false, error: f.error, needsConfig: f.needsConfig };
  }
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
    const { text, usage, timing } = await assist(mode, input, config);
    later(() => recordCall("assist", config, timing, usage));
    return { ok: true, text };
  } catch (err) {
    const f = report(err, config, { source: "assist", request: { mode, key: input.key, articleTitle: input.articleTitle } });
    return { ok: false, error: f.error, needsConfig: f.needsConfig };
  }
}

/** 设置页的「测试连接」。故意用一句极短的输入，别为了测连通烧 token。 */
export async function testConnection(): Promise<{ ok: boolean; error?: string; model?: string }> {
  const config = await getLlmConfig();
  try {
    const { result, usage, timing } = await translate(
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
    // 测连通不记用量（见上），但耗时要记——它本来就是用来量延迟的那一下
    later(() => recordTiming("test", config, timing, usage));
    return { ok: true, model: `${config.model} → ${result.translation}` };
  } catch (err) {
    return { ok: false, error: report(err, config, { source: "test", request: { text: "hello" } }, false).error };
  }
}
