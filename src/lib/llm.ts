import type {
  AskRequest,
  LlmConfig,
  PartialTranslation,
  SnippetKind,
  TranslateRequest,
  TranslationResult,
  VocabNote,
} from "../types.ts";
import { MAX_VOCAB } from "../types.ts";

/**
 * MiniMax 的对话模型走的是 **Anthropic 兼容端点**（`/anthropic/v1/messages`），
 * 鉴权用 `x-api-key`，请求/响应体与 Anthropic Messages API 一致，额外多一个
 * MiniMax 自己的 `base_resp`。这里直接 fetch，不引 `@anthropic-ai/sdk`：
 * service worker 里零依赖更省事，SDK 的浏览器模式还要额外开关。
 *
 * 该端点**不返回 CORS 头**，所以只能在 background 里调用——content script
 * 发出去会被浏览器拦掉。扩展的 host_permissions 已覆盖全部 https 站点，
 * background 的 fetch 因此拥有跨域特权。
 */

/** 便于单测注入。 */
export interface LlmDeps {
  fetch: typeof fetch;
  /** 重试前的退避时长，默认 `RETRY_DELAY_MS`。单测拿它跳过那 1.2 秒的真实等待。 */
  retryDelayMs?: number;
  /** 取当前时刻，默认 `Date.now`。单测拿它把耗时钉死，不必依赖真实时间。 */
  now?: () => number;
}

/**
 * 一次调用的耗时切片。分成几个数字是因为"慢"不止一种：
 * **排队慢**（`firstTextMs` 大，模型迟迟不开口）、**生成慢**（`firstFieldMs` 到 `totalMs` 拉得长）、
 * 还有**重试导致的慢**（`attempts > 1`，其中一段是自己退避掉的）。
 * 只记一个总时长的话，这三种在日志里长得一模一样。
 */
export interface CallTiming {
  /** 用户实际等的时长，含退避与重试。 */
  totalMs: number;
  /** 第一个文本增量到达。非流式为 null——那条路在整段生成完之前什么都没有。 */
  firstTextMs: number | null;
  /** 译文字段闭合、浮层第一次真显示出东西。只有流式翻译有。 */
  firstFieldMs: number | null;
  /** 实际发出去几次请求。>1 说明撞上过 429/529，`totalMs` 里有一段是退避。 */
  attempts: number;
}

/** `abort` 是用户主动取消（关掉浮层、又选了别的），不该计入失败统计。 */
export type LlmErrorKind = "config" | "http" | "network" | "timeout" | "parse" | "abort";

/**
 * 字段用显式声明而不是构造器参数属性——测试跑在 `node --experimental-strip-types`
 * 的 strip-only 模式下，那里不支持参数属性。
 */
export class LlmError extends Error {
  kind: LlmErrorKind;
  status: number | undefined;
  /**
   * 模型的原始输出，只挂在解析阶段的失败上。浮层只显示 200 字，错误消息里那 160 字的
   * 原文前缀常在出错处之前就被截掉——完整原文和 stop_reason 靠 background 记进
   * service worker 的控制台，下一次失败才有得查。
   */
  raw: { text: string; stopReason: string } | undefined;
  /**
   * 这次调用花了多久。缺配置那类"根本没发出去"的失败没有——
   * 和 `raw` 同一个思路：能挂上去的现场都挂上，日志才看得出"慢到超时"和"秒失败"的区别。
   */
  timing: CallTiming | undefined;

  constructor(message: string, kind: LlmErrorKind, status?: number) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
    this.raw = undefined;
    this.timing = undefined;
  }
}

export interface RawUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CallResult {
  text: string;
  usage: RawUsage;
  /** 原样的 stop_reason，进日志用；`truncated` 是从它推出来的。 */
  stopReason: string;
  truncated: boolean;
  timing: CallTiming;
}

/**
 * 值得重试的状态码。529 是 MiniMax 的"集群负载较高，请稍后重试"，429 是限流——
 * 两者都不是这次请求本身有问题，隔一会儿再发就好。
 */
const RETRY_STATUS = new Set([429, 529]);

/**
 * 退避多久再重试。只重试一次：用户正盯着浮层等，第二次还过载就该老实报错，
 * 让他自己决定要不要再划一遍，而不是替他把 timeout 熬完。
 */
const RETRY_DELAY_MS = 1_200;

/**
 * 可被 `signal` 打断的等待。被打断时直接 resolve——超时和主动取消的区分留给调用方，
 * 让它的下一次 fetch 去撞 abort，这里不重复判一遍。
 */
function backoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * 发一次 Messages 请求，过载/限流时退避重试一次。
 *
 * URL、鉴权头和重试规矩两条路径共用；流式与否只差请求体里的 `stream`。
 * 重试整个发生在调用方那个 timeout 之内，所以用户设的超时仍然是总账。
 *
 * `count` 由调用方持有而不是当返回值：抛出去的时候（网络错误、超时）也得数得清发了几次，
 * 不然日志里一次重试过的调用只会显示"慢了 1.5 秒"，看不出那 1.2 秒是自己退避掉的。
 */
