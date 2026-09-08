import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_HISTORY_TURNS,
  LlmError,
  buildAskPrompt,
  buildAssistPrompt,
  buildTranslatePrompt,
  callMessages,
  extractJson,
  normalizeTranslation,
  translate,
} from "../src/lib/llm.ts";
import type { AskRequest, LlmConfig, TranslateRequest } from "../src/types.ts";
import { DEFAULT_LLM } from "../src/types.ts";

const CFG: LlmConfig = { ...DEFAULT_LLM, apiKey: "test-key", timeoutMs: 1_000 };
const FENCE = "```";

const REQ: TranslateRequest = {
  articleId: "https://a.com/p",
  url: "https://a.com/p",
  articleTitle: "The Hidden Cost of Abstraction",
  text: "leaks",
  context: "Every abstraction leaks.",
  kind: "word",
  explainVocab: true,
};

/**
 * 规范化用例里的"选区"。生词讲解只留选中文本里出现的词，
 * 夹具用到的词都得在这里出现，否则会被 inSelection 挡掉。
 */
const SEL = "under scrutiny, every abstraction leaks: w0 w1 w2 w3 w4 w5 w6 w7 w8 x";

/** 造一个 Anthropic 形状的成功响应。 */
function okResponse(text: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text }],
      usage: { input_tokens: 12, output_tokens: 34 },
      stop_reason: "end_turn",
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/* ---------- JSON 抽取 ---------- */