async function postMessages(
  config: LlmConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
  deps: LlmDeps,
  count: { n: number },
): Promise<Response> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal,
  };
  for (;;) {
    count.n++;
    const res = await deps.fetch(url, init);
    if (res.ok || count.n > 1 || !RETRY_STATUS.has(res.status)) return res;
    await res.body?.cancel().catch(() => undefined); // body 不读也得关掉，不然连接挂着
    await backoff(deps.retryDelayMs ?? RETRY_DELAY_MS, signal);
  }
}

/** 一次非流式 Messages 调用。只负责发出去和把文本取回来，不懂业务。 */
export async function callMessages(
  config: LlmConfig,
  system: string,
  userText: string,
  deps: LlmDeps = { fetch: globalThis.fetch.bind(globalThis) },
): Promise<CallResult> {
  if (!config.apiKey) throw new LlmError("尚未填写 MiniMax API Key", "config");

  // 计时从这里起：缺配置那次根本没发请求，不该占一格
  const now = deps.now ?? Date.now;
  const t0 = now();
  const count = { n: 0 };
  /** 非流式没有"第一个字"可言——整段生成完之前什么都没有，两个 first 恒为 null。 */
  const timing = (): CallTiming => ({ totalMs: now() - t0, firstTextMs: null, firstFieldMs: null, attempts: count.n });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);

  // 外面这层只干一件事：把耗时挂到抛出去的 LlmError 上，一口气兜住下面所有出口
  try {
    let res: Response;
    try {
      res = await postMessages(
        config,
        {
          model: config.model,
          max_tokens: config.maxTokens,
          system,
          messages: [{ role: "user", content: userText }],
        },
        ctrl.signal,
        deps,
        count,
      );
    } catch (err) {
      if (ctrl.signal.aborted) throw new LlmError(`请求超时（${config.timeoutMs}ms）`, "timeout");
      throw new LlmError(`网络错误：${String(err)}`, "network");
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // 错误体通常是 JSON，但 401/网关错误可能是 HTML，截断后原样带出更好排查
      const body = await res.text().catch(() => "");
      throw new LlmError(`HTTP ${res.status}：${body.slice(0, 300)}`, "http", res.status);
    }

    const data = (await res.json().catch(() => null)) as AnthropicResponse | null;
    if (!data) throw new LlmError("响应不是合法 JSON", "parse");

    // MiniMax 会在 HTTP 200 里用 base_resp 报业务错误（余额不足、鉴权失败等）
    const br = data.base_resp;
    if (br && typeof br.status_code === "number" && br.status_code !== 0) {
      throw new LlmError(`MiniMax 错误 ${br.status_code}：${br.status_msg ?? ""}`, "http");
    }

    const text = (data.content ?? [])
      .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");

    return {
      text,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
      stopReason: data.stop_reason ?? "",
      truncated: data.stop_reason === "max_tokens",
      timing: timing(),
    };
  } catch (err) {
    if (err instanceof LlmError) err.timing = timing();
    throw err;
  }
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string } | null>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  base_resp?: { status_code?: number; status_msg?: string };
}

/* ==================== 流式 ==================== */

export interface StreamOptions {
  /** 每收到一段文本回调一次，参数是**到目前为止的全部文本**（不是增量）。 */
  onDelta: (full: string) => void;
  /** 外部取消：浮层关了、用户又选了别的，就不该继续烧 token。 */
  signal?: AbortSignal;
}

/**
 * 把 SSE 字节流拆成一个个 data 事件对象。
 *
 * 分块边界会落在任意位置——一行 JSON 可能被切成两个 chunk，所以必须缓冲到
 * 换行才解析。`event:` 行和空行直接跳过：事件类型在 data 的 `type` 字段里也有。
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          /* 单条事件坏掉不该中断整个流 */
        }
      }
    }
  } finally {
    // for-await 提前 break/throw 时会走到这里，把底层连接掐掉
    await reader.cancel().catch(() => undefined);
  }
}

interface BaseResp {
  status_code?: number;
  status_msg?: string;
}

/**
 * 流式版的 Messages 调用。
 *
 * 生成耗时与输出 token 数成正比（实测词条 1.4–4.9s），非流式要等整段生成完
 * 才有第一个字节。流式下首字约 700ms 就到，配合把 translation 放在 JSON 第一位，
 * 译文可显示时间从约 1900ms 降到约 800ms。
 */
export async function callMessagesStream(
  config: LlmConfig,
  system: string,
  userText: string,
  opts: StreamOptions,
  deps: LlmDeps = { fetch: globalThis.fetch.bind(globalThis) },
): Promise<CallResult> {
  if (!config.apiKey) throw new LlmError("尚未填写 MiniMax API Key", "config");
  if (opts.signal?.aborted) throw new LlmError("已取消", "abort");

  const now = deps.now ?? Date.now;
  const t0 = now();
  const count = { n: 0 };
  let firstTextMs: number | null = null;
  /** `firstFieldMs` 这一层看不见（字段闭合是 translateStream 的事），留给它填。 */
  const timing = (): CallTiming => ({ totalMs: now() - t0, firstTextMs, firstFieldMs: null, attempts: count.n });

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, config.timeoutMs);
  // AbortSignal.any 要 Chrome 116，手动接一下更保险
  const relay = (): void => ctrl.abort();
  opts.signal?.addEventListener("abort", relay, { once: true });

  /** 把底层异常翻译成带 kind 的 LlmError；超时和主动取消要能区分开。 */
  const wrap = (err: unknown): LlmError => {
    if (err instanceof LlmError) return err;
    if (timedOut) return new LlmError(`请求超时（${config.timeoutMs}ms）`, "timeout");
    if (ctrl.signal.aborted) return new LlmError("已取消", "abort");
    return new LlmError(`网络错误：${String(err)}`, "network");
  };

  try {
    let res: Response;
    try {
      res = await postMessages(
        config,
        {
          model: config.model,
          max_tokens: config.maxTokens,
          system,
          messages: [{ role: "user", content: userText }],
          stream: true,
        },
        ctrl.signal,
        deps,
        count,
      );
    } catch (err) {
      throw wrap(err);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LlmError(`HTTP ${res.status}：${body.slice(0, 300)}`, "http", res.status);
    }
    if (!res.body) throw new LlmError("响应没有可读流", "parse");

    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = "";

    try {
      for await (const ev of sseEvents(res.body)) {
        switch (ev["type"]) {
          case "message_start": {
            const m = ev["message"] as { usage?: { input_tokens?: number }; base_resp?: BaseResp } | undefined;
            // MiniMax 会在 HTTP 200 的流里用 base_resp 报业务错误（余额不足、鉴权失败）
            const br = m?.base_resp;
            if (br && typeof br.status_code === "number" && br.status_code !== 0) {
              throw new LlmError(`MiniMax 错误 ${br.status_code}：${br.status_msg ?? ""}`, "http");
            }
            inputTokens = m?.usage?.input_tokens ?? 0;
            break;
          }
          case "content_block_delta": {
            const d = ev["delta"] as { type?: string; text?: string } | undefined;
            if (d?.type === "text_delta" && typeof d.text === "string") {
              // 传输层的"第一个字"：模型开口了。和"浮层能显示了"是两回事，后者要等字段闭合
              if (d.text && firstTextMs === null) firstTextMs = now() - t0;
              text += d.text;
              opts.onDelta(text);
            }
            break;
          }
          case "message_delta": {
            const d = ev["delta"] as { stop_reason?: string } | undefined;
            if (d?.stop_reason) stopReason = d.stop_reason;
            const u = ev["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
            if (typeof u?.output_tokens === "number") outputTokens = u.output_tokens;
            // Anthropic 只在 message_start 报 input_tokens，MiniMax 那里恒为 0，
            // 真实值在收尾的 message_delta 里。两处都取，谁非零算谁。
            if (u?.input_tokens) inputTokens = u.input_tokens;
            break;
          }
          case "error": {
            const e = ev["error"] as { message?: string; type?: string } | undefined;
            throw new LlmError(`模型返回错误：${e?.message ?? e?.type ?? "未知"}`, "http");
          }
          default:
            break;
        }
      }
    } catch (err) {
      throw wrap(err);
    }

    if (!text) throw new LlmError("流式响应里没有任何文本", "parse");
    return { text, usage: { inputTokens, outputTokens }, stopReason, truncated: stopReason === "max_tokens", timing: timing() };
  } catch (err) {
    // `wrap` 造的是新的 LlmError，而上面 !res.ok / !res.body / !text 那几处压根不过 wrap，
    // 所以耗时统一在这里挂，不在 wrap 里挂
    if (err instanceof LlmError) err.timing = timing();
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", relay);
  }
}

/* ==================== 翻译 ==================== */

/**
 * 讲解的深浅按选区粒度分工，不是所有选区都套同一份要求：
 *
 * |      | 译文 | 语境解释 | usage 用法 | vocab 生词 |
 * | 单词 |  ✓  |    ✓    |     ✓     |     —     |
 * | 短语 |  ✓  |    ✓    |     ✓     |     ✓     |
 * | 整句 |  ✓  |    ✓    |     —     |     ✓     |
 *
 * 单词没有"其中的生词"——整条记录讲的就是它自己；
 * 整句没有"这个词怎么用"——那是词的属性，不是句子的。
 */