test("extractJson 吃裸 JSON", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test("extractJson 剥掉 markdown 围栏", () => {
  assert.deepEqual(extractJson(FENCE + 'json\n{"a":1}\n' + FENCE), { a: 1 });
  assert.deepEqual(extractJson(FENCE + '\n{"a":2}\n' + FENCE), { a: 2 });
});

test("extractJson 忽略 JSON 前后的多余话", () => {
  assert.deepEqual(extractJson('好的，结果如下：\n{"a":3}\n希望有帮助'), { a: 3 });
});

test("extractJson 找不到 JSON 时抛 parse 错误", () => {
  assert.throws(() => extractJson("我没法翻译这个"), (e: unknown) => e instanceof LlmError && e.kind === "parse");
});

test("extractJson 认字符串里的花括号，也不被 JSON 后面带括号的废话带偏", () => {
  assert.deepEqual(extractJson('前言 {"note":"{的用法}"} 后记'), { note: "{的用法}" });
  // lastIndexOf("}") 会抓到废话里的那个括号
  assert.deepEqual(extractJson('{"a":1}\n注：{仅供参考}'), { a: 1 });
});

test("顶层对象没闭合时报截断，而不是一句看不出所以然的 SyntaxError", () => {
  const cut = (s: string): void =>
    assert.throws(
      () => extractJson(s),
      (e: unknown) => e instanceof LlmError && e.kind === "parse" && /截断/.test(e.message) && /max_tokens/.test(e.message),
    );
  // 最常见的形状：连一个 } 都还没生成
  cut('{"translation": "泄');
  // 掐在 vocab 数组中间：lastIndexOf("}") 会抓到最后一条生词的括号，抠出来的是缺了 ] } 的半截
  cut('{"translation":"泄漏","vocab":[{"word":"leaks","meaning":"泄漏"}');
});

/*
 * 下面几条的原文都是 MiniMax 真吐出来过的坏 JSON，从 0.3.2 的诊断日志里搬来。
 * 三种死法：中文里没转义的半角引号（最常见）、值位置上裸着的音标、以及它们混在正常转义之间。
 */

test("字符串里没转义的半角引号能修回来", () => {
  const raw =
    '{"translation": "能够实现细致的", "phonetic": null, "pos": null, "lemma": null,' +
    ' "context_note": "这里说 masking 比 clipping 强大在于它能基于遮罩图的透明度做"细致"的半透明和混合效果，不是只能像剪刀一样非黑即白。",' +
    ' "usage": "nuanced 强调"有细微差别的"，常和 distinction、understanding、approach 搭配。", "vocab": []}';
  const o = extractJson(raw) as Record<string, unknown>;
  assert.equal(o["translation"], "能够实现细致的");
  assert.equal(
    o["context_note"],
    '这里说 masking 比 clipping 强大在于它能基于遮罩图的透明度做"细致"的半透明和混合效果，不是只能像剪刀一样非黑即白。',
  );
  assert.equal(o["usage"], 'nuanced 强调"有细微差别的"，常和 distinction、understanding、approach 搭配。');
});

test("修补只补引号，不替模型润色内容", () => {
  // 日志里这条的 usage 值以一个多余的冒号开头。修补管的是"能不能解析"，
  // 模型自己写歪的内容照旧原样交出去——猜它想写什么是另一码事。
  const raw =
    '{"translation":"可理解的", "phonetic":"/ˌʌndərˈstændəbl/", "pos": "adj", "lemma": "understandable",' +
    ' "usage":":"understandable" 侧重"能被理解的"，区别于"understood"（已被理解的）。"}';
  const o = extractJson(raw) as Record<string, unknown>;
  assert.equal(o["lemma"], "understandable");
  assert.equal(o["usage"], ':"understandable" 侧重"能被理解的"，区别于"understood"（已被理解的）。');
});

test("引号是奇数个时也修得回来，不再被误报成截断", () => {
  // 成对的引号骗得过花括号扫描（在解析处炸），落单的这个会让扫描停在字符串里，收尾的 } 被吞掉
  const o = extractJson('{"translation":"他说"你好，然后走开了"}') as Record<string, unknown>;
  assert.equal(o["translation"], '他说"你好，然后走开了');
});

test("值位置上裸着的音标补上引号", () => {
  const raw =
    '{"translation":"充满困难的","phonetic":/frɔːt/,"pos":"adj","lemma":"fraught",' +
    '"context_note":"在文中指处理 sizes 属性这件事并不轻松，潜藏不少难题。",' +
    '"usage":"常与 with 连用，fraught with difficulty/problems 表示‘充满困难/问题’。"}';
  const o = extractJson(raw) as Record<string, unknown>;
  assert.equal(o["phonetic"], "/frɔːt/");
  assert.equal(o["lemma"], "fraught");
  // 字符串里的斜杠不能跟着遭殃
  assert.equal(o["usage"], "常与 with 连用，fraught with difficulty/problems 表示‘充满困难/问题’。");
});

test("修补不碰模型已经转义好的引号——回顾材料那份原文里两种混在一起", () => {
  const raw =
    '{"outline":["先用一段引言把 Babel 定性为通用 JavaScript 编译器，引入"静态分析"概念，说明一切后续操作都围绕节点展开。",' +
    '"过渡到插件实战：从签名（常见解构出 `types: t`，返回 `{ visitor }`），到第一个把 `===` 替换掉的插件。"],' +
    '"questions":["babylon 的 `sourceType` 默认值是什么？不传 `sourceType: \\"module\\"` 会发生什么？"]}';
  const o = extractJson(raw) as { outline: string[]; questions: string[] };
  assert.equal(o.outline[0], '先用一段引言把 Babel 定性为通用 JavaScript 编译器，引入"静态分析"概念，说明一切后续操作都围绕节点展开。');
  // 字符串里的花括号不能被当成对象收尾
  assert.match(o.outline[1]!, /\{ visitor \}/);
  assert.equal(o.questions[0], 'babylon 的 `sourceType` 默认值是什么？不传 `sourceType: "module"` 会发生什么？');
});

test("修不动的照旧报错，不把坏输出硬解释成对的", () => {
  // 字符串里的裸换行：可能是模型忘了写 \n，也可能它压根没在写 JSON，分不开就别猜
  assert.throws(
    () => extractJson('{"translation": "第一行\n第二行"}'),
    (e: unknown) => e instanceof LlmError && e.kind === "parse" && /JSON 解析失败/.test(e.message),
  );
});

/* ---------- 结果规范化 ---------- */

test("normalizeTranslation 保留完整字段", () => {
  const r = normalizeTranslation(
    { translation: "泄漏", context_note: "指抽象层暴露底层细节", pos: "verb", phonetic: "/liːks/", lemma: "leak" },
    "word",
    SEL,
  );
  assert.equal(r.translation, "泄漏");
  assert.equal(r.lemma, "leak");
  assert.equal(r.phonetic, "/liːks/");
});

test("normalizeTranslation 缺字段时补 null，不算失败", () => {
  const r = normalizeTranslation({ translation: "泄漏" }, "word", SEL);
  assert.equal(r.contextNote, "");
  assert.equal(r.pos, null);
  assert.equal(r.lemma, null);
});

test("normalizeTranslation 把字符串 'null' 当空值", () => {
  const r = normalizeTranslation({ translation: "泄漏", pos: "null", lemma: "  " }, "word", SEL);
  assert.equal(r.pos, null);
  assert.equal(r.lemma, null);
});

test("整句丢掉模型硬塞的词性/音标/词元", () => {
  const r = normalizeTranslation(
    { translation: "每个抽象都会泄漏。", pos: "noun", phonetic: "/x/", lemma: "leak", context_note: "点题句" },
    "sentence",
    SEL,
  );
  assert.equal(r.pos, null);
  assert.equal(r.phonetic, null);
  assert.equal(r.lemma, null);
  assert.equal(r.contextNote, "点题句", "整句仍然保留语境解释");
});

test("没有 translation 字段视为失败", () => {
  assert.throws(
    () => normalizeTranslation({ context_note: "只有解释" }, "word", SEL),
    (e: unknown) => e instanceof LlmError && e.kind === "parse",
  );
});

/* ---------- prompt 组装 ---------- */

test("prompt 带上标题、段落与选中文本", () => {
  const p = buildTranslatePrompt(REQ);
  assert.ok(p.includes("The Hidden Cost of Abstraction"));
  assert.ok(p.includes("Every abstraction leaks."));
  assert.ok(p.includes("选中文本：leaks"));
});

test("上下文的标签写明它只拿来判断词义", () => {
  // 只标一句"所在段落"，模型会把它当成同样要讲解的材料
  const p = buildTranslatePrompt(REQ);
  assert.ok(p.includes("所在段落（仅供判断词义，不要讲解其中的词）：Every abstraction leaks."));
});

test("上下文与选中文本相同时不重复发送", () => {
  const p = buildTranslatePrompt({ ...REQ, context: "leaks" });
  assert.equal(p.includes("所在段落"), false);
});

test("assist prompt 三种模式各不相同且都带原句", () => {
  const input = {
    key: "leak",
    translation: "泄漏",
    originalText: "Every abstraction leaks.",
    context: "…",
    articleTitle: "T",
  };
  const modes = (["example", "explain", "quiz"] as const).map((m) => buildAssistPrompt(m, input));
  assert.equal(new Set(modes).size, 3);
  for (const m of modes) assert.ok(m.includes("Every abstraction leaks."));
});

/* ---------- 浮层里的追问 ---------- */

const ASK: AskRequest = {
  text: "leaks",
  kind: "word",
  translation: "泄漏",
  contextNote: "本文里指抽象挡不住底层细节。",
  context: "Every abstraction leaks.",
  articleTitle: "The Hidden Cost of Abstraction",
  question: "它和 leak 有什么区别？",
  history: [],
};

test("追问 prompt 带上已给出的译文和语境解释——模型不该把用户看过的再说一遍", () => {
  const p = buildAskPrompt(ASK);
  assert.ok(p.includes("leaks"));
  assert.ok(p.includes("泄漏"));
  assert.ok(p.includes("本文里指抽象挡不住底层细节。"));
  assert.ok(p.includes("Every abstraction leaks."));
  // 问题排在最后：前面全是材料，模型该照着最后这一句答
  assert.ok(p.trimEnd().endsWith("它和 leak 有什么区别？"));
});

test("空的语境解释 / 段落不占位", () => {
  const p = buildAskPrompt({ ...ASK, contextNote: "", context: "", articleTitle: "" });
  assert.equal(p.includes("语境解释"), false);
  assert.equal(p.includes("段落"), false);
  assert.equal(p.includes("出处"), false);
});

test("历史只带最近几轮，超出的丢掉", () => {
  const history = Array.from({ length: ASK_HISTORY_TURNS + 2 }, (_, i) => ({
    question: `第${i}问`,
    answer: `第${i}答`,
  }));
  const p = buildAskPrompt({ ...ASK, history });
  // 前两轮被挤掉，最后三轮留着
  assert.equal(p.includes("第0问"), false);
  assert.equal(p.includes("第1问"), false);
  for (let i = 2; i < history.length; i++) assert.ok(p.includes(`第${i}问`), `第${i}问 应当带上`);
});

test("历史里的长答案只留梗概，不整段抄回去", () => {
  const answer = "答".repeat(500);
  const p = buildAskPrompt({ ...ASK, history: [{ question: "上一问", answer }] });
  assert.equal(p.includes(answer), false, "整段照抄等于每问一次就把前面全付一遍钱");
  assert.ok(p.includes("上一问"));
});

/* ---------- HTTP 层 ---------- */

test("请求带上 x-api-key 与 anthropic-version，路径拼 /v1/messages", async () => {
  let seenUrl = "";
  let seenInit: RequestInit = {};
  await callMessages(CFG, "sys", "usr", {
    fetch: (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return okResponse("hi");
    }) as unknown as typeof fetch,
  });
  assert.equal(seenUrl, "https://api.minimaxi.com/anthropic/v1/messages");
  const h = seenInit.headers as Record<string, string>;
  assert.equal(h["x-api-key"], "test-key");
  assert.equal(h["anthropic-version"], "2023-06-01");
  const body = JSON.parse(seenInit.body as string) as Record<string, unknown>;
  assert.equal(body["system"], "sys");
  assert.deepEqual(body["messages"], [{ role: "user", content: "usr" }]);
});