export function translateSystem(kind: SnippetKind, explainVocab: boolean): string {
  const lines = [
    "你是浏览器里的英语阅读助手，读者是中文母语者。",
    "只输出一个 JSON 对象，不要代码块，不要前言。",
    // 模型写中文时爱拿半角引号引术语（…做"细致"的效果…）又不转义，一处就废掉整份输出。
    // extractJson 那边有 repairJson 兜底，但能不坏最好。
    "字符串值里不要出现半角双引号：要引用某个词就用「」。",
    "字段严格按此顺序：",
    "- translation：中文翻译。单词只给本文语境下最贴合的那个义项，不罗列词典义项。",
    // 只说"含首尾斜杠"，模型真出过 "phonetic": /frɔːt/ 这种连引号一起省掉的输出
    '- phonetic：国际音标，连首尾斜杠一起写成字符串（"/frɔːt/"，不是裸的 /frɔːt/）；非英语词或整句为 null。',
    "- pos：词性（noun/verb/adj 等）；整句为 null。",
    "- lemma：原形（leaks→leak）；整句为 null。",
    "- context_note：一两句话，说明它在本文这个语境里指什么。要具体到本文，不写通用废话。",
  ];
  if (explainVocab && kind !== "sentence") {
    lines.push(
      "- usage：像老师那样补一句用法——常见搭配、词根构词、或和近义词的区别，" +
        "挑最值得知道的一条，40 字以内；确实没什么可说就给 null。",
    );
  }
  if (explainVocab && kind !== "word") {
    lines.push(
      `- vocab：数组，讲解选中内容里的生词，按它们在原文出现的顺序，最多 ${MAX_VOCAB} 条。每条形如`,
      '  {"word": 原文里的形式, "phonetic": 音标, "pos": 词性, "meaning": 它在这里的意思（20 字以内）,' +
        ' "note": 搭配/词根/辨析这类一句话提示，没有就 null}。',
      // 实测模型会把 tacit endorsement 这类固定搭配当成一条（这是对的，那本来就该整个教），
      // 但接着给两个音标拼在一起；in hindsight 更糟——给的是 hindsight 一个词的音标，
      // 却挂在整条短语上。多词条目干脆不要音标。
      "  word 可以是固定搭配或习语（tacit endorsement、in hindsight 这类本来就该整个记）；",
      "  但**多词条目的 phonetic 一律给 null**，音标只给单个词。",
      // 上下文是喂给模型判断义项的，可模型常常顺手把段落里的生词也一并讲了：
      // 用户明明只选了半句，浮层里却冒出没选中的词。prompt 里说死一遍，
      // vocabEntry 那里再按选区文本挡一道——光靠 prompt 约束不住。
      "  **只讲「选中文本」里出现的词**：所在段落只用来判断义项，选区之外的词一律不列；",
      "  挑词像老师划重点：只列中文母语读者可能不认识、或在这里是熟词僻义／习语的词；",
      "  the、make、take 这类常见词除非构成固定搭配否则不要列；专有名词只在影响理解时列。",
      "  全是常见词就给空数组 []。",
    );
  }
  return lines.join("\n");
}

/*
 * 字段顺序是**性能设计**，不是排版偏好：流式输出下 translation 先生成完，
 * 浮层就能在约 800ms 显示译文，而不必等到整个 JSON（约 1600ms）。
 * context_note 长，vocab 更长，依次排后面——它们晚到不挡着译文先显示。
 */

/** 把选区和它的上下文拼成一次请求。上下文让模型能判断多义词在此处的义项。 */
export function buildTranslatePrompt(req: TranslateRequest): string {
  const parts = [`文章标题：${req.articleTitle || "(无标题)"}`];
  // 段落的用途要写在标签上：只写"所在段落"，模型会把它也当成待讲解的材料
  if (req.context && req.context !== req.text) {
    parts.push(`所在段落（仅供判断词义，不要讲解其中的词）：${req.context}`);
  }
  parts.push(`选中文本：${req.text}`);
  parts.push(req.kind === "sentence" ? "这是一个句子或长片段。" : "这是一个单词或短语。");
  return parts.join("\n");
}

/**
 * 从 `start` 处的 `{` 起，找到把顶层对象收尾的那个 `}`；扫到头还没闭合就返回 -1。
 *
 * 和 `closedVocab` 同一套状态机：要认字符串，译文里写个 `}`（"…{的用法}"）不能当收尾。
 * 返回 -1 有两种可能：输出被 max_tokens 掐断了，或者某个没转义的引号把后半段
 * 全吞进了字符串——前者远比后者常见。
 */
function closeIndex(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 从 `at` 起跳过空白，看下一个字符能不能给一个字符串收尾。到头也算——末尾那个引号只可能是收尾。 */
function closesString(src: string, at: number): boolean {
  for (let i = at; i < src.length; i++) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    return c === "," || c === "}" || c === "]" || c === ":";
  }
  return true;
}