test("baseUrl 末尾多余斜杠不会拼出双斜杠", async () => {
  let url = "";
  await callMessages({ ...CFG, baseUrl: "https://api.minimaxi.com/anthropic///" }, "s", "u", {
    fetch: (async (u: string) => {
      url = u;
      return okResponse("hi");
    }) as unknown as typeof fetch,
  });
  assert.equal(url, "https://api.minimaxi.com/anthropic/v1/messages");
});

test("未配置 key 时不发请求", async () => {
  let called = false;
  await assert.rejects(
    callMessages({ ...CFG, apiKey: "" }, "s", "u", {
      fetch: (async () => {
        called = true;
        return okResponse("x");
      }) as unknown as typeof fetch,
    }),
    (e: unknown) => e instanceof LlmError && e.kind === "config",
  );
  assert.equal(called, false);
});

test("HTTP 错误带上状态码与响应体片段", async () => {
  await assert.rejects(
    callMessages(CFG, "s", "u", {
      fetch: (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
    }),
    (e: unknown) => e instanceof LlmError && e.kind === "http" && e.status === 401 && e.message.includes("unauthorized"),
  );
});

/* ---------- 耗时 ---------- */

/**
 * 每问一次时间就往前走 100ms 的假时钟。
 *
 * 这样耗时里的每个数字都对应"第几次取时间"，可以钉死断言——
 * 用真实时钟只能断言"≥0"，那验不出首字到底记在了哪一刻。
 */
function stepClock(step = 100): () => number {
  let t = -step;
  return () => (t += step);
}

test("非流式的耗时：总时长有，两个 first 没有", async () => {
  // 取两次时间：起跑一次、收尾一次
  const res = await callMessages(CFG, "s", "u", {
    now: stepClock(),
    fetch: (async () => okResponse('{"a":1}')) as unknown as typeof fetch,
  });
  assert.equal(res.timing.totalMs, 100);
  // 非流式在整段生成完之前什么都没有，"第一个字"无从谈起
  assert.equal(res.timing.firstTextMs, null);
  assert.equal(res.timing.firstFieldMs, null);
  assert.equal(res.timing.attempts, 1);
});

test("失败也带着耗时——慢到超时和秒失败在日志里得分得开", async () => {
  await assert.rejects(
    callMessages(CFG, "s", "u", {
      now: stepClock(),
      fetch: (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
    }),
    (e: unknown) => e instanceof LlmError && e.timing?.totalMs === 100 && e.timing.attempts === 1,
  );
});

test("缺配置那次没发出去过，不该带耗时", async () => {
  await assert.rejects(
    callMessages({ ...CFG, apiKey: "" }, "s", "u", { fetch: (async () => okResponse("x")) as unknown as typeof fetch }),
    (e: unknown) => e instanceof LlmError && e.kind === "config" && e.timing === undefined,
  );
});

/* ---------- 过载重试 ---------- */

/** 数一次调用发了几次请求。前 `fails` 次回 529，之后回正常响应。 */
function overloadedThen(fails: number): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchFn = async (): Promise<Response> => {
    calls++;
    return calls <= fails ? new Response("集群负载较高，请稍后重试", { status: 529 }) : okResponse('{"a":1}');
  };
  return { fetch: fetchFn as unknown as typeof fetch, calls: () => calls };
}

test("529 过载退避后重试一次", async () => {
  const f = overloadedThen(1);
  const res = await callMessages(CFG, "s", "u", { fetch: f.fetch, retryDelayMs: 0 });
  assert.equal(f.calls(), 2);
  assert.equal(res.text, '{"a":1}');
});

test("只重试一次——用户正等着，第二次还过载就老实报错", async () => {
  const f = overloadedThen(99);
  await assert.rejects(
    callMessages(CFG, "s", "u", { fetch: f.fetch, retryDelayMs: 0 }),
    (e: unknown) => e instanceof LlmError && e.kind === "http" && e.status === 529,
  );
  assert.equal(f.calls(), 2);
});

test("请求本身有问题的不重试——重发一遍还是同样的错", async () => {
  let calls = 0;
  await assert.rejects(
    callMessages(CFG, "s", "u", {
      retryDelayMs: 0,
      fetch: (async () => {
        calls++;
        return new Response("bad request", { status: 400 });
      }) as unknown as typeof fetch,
    }),
    (e: unknown) => e instanceof LlmError && e.status === 400,
  );
  assert.equal(calls, 1);
});

test("重试过的调用数得出来——不然那 1.2 秒退避会被当成模型慢", async () => {
  const f = overloadedThen(1);
  const res = await callMessages(CFG, "s", "u", { fetch: f.fetch, retryDelayMs: 0, now: stepClock() });
  assert.equal(res.timing.attempts, 2);
});

test("HTTP 200 但 base_resp 报错也算失败", async () => {
  // MiniMax 的业务错误（余额不足等）走这条路，不是 HTTP 状态码
  await assert.rejects(
    callMessages(CFG, "s", "u", {
      fetch: (async () =>
        okResponse("x", {
          base_resp: { status_code: 1008, status_msg: "insufficient balance" },
        })) as unknown as typeof fetch,
    }),
    (e: unknown) => e instanceof LlmError && e.message.includes("1008"),
  );
});

test("base_resp.status_code 为 0 是正常响应", async () => {
  const r = await callMessages(CFG, "s", "u", {
    fetch: (async () => okResponse("ok", { base_resp: { status_code: 0, status_msg: "" } })) as unknown as typeof fetch,
  });
  assert.equal(r.text, "ok");
});

test("多个 text block 会被拼接，非 text block 被忽略", async () => {
  const r = await callMessages(CFG, "s", "u", {
    fetch: (async () =>
      new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "前" },
            { type: "thinking", thinking: "略" },
            { type: "text", text: "后" },
          ],
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
  assert.equal(r.text, "前后");
});

test("超时抛 timeout 而不是 network", async () => {
  await assert.rejects(
    callMessages({ ...CFG, timeoutMs: 20 }, "s", "u", {
      fetch: ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        })) as unknown as typeof fetch,
    }),
    (e: unknown) => e instanceof LlmError && e.kind === "timeout",
  );
});