/** 值位置上裸着的音标：`"phonetic": /frɔːt/,`。要求后面跟着 `,` `}` `]`，免得错认。 */
const BARE_SLASHED = /^(\s*)(\/[^/"\n]*\/)(?=\s*[,}\]])/;

/**
 * 修模型写坏的 JSON。只在严格解析失败之后跑，只修两类**在合法 JSON 里根本不可能出现**的写法：
 *
 * 1. 字符串里没转义的半角引号。模型写中文时爱拿它引术语——
 *    `"context_note": "它能做"细致"的半透明效果"`——一处就废掉整份输出，实测这是头号死因。
 * 2. 值位置上裸着的音标：`"phonetic": /frɔːt/`。prompt 里说"含首尾斜杠"，模型偶尔连引号一起省了。
 *
 * 判定收尾引号的规矩：一个 `"` 结束字符串，当且仅当它后面（跳过空白）是 `,` `}` `]` `:`
 * 之一或者已经到头；否则它是正文里的引号，补成 `\"`。这条判断在合法 JSON 上永远成立，
 * 所以修补改不坏对的输出；何况它只在解析失败之后才跑。
 *
 * **裸换行不修**：字符串里的换行同样非法，但那既可能是模型忘了写 `\n`，也可能是它压根
 * 没在写 JSON（前面啰嗦了两段）。分不开就别猜，照旧报错，原文进诊断日志。
 */
export function repairJson(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inStr) {
      if (c === "\\") {
        out += c + (src[i + 1] ?? ""); // 已有的转义整对搬走，别把 \" 拆开重认
        i++;
      } else if (c === '"' && !closesString(src, i + 1)) {
        out += '\\"';
      } else {
        if (c === '"') inStr = false;
        out += c;
      }
      continue;
    }
    out += c;
    if (c === '"') {
      inStr = true;
    } else if (c === ":") {
      const m = BARE_SLASHED.exec(src.slice(i + 1));
      if (m) {
        out += m[1]! + JSON.stringify(m[2]!);
        i += m[0]!.length;
      }
    }
  }
  return out;
}

/** 从 `start` 处的 `{` 起切出一个闭合对象并解析。切不出、或者切出来解析不了，都返回 undefined。 */
function parseObjectAt(src: string, start: number): unknown {
  const end = closeIndex(src, start);
  if (end === -1) return undefined;
  try {
    return JSON.parse(src.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * 从模型输出里抠出 JSON。
 * 即便 system 里说了别加围栏，模型偶尔仍会包一层 ```json，
 * 也可能在 JSON 前后带一句话——两种情况都要能救回来。
 *
 * 顶层对象没闭合的按截断报，**不看 stop_reason**：MiniMax 兼容层在那个字段上回什么
 * 并无保证，它不说截断不等于没截断。这种输出若拿 lastIndexOf("}") 去抠，抓到的是
 * 最后一条生词的花括号，报出来的 SyntaxError 完全看不出是截断。
 *
 * 扫描和解析都失败了才轮到 `repairJson`：没转义的引号成对时骗得过扫描（在解析处炸），
 * 奇数个时让扫描停在字符串里（被误报成截断），两条路都得给它留出口。
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const trimmed = body.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 落到下面的花括号扫描 */
  }
  const start = trimmed.indexOf("{");
  if (start === -1) throw new LlmError(`模型输出里找不到 JSON：${text.slice(0, 200)}`, "parse");

  const end = closeIndex(trimmed, start);
  let syntax: unknown;
  if (end !== -1) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (err) {
      syntax = err; // 留着报出去：它的位置对得上原文，修补之后的位置对不上
    }
  }

  const fixed = parseObjectAt(repairJson(trimmed.slice(start)), 0);
  if (fixed !== undefined) return fixed;

  const head = trimmed.slice(0, 160);
  // 说"疑似"是因为没转义的引号也会让扫描停在字符串里；原文前缀照带，两种情况一眼能分
  if (end === -1) {
    throw new LlmError(`输出疑似被截断（JSON 没有闭合），请在设置里调大 max_tokens｜${head}`, "parse");
  }
  // 带上出错处附近的原文：没有它，线上只剩一句"JSON 解析失败"，无从查起
  throw new LlmError(`JSON 解析失败：${String(syntax)}｜${head}`, "parse");
}

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.toLowerCase() !== "null" ? t : null;
};

/**
 * 折成可比较的形式：小写、压空白、印刷体标点换回 ASCII。
 * 网页正文里是弯引号的 don’t，模型输出的是直引号的 don't——不折一下，
 * 一条本该留下的讲解会被当成"选区里没有"丢掉。
 */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 这条讲解讲的是不是**选中文本里**的词。
 *
 * 上下文段落只是喂给模型判断义项的材料，可它常常顺手把段落里的生词也讲了——
 * 用户只选了半句，浮层里却冒出没选中的词。prompt 里已经说死，这里是兜底。
 *
 * 判定用子串而不是词形还原：原形（leak）能对上原文里的 leaks，
 * 固定搭配（in hindsight）整条也对得上。代价是不规则变形——模型给 run、
 * 原文是 ran——会被丢掉；`VocabNote.word` 的约定本就是"原文里出现的形式"，
 * 按约定给就撞不上。宁可少讲一条，也不讲用户没选的词。
 */
export function inSelection(word: string, selection: string): boolean {
  return fold(selection).includes(fold(word));
}

/**
 * 一条生词讲解。**词和意思缺一不可**——只有词没有意思，浮层里就是孤零零一个单词，
 * 那不叫讲解。不在选区里的词同样丢掉，理由见 `inSelection`。
 */
function vocabEntry(raw: unknown, selection: string): VocabNote | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const word = str(o["word"]);
  const meaning = str(o["meaning"]);
  if (!word || !meaning) return null;
  if (!inSelection(word, selection)) return null;
  return { word, phonetic: str(o["phonetic"]), pos: str(o["pos"]), meaning, note: str(o["note"]) };
}

/**
 * 规范化生词数组。模型多给了也只留前 MAX_VOCAB 条，浮层装不下更多。
 *
 * 过滤在计数**之前**：否则模型讲了个段落里的词，那条虽被丢掉却已占掉一个名额，
 * 明明有 5 条够格的最后只剩 4 条。
 */
export function normalizeVocab(raw: unknown, selection: string): VocabNote[] {
  if (!Array.isArray(raw)) return [];
  const out: VocabNote[] = [];
  for (const item of raw) {
    const e = vocabEntry(item, selection);
    if (e) out.push(e);
    if (out.length >= MAX_VOCAB) break;
  }
  return out;
}

/**
 * 规范化模型输出。缺字段不算失败——译文在就够用，其余允许为 null。
 * `selection` 是用户选中的原文，用来把讲到选区外去的生词挡掉。
 */
export function normalizeTranslation(raw: unknown, kind: SnippetKind, selection: string): TranslationResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const translation = str(o["translation"]);
  if (!translation) throw new LlmError("模型没有返回 translation 字段", "parse");
  return {
    translation,
    contextNote: str(o["context_note"]) ?? "",
    // 整句不该有词性和音标，模型硬给也丢掉，免得污染卡片
    pos: kind === "sentence" ? null : str(o["pos"]),
    phonetic: kind === "sentence" ? null : str(o["phonetic"]),
    lemma: kind === "sentence" ? null : str(o["lemma"]),
    // 同一条规矩用在讲解上：整句没有"这个词怎么用"，单词没有"其中的生词"
    usage: kind === "sentence" ? null : str(o["usage"]),
    vocab: kind === "word" ? [] : normalizeVocab(o["vocab"], selection),
  };
}

/**
 * 拿到整段输出之后的收尾：截断先报截断，再解析。
 * 这一步的任何失败都把完整原文和 stop_reason 挂到错误上（见 `LlmError.raw`）——
 * 浮层那 200 字之外，这是唯一能看到模型到底吐了什么的地方。
 */
function finishTranslation(res: CallResult, req: TranslateRequest, config: LlmConfig): TranslationResult {
  try {
    if (res.truncated) {
      // 截断的 JSON 必然解析失败，直接给出可操作的提示而不是让它撞到 parse 错误
      throw new LlmError(`输出被 max_tokens(${config.maxTokens}) 截断，请在设置里调大`, "parse");
    }
    return normalizeTranslation(extractJson(res.text), req.kind, req.text);
  } catch (err) {
    if (err instanceof LlmError) {
      err.raw = { text: res.text, stopReason: res.stopReason };
      // 这个错是调用成功**之后**才造出来的，身上没有耗时；补上，
      // 不然日志里"生成了 40 秒最后解析失败"和"秒失败"分不开
      err.timing = res.timing;
    }
    throw err;
  }
}

export async function translate(
  req: TranslateRequest,
  config: LlmConfig,
  deps?: LlmDeps,
): Promise<{ result: TranslationResult; usage: RawUsage; timing: CallTiming }> {
  const system = translateSystem(req.kind, req.explainVocab);
  const res = await callMessages(config, system, buildTranslatePrompt(req), deps);
  return { result: finishTranslation(res, req, config), usage: res.usage, timing: res.timing };
}

/**
 * 匹配一对**已经闭合**的 `"键": "值"`。
 *
 * `(?:[^"\\]|\\.)*` 精确复刻 JSON 字符串的转义规则，所以匹配成功就意味着
 * 这个值已经生成完整——半截的字符串没有收尾引号，永远匹配不上。
 * 这是流式渲染能安全显示译文的全部依据：不解析半个 JSON，只认闭合的字段。
 */
const FIELD_RE = /"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/** 扫出尚未完整的 JSON 文本里所有已闭合的字符串字段。值为空串的当作没有。 */
export function closedFields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  FIELD_RE.lastIndex = 0; // 带 g 的正则是有状态的
  for (let m = FIELD_RE.exec(text); m !== null; m = FIELD_RE.exec(text)) {
    try {
      // 借 JSON.parse 还原 \n \" \uXXXX
      const v = (JSON.parse(`"${m[2]}"`) as string).trim();
      if (v) out[m[1]!] = v;
    } catch {
      /* 正则已保证是合法 JSON 字符串，走到这里只可能是引擎差异，跳过即可 */
    }
  }
  return out;
}

export function partialField(text: string, field: string): string | null {
  return closedFields(text)[field] ?? null;
}

/*
 * `closedFields` 是拍平扫的，不认嵌套。vocab 数组里每条也有 word / pos / phonetic，
 * 顺着扫下去，最后一条生词的 pos 会盖掉整条选区的 pos——短语选区上这个错误看得见：
 * 明明选的是短语，词性却成了里面某个生词的。
 *
 * 所以顶层字段只扫到 vocab 之前。两条依据让这个粗暴的正则是安全的：
 *
 * 1. **合法 JSON 的字符串里不可能出现裸的 `"vocab"`**——引号必须转义成 `\"`，
 *    于是译文里写到这个词时长成 `\"vocab\":`，`b` 后面跟的是反斜杠，匹配不上。
 * 2. 剩下的可能是模型在 JSON 之前先啰嗦一句、还照抄了字段名。取**最后**一次出现
 *    正好绕开它：真正的那个键由字段顺序保证排在最末。
 *
 * 两条都有用例盯着（test/stream.test.ts）。
 */
const VOCAB_KEY = /"vocab"\s*:/g;

function vocabKeyIndex(text: string): number {
  VOCAB_KEY.lastIndex = 0; // 带 g 的正则是有状态的
  let at = -1;
  for (let m = VOCAB_KEY.exec(text); m !== null; m = VOCAB_KEY.exec(text)) at = m.index;
  return at;
}

/** 顶层字符串字段的扫描范围。 */
export function topLevelSlice(text: string): string {
  const at = vocabKeyIndex(text);
  return at < 0 ? text : text.slice(0, at);
}

/**
 * 扫出 vocab 数组里**已经闭合**的那几条。
 *
 * 和 `closedFields` 同一条规矩：半个对象不推。判断闭合靠数花括号，
 * 并且要认字符串——`meaning` 里出现一个 `}` 是完全可能的（"…{的用法}"），
 * 不跟踪引号状态就会把它当成对象结束，解析出半条讲解。
 */
export function closedVocab(text: string, selection: string): VocabNote[] {
  const at = vocabKeyIndex(text);
  if (at < 0) return [];
  const from = text.indexOf("[", at);
  if (from < 0) return [];

  const out: VocabNote[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = from + 1; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth === 0) continue; // 多出来的右花括号，当没看见
      depth--;
      if (depth > 0 || start < 0) continue;
      try {
        const e = vocabEntry(JSON.parse(text.slice(start, i + 1)), selection);
        if (e) out.push(e);
      } catch {
        /* 这一条坏了不该拖累已经到齐的那几条 */
      }
      start = -1;
      if (out.length >= MAX_VOCAB) break;
    } else if (c === "]" && depth === 0) {
      break; // 数组收尾
    }
  }
  return out;
}

/** 把流到目前为止的文本折成一份可显示的快照。缺的字段就是还没生成到。 */
export function partialOf(text: string, kind: SnippetKind, selection: string): PartialTranslation {
  const f = closedFields(topLevelSlice(text));
  const word = kind !== "sentence";
  const pick = (k: string): string | null => f[k] ?? null;
  return {
    translation: pick("translation"),
    // 整句不该有音标词性，和 normalizeTranslation 保持同一条规矩
    phonetic: word ? pick("phonetic") : null,
    pos: word ? pick("pos") : null,
    contextNote: pick("context_note"),
    usage: word ? pick("usage") : null,
    vocab: kind === "word" ? [] : closedVocab(text, selection),
  };
}

/**
 * 流式翻译。`onPartial` **只在有字段新闭合时**触发，不是每个 token 都推——
 * 一次翻译至多回调四次，浮层因此只需要重排四次。
 */
export async function translateStream(
  req: TranslateRequest,
  config: LlmConfig,
  onPartial: (p: PartialTranslation) => void,
  signal?: AbortSignal,
  deps?: LlmDeps,
): Promise<{ result: TranslationResult; usage: RawUsage; timing: CallTiming }> {
  const now = deps?.now ?? Date.now;
  const t0 = now();
  /** 浮层第一次真显示出译文的时刻——用户感知的"等了多久"就是这个数，不是 totalMs。 */
  let firstFieldMs: number | null = null;
  let last = "";
  try {
    const res = await callMessagesStream(
      config,
      translateSystem(req.kind, req.explainVocab),
      buildTranslatePrompt(req),
      {
        signal,
        onDelta: (full) => {
          const p = partialOf(full, req.kind, req.text);
          const key = JSON.stringify(p);
          if (key === last) return; // 这几个 token 没让任何字段闭合
          last = key;
          // 头几个 token 还在写 `{"translation": "`，一个字段都没闭合，没什么可显示的
          if (!p.translation && !p.phonetic && !p.pos && !p.contextNote && !p.usage && p.vocab.length === 0) return;
          // 记在两道早退之后：走到这儿才是真推给了浮层
          if (p.translation && firstFieldMs === null) firstFieldMs = now() - t0;
          onPartial(p);
        },
      },
      deps,
    );
    return {
      result: finishTranslation(res, req, config),
      usage: res.usage,
      timing: { ...res.timing, firstFieldMs },
    };
  } catch (err) {
    // 底下那层填不了这个数，只有这里知道字段什么时候闭合的
    if (err instanceof LlmError && err.timing) err.timing.firstFieldMs = firstFieldMs;
    throw err;
  }
}

/* ==================== 复习助手 ==================== */

const ASSIST_SYSTEM = `你在帮一位中文母语者复习他读英文文章时划下的生词。
直接输出内容本身，不要开场白，不要 markdown 标题，不要代码块。控制在 120 字以内。`;

export interface AssistInput {
  key: string;
  translation: string;
  originalText: string;
  context: string;
  articleTitle: string;
}

export function buildAssistPrompt(mode: "example" | "explain" | "quiz", input: AssistInput): string {
  const head = `词：${input.key}
已知中文释义：${input.translation}
当初划到它的原句：${input.originalText}
出处：《${input.articleTitle || "未命名"}》`;
  const ask = {
    example: "请再造两个英文例句，场景要和上面那句不同，每句后面附中文翻译。",
    explain: "请换一个角度讲这个词：词根词缀、和近义词的区别、或者母语者什么时候会用它。",
    quiz: "请出一道英译中或填空题来考我，只给题目，不要给答案。最后一行单独写一行：答案：<答案>。",
  }[mode];
  return `${head}\n\n${ask}`;
}

export async function assist(
  mode: "example" | "explain" | "quiz",
  input: AssistInput,
  config: LlmConfig,
  deps?: LlmDeps,
): Promise<{ text: string; usage: RawUsage; timing: CallTiming }> {
  const { text, usage, timing } = await callMessages(config, ASSIST_SYSTEM, buildAssistPrompt(mode, input), deps);
  return { text: text.trim(), usage, timing };
}

/* ==================== 浮层里的追问 ==================== */

/**
 * 带过去的历史轮数上限。
 *
 * 追问是「就着眼前这个词再聊两句」，不是完整对话：轮数不封顶的话，读一篇长文时
 * 一个浮层能攒出几千 token 的前情，而其中大半和当前这一问无关。三轮足够撑住
 * 「那它呢」「为什么」这类顺着上一答的追问。
 */
export const ASK_HISTORY_TURNS = 3;

/** 单条历史答案带过去的字数上限。留个梗概就够模型接上话，全文照搬纯属浪费。 */
export const ASK_HISTORY_ANSWER_CHARS = 200;

const ASK_SYSTEM = `你在帮一位中文母语者读英文文章。他刚划下一段原文、看过你给的译文，现在就着它追问一句。
用中文回答，直接说答案，不要开场白，不要 markdown 标记，不要代码块。控制在 150 字以内。
问题与这段原文无关时，直接说不知道，不要编。`;

/**
 * 追问的 prompt。
 *
 * 译文和语境解释一并带上，是为了让模型别把用户已经看见的再复述一遍——
 * 这是追问最容易变废话的一种方式。
 */
export function buildAskPrompt(req: AskRequest): string {
  const parts = [
    `原文：${req.text}`,
    `已给出的译文：${req.translation}`,
  ];
  if (req.contextNote) parts.push(`已给出的语境解释：${req.contextNote}`);
  if (req.context) parts.push(`它所在的段落：${req.context}`);
  if (req.articleTitle) parts.push(`出处：《${req.articleTitle}》`);

  // 只带最近几轮，且答案留梗概：见 ASK_HISTORY_TURNS
  const history = req.history.slice(-ASK_HISTORY_TURNS);
  if (history.length > 0) {
    const lines = history.map(
      (t) => `问：${t.question}
答：${t.answer.slice(0, ASK_HISTORY_ANSWER_CHARS)}`,
    );
    parts.push([`之前问过的：`, ...lines].join("\n"));
  }

  parts.push(`现在的问题：${req.question}`);
  return parts.join("\n\n");
}

/**
 * 流式追问。答案是纯文本，不是 JSON，所以增量原样往外送——
 * 翻译那边要等字段闭合才敢显示（半个转义序列解析不了），这里没有这层顾虑。
 */
export async function askStream(
  req: AskRequest,
  config: LlmConfig,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  deps?: LlmDeps,
): Promise<{ text: string; usage: RawUsage; timing: CallTiming }> {
  const res = await callMessagesStream(
    config,
    ASK_SYSTEM,
    buildAskPrompt(req),
    {
      signal,
      // 头几个 token 常是换行；trimStart 之后为空就还没什么可显示的
      onDelta: (full) => {
        const t = full.trimStart();
        if (t) onDelta(t);
      },
    },
    deps,
  );
  // 追问没有"字段闭合"这回事，第一个字到了就在屏幕上：firstTextMs 就是它的可显示时间
  return { text: res.text.trim(), usage: res.usage, timing: res.timing };
}