test("usage 被如实带出", async () => {
  const r = await callMessages(CFG, "s", "u", {
    fetch: (async () => okResponse("x")) as unknown as typeof fetch,
  });
  assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 34 });
});

/* ---------- translate 端到端（mock）---------- */

test("translate 串起解析全流程", async () => {
  const payload =
    '{"translation":"泄漏","context_note":"指抽象暴露底层","pos":"verb","phonetic":"/liːks/","lemma":"leak"}';
  const { result, usage } = await translate(REQ, CFG, {
    fetch: (async () => okResponse(payload)) as unknown as typeof fetch,
  });
  assert.equal(result.translation, "泄漏");
  assert.equal(result.lemma, "leak");
  assert.equal(usage.inputTokens, 12);
});

test("输出被 max_tokens 截断时给出可操作的提示", async () => {
  await assert.rejects(
    translate(REQ, CFG, {
      fetch: (async () => okResponse('{"translation":"泄', { stop_reason: "max_tokens" })) as unknown as typeof fetch,
    }),
    (e: unknown) => e instanceof LlmError && e.message.includes("max_tokens") && e.raw?.stopReason === "max_tokens",
  );
});

test("stop_reason 没说截断、但 JSON 没闭合时同样提示调大 max_tokens", async () => {
  // MiniMax 兼容层在 stop_reason 上回什么并无保证，截断判定不能只认这个字段
  await assert.rejects(
    translate(REQ, CFG, {
      fetch: (async () => okResponse('{"translation":"泄', { stop_reason: "end_turn" })) as unknown as typeof fetch,
    }),
    (e: unknown) => e instanceof LlmError && e.kind === "parse" && /max_tokens/.test(e.message),
  );
});

test("解析失败的错误带着完整原文和 stop_reason，给 background 记日志", async () => {
  const payload = '{"translation": "第一行\n第二行"}'; // 字符串里的裸换行，JSON 不认
  await assert.rejects(
    translate(REQ, CFG, { fetch: (async () => okResponse(payload)) as unknown as typeof fetch }),
    (e: unknown) => e instanceof LlmError && e.raw !== undefined && e.raw.text === payload && e.raw.stopReason === "end_turn",
  );
});

/* ---------- 生词讲解 ---------- */

/** 捕获一次调用实际发出去的 system prompt。 */
async function systemOf(req: TranslateRequest): Promise<string> {
  let system = "";
  await translate(req, CFG, {
    fetch: (async (_u: string, init: RequestInit) => {
      system = (JSON.parse(init.body as string) as { system: string }).system;
      return okResponse('{"translation": "x"}');
    }) as unknown as typeof fetch,
  });
  return system;
}

test("整句要生词讲解，不要用法——用法是词的属性，不是句子的", async () => {
  const s = await systemOf({ ...REQ, kind: "sentence" });
  assert.ok(s.includes("- vocab"));
  assert.equal(s.includes("- usage"), false);
});

test("单词要用法，不要生词讲解——整条记录讲的就是它自己", async () => {
  const s = await systemOf({ ...REQ, kind: "word" });
  assert.ok(s.includes("- usage"));
  assert.equal(s.includes("- vocab"), false);
});

test("短语两样都要", async () => {
  const s = await systemOf({ ...REQ, kind: "phrase" });
  assert.ok(s.includes("- usage"));
  assert.ok(s.includes("- vocab"));
});

test("关掉讲解后 prompt 里一个字都不提", async () => {
  const s = await systemOf({ ...REQ, kind: "phrase", explainVocab: false });
  assert.equal(s.includes("usage"), false);
  assert.equal(s.includes("vocab"), false);
});

test("prompt 里说死只讲选中文本里的词", async () => {
  const s = await systemOf({ ...REQ, kind: "sentence" });
  assert.ok(s.includes("只讲「选中文本」里出现的词"));
});

const ENTRY = { word: "scrutiny", phonetic: "/ˈskruːtəni/", pos: "noun", meaning: "审视", note: "常搭配 under ~" };

test("生词讲解原样保留", () => {
  const r = normalizeTranslation({ translation: "…", vocab: [ENTRY] }, "sentence", SEL);
  assert.deepEqual(r.vocab, [ENTRY]);
});

test("缺词或缺意思的条目丢掉——只有词没有意思不叫讲解", () => {
  const r = normalizeTranslation(
    { translation: "…", vocab: [ENTRY, { word: "x" }, { meaning: "只有意思" }, "不是对象", null] },
    "sentence",
    SEL,
  );
  assert.deepEqual(r.vocab.map((v) => v.word), ["scrutiny"]);
});

test("可选字段缺失补 null，不影响这一条成立", () => {
  const r = normalizeTranslation({ translation: "…", vocab: [{ word: "leak", meaning: "泄漏" }] }, "sentence", SEL);
  assert.deepEqual(r.vocab, [{ word: "leak", phonetic: null, pos: null, meaning: "泄漏", note: null }]);
});

test("最多留 5 条，模型多给的丢掉", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ word: `w${i}`, meaning: `m${i}` }));
  const r = normalizeTranslation({ translation: "…", vocab: many }, "sentence", SEL);
  assert.equal(r.vocab.length, 5);
  assert.equal(r.vocab[4]!.word, "w4", "留的是前 5 条，按出现顺序");
});

test("vocab 不是数组就当没有", () => {
  assert.deepEqual(normalizeTranslation({ translation: "…", vocab: "scrutiny" }, "sentence", SEL).vocab, []);
  assert.deepEqual(normalizeTranslation({ translation: "…" }, "sentence", SEL).vocab, []);
});

test("单词选区丢掉模型硬给的 vocab，整句丢掉硬给的 usage", () => {
  const w = normalizeTranslation({ translation: "泄漏", usage: "常和 abstraction 连用", vocab: [ENTRY] }, "word", SEL);
  assert.deepEqual(w.vocab, [], "单词没有'其中的生词'");
  assert.equal(w.usage, "常和 abstraction 连用");

  const s = normalizeTranslation({ translation: "…", usage: "句子的用法？", vocab: [ENTRY] }, "sentence", SEL);
  assert.equal(s.usage, null, "整句没有'这个词怎么用'");
  assert.equal(s.vocab.length, 1);
});

test("只讲选中文本里的词——上下文段落里的词丢掉", () => {
  // 用户选的是 under scrutiny，hindsight 只在同一段的别处出现
  const r = normalizeTranslation(
    { translation: "…", vocab: [ENTRY, { word: "hindsight", meaning: "事后看来" }] },
    "sentence",
    "under scrutiny",
  );
  assert.deepEqual(
    r.vocab.map((v) => v.word),
    ["scrutiny"],
    "段落里的词不是用户选的，不该讲",
  );
});

test("选区外的词不占名额——过滤在计数之前", () => {
  const many = [
    { word: "outsider", meaning: "段落里的词" },
    ...Array.from({ length: 5 }, (_, i) => ({ word: `w${i}`, meaning: `m${i}` })),
  ];
  const r = normalizeTranslation({ translation: "…", vocab: many }, "sentence", "w0 w1 w2 w3 w4");
  assert.equal(r.vocab.length, 5, "被丢掉的那条不该吃掉一个名额");
});

test("大小写、弯引号、多余空白不影响是不是在选区里", () => {
  const vocab = [
    { word: "Don't", meaning: "别" }, // 原文写的是弯引号的 don’t
    { word: "in  hindsight", meaning: "事后看来" },
    { word: "leak", meaning: "泄漏" }, // 原文是 leaks，给原形也认
  ];
  const sel = "Don’t say in hindsight that every abstraction leaks";
  const r = normalizeTranslation({ translation: "…", vocab }, "sentence", sel);
  assert.deepEqual(
    r.vocab.map((v) => v.word),
    ["Don't", "in  hindsight", "leak"],
  );
});

test("JSON 解析失败时把出错的原文带出来", () => {
  // 线上只剩一句"JSON 解析失败"的话，模型到底吐了什么无从查起——
  // 实测就撞见过一次长选区返回位置 120 处不合法的 JSON
  assert.throws(
    () => extractJson('{"translation": "缺了收尾引号}'),
    (e: unknown) => e instanceof LlmError && e.kind === "parse" && e.message.includes("缺了收尾引号"),
  );
  // 闭合了但内容不合法（字符串里的裸换行）：走的是 SyntaxError 那条分支，原文同样要带上
  assert.throws(
    () => extractJson('{"translation": "第一行\n第二行"}'),
    (e: unknown) => e instanceof LlmError && e.kind === "parse" && /JSON 解析失败/.test(e.message) && e.message.includes("第一行"),
  );
});
