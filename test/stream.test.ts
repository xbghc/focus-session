import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LlmError,
  callMessagesStream,
  closedVocab,
  partialField,
  partialOf,
  sseEvents,
  topLevelSlice,
  translateStream,
} from "../src/lib/llm.ts";
import type { LlmConfig, PartialTranslation, TranslateRequest } from "../src/types.ts";
import { DEFAULT_LLM } from "../src/types.ts";

const CFG: LlmConfig = { ...DEFAULT_LLM, apiKey: "test-key", timeoutMs: 1_000 };

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
 * 解析用例里的"选区"。生词讲解只留选中文本里出现的词，
 * 这些用例关心的是解析，所以把夹具用到的词都放进来。
 */
const SEL = "every abstraction leaks, a brace } in x y: w0 w1 w2 w3 w4 w5 w6 w7";

/** 把一串字符串当作 SSE 分块发出去。分块边界故意乱切，模拟真实网络。 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= chunks.length) {
        c.close();
        return;
      }
      c.enqueue(enc.encode(chunks[i]!));
      i += 1;
    },
  });
}

const evt = (o: unknown): string => `event: x\ndata: ${JSON.stringify(o)}\n\n`;

/** 把一段文本切成 n 字一组的 text_delta 事件，前后配上 message_start / message_delta。 */
function textStream(text: string, step = 6, stopReason = "end_turn"): string[] {
  const out = [evt({ type: "message_start", message: { usage: { input_tokens: 120 } } })];
  for (let i = 0; i < text.length; i += step) {
    out.push(evt({ type: "content_block_delta", delta: { type: "text_delta", text: text.slice(i, i + step) } }));
  }
  // MiniMax 把真实 input_tokens 放在收尾的 message_delta 里（message_start 里恒为 0）
  out.push(evt({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { input_tokens: 249, output_tokens: 58 } }));
  return out;
}

function fetchOf(chunks: string[], status = 200): typeof fetch {
  return (async () =>
    new Response(streamOf(chunks), {
      status,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
}

/* ---------- SSE 拆包 ---------- */

test("sseEvents 只取 data 行，跳过 event 行和空行", async () => {
  const got: unknown[] = [];
  for await (const e of sseEvents(streamOf([evt({ type: "a" }), evt({ type: "b" })]))) got.push(e);
  assert.deepEqual(got, [{ type: "a" }, { type: "b" }]);
});

test("sseEvents 能拼回被切断在中间的一行", async () => {
  const whole = evt({ type: "content_block_delta", delta: { type: "text_delta", text: "你好" } });
  const cut = [whole.slice(0, 20), whole.slice(20, 45), whole.slice(45)];
  const got: Array<Record<string, unknown>> = [];
  for await (const e of sseEvents(streamOf(cut))) got.push(e);
  assert.equal(got.length, 1);
  assert.equal((got[0]!["delta"] as { text: string }).text, "你好");
});

test("sseEvents 忽略坏掉的单条事件，不中断整个流", async () => {
  const got: unknown[] = [];
  for await (const e of sseEvents(streamOf([`data: {坏的\n\n`, evt({ type: "ok" })]))) got.push(e);
  assert.deepEqual(got, [{ type: "ok" }]);
});

test("sseEvents 忽略 [DONE] 哨兵", async () => {
  const got: unknown[] = [];
  for await (const e of sseEvents(streamOf([`data: [DONE]\n\n`]))) got.push(e);
  assert.deepEqual(got, []);
});

/* ---------- 部分字段抽取 ---------- */

test("字段闭合前拿不到值，闭合后立刻拿到", () => {
  assert.equal(partialField(`{"translation": "泄漏`, "translation"), null);
  assert.equal(partialField(`{"translation": "泄漏"`, "translation"), "泄漏");
  assert.equal(partialField(`{"translation": "泄漏", "pos": "verb"}`, "pos"), "verb");
});

test("字段值里的转义被正确还原，且不会被引号骗到", () => {
  assert.equal(partialField(`{"translation": "他说\\"好\\"", "pos"`, "translation"), '他说"好"');
  assert.equal(partialField(`{"translation": "第一行\\n第二行"`, "translation"), "第一行\n第二行");
});

test("字段是 null 或缺失都返回 null", () => {
  assert.equal(partialField(`{"phonetic": null, "pos": "noun"}`, "phonetic"), null);
  assert.equal(partialField(`{"translation": "x"}`, "lemma"), null);
});

test("整句不返回音标词性，和 normalizeTranslation 同一条规矩", () => {
  const raw = `{"translation": "抽象都会泄漏", "phonetic": "/liːks/", "pos": "verb", "context_note": "本文里…"}`;
  assert.deepEqual(partialOf(raw, "sentence", SEL), {
    translation: "抽象都会泄漏",
    phonetic: null,
    pos: null,
    contextNote: "本文里…",
    usage: null,
    vocab: [],
  });
  assert.equal(partialOf(raw, "word", SEL).phonetic, "/liːks/");
});

/* ---------- 流式调用 ---------- */

test("流式调用把文本拼齐并带回用量", async () => {
  const seen: string[] = [];
  const res = await callMessagesStream(
    CFG,
    "sys",
    "user",
    { onDelta: (full) => seen.push(full) },
    { fetch: fetchOf(textStream("abcdefghij", 4)) },
  );
  assert.equal(res.text, "abcdefghij");
  assert.deepEqual(res.usage, { inputTokens: 249, outputTokens: 58 });
  assert.equal(res.truncated, false);
  // onDelta 拿到的是累积文本，不是增量
  assert.deepEqual(seen, ["abcd", "abcdefgh", "abcdefghij"]);
});

test("max_tokens 截断能被识别出来", async () => {
  const res = await callMessagesStream(CFG, "s", "u", { onDelta: () => {} }, { fetch: fetchOf(textStream("ab", 2, "max_tokens")) });
  assert.equal(res.truncated, true);
  assert.equal(res.stopReason, "max_tokens");
});

test("流里的 error 事件变成 LlmError", async () => {
  await assert.rejects(
    () =>
      callMessagesStream(
        CFG,
        "s",
        "u",
        { onDelta: () => {} },
        { fetch: fetchOf([evt({ type: "error", error: { message: "Overloaded" } })]) },
      ),
    (e: unknown) => e instanceof LlmError && e.kind === "http" && /Overloaded/.test(e.message),
  );
});

test("HTTP 200 里的 base_resp 业务错误也要拦下", async () => {
  await assert.rejects(
    () =>
      callMessagesStream(
        CFG,
        "s",
        "u",
        { onDelta: () => {} },
        {
          fetch: fetchOf([
            evt({ type: "message_start", message: { base_resp: { status_code: 1008, status_msg: "余额不足" } } }),
          ]),
        },
      ),
    (e: unknown) => e instanceof LlmError && e.kind === "http" && /1008/.test(e.message),
  );
});

test("缺 API key 直接报 config，不发请求", async () => {
  let called = false;
  await assert.rejects(
    () =>
      callMessagesStream(
        { ...CFG, apiKey: "" },
        "s",
        "u",
        { onDelta: () => {} },
        {
          fetch: (() => {
            called = true;
            return Promise.reject(new Error("不该走到这"));
          }) as unknown as typeof fetch,
        },
      ),
    (e: unknown) => e instanceof LlmError && e.kind === "config",
  );
  assert.equal(called, false);
});

test("已经取消的 signal 不会发出请求", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => callMessagesStream(CFG, "s", "u", { onDelta: () => {}, signal: ctrl.signal }, { fetch: fetchOf([]) }),
    (e: unknown) => e instanceof LlmError && e.kind === "abort",
  );
});

test("流到一半取消，报 abort 而不是 network", async () => {
  const ctrl = new AbortController();
  const chunks = textStream("abcdefghij", 2);
  const fetchImpl = (async (_u: string, init: RequestInit) =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(chunks.slice(0, 2).join("")));
          // 真实 fetch 在 abort 时会把 body 流打断，这里手动模拟同样的行为
          init.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  await assert.rejects(
    // 第一段文本一到就取消——用户关掉浮层就是这个时序
    () => callMessagesStream(CFG, "s", "u", { onDelta: () => ctrl.abort(), signal: ctrl.signal }, { fetch: fetchImpl }),
    (e: unknown) => e instanceof LlmError && e.kind === "abort",
  );
});

test("请求超时报 timeout", async () => {
  const fetchImpl = ((_u: string, init: RequestInit) =>
    new Promise((_res, rej) => {
      init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
    })) as unknown as typeof fetch;
  await assert.rejects(
    () => callMessagesStream({ ...CFG, timeoutMs: 20 }, "s", "u", { onDelta: () => {} }, { fetch: fetchImpl }),
    (e: unknown) => e instanceof LlmError && e.kind === "timeout",
  );
});

test("非 2xx 原样带出响应体，方便排查", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    () => callMessagesStream(CFG, "s", "u", { onDelta: () => {} }, { fetch: fetchImpl }),
    (e: unknown) => e instanceof LlmError && e.kind === "http" && e.status === 401 && /nope/.test(e.message),
  );
});

test("一个字都没流出来算 parse 失败", async () => {
  await assert.rejects(
    () => callMessagesStream(CFG, "s", "u", { onDelta: () => {} }, { fetch: fetchOf([evt({ type: "message_stop" })]) }),
    (e: unknown) => e instanceof LlmError && e.kind === "parse",
  );
});

test("请求体里带上 stream:true", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(streamOf(textStream("ok")), { status: 200 });
  }) as unknown as typeof fetch;
  await callMessagesStream(CFG, "s", "u", { onDelta: () => {} }, { fetch: fetchImpl });
  assert.equal(body["stream"], true);
});

/* ---------- translateStream ---------- */

const FULL_JSON = JSON.stringify({
  translation: "泄漏",
  phonetic: "/liːks/",
  pos: "verb",
  lemma: "leak",
  context_note: "本文里指抽象层挡不住底层细节。",
});

test("译文先于语境解释推送出去", async () => {
  const seen: PartialTranslation[] = [];
  const { result } = await translateStream(REQ, CFG, (p) => seen.push({ ...p }), undefined, {
    fetch: fetchOf(textStream(FULL_JSON, 5)),
  });

  const firstWithTr = seen.findIndex((p) => p.translation !== null);
  const firstWithNote = seen.findIndex((p) => p.contextNote !== null);
  assert.ok(firstWithTr >= 0, "译文应当在流中途就能显示");
  assert.ok(firstWithTr < firstWithNote, "译文必须早于语境解释到达");
  assert.equal(seen[firstWithTr]!.translation, "泄漏");
  assert.equal(result.translation, "泄漏");
  assert.equal(result.lemma, "leak");
});

test("只在字段新闭合时回调，不是每个 token 都推", async () => {
  let calls = 0;
  await translateStream(REQ, CFG, () => (calls += 1), undefined, { fetch: fetchOf(textStream(FULL_JSON, 1)) });
  // FULL_JSON 逐字流出有一百多个 delta，但可显示字段只有四个
  assert.ok(calls > 0 && calls <= 4, `回调次数应当 ≤4，实际 ${calls}`);
});

test("流式结果同样走 normalizeTranslation 做最终校正", async () => {
  const raw = JSON.stringify({ translation: "泄漏", phonetic: "/liːks/", pos: "verb", context_note: "…" });
  const { result } = await translateStream({ ...REQ, kind: "sentence" }, CFG, () => {}, undefined, {
    fetch: fetchOf(textStream(raw, 8)),
  });
  // 整句不该带走音标词性，哪怕模型硬给
  assert.equal(result.phonetic, null);
  assert.equal(result.pos, null);
});

test("被截断的输出给出可操作的提示，而不是撞到 JSON 解析错", async () => {
  await assert.rejects(
    () => translateStream(REQ, CFG, () => {}, undefined, { fetch: fetchOf(textStream(`{"translation": "泄`, 4, "max_tokens")) }),
    (e: unknown) => e instanceof LlmError && e.kind === "parse" && /max_tokens/.test(e.message),
  );
});

test("stop_reason 没说截断、但 JSON 没闭合时同样提示调大 max_tokens", async () => {
  await assert.rejects(
    () => translateStream(REQ, CFG, () => {}, undefined, { fetch: fetchOf(textStream(`{"translation": "泄`, 4, "end_turn")) }),
    (e: unknown) => e instanceof LlmError && e.kind === "parse" && /max_tokens/.test(e.message),
  );
});

test("流式解析失败的错误同样带着完整原文和 stop_reason", async () => {
  const raw = `{"translation": "泄`;
  await assert.rejects(
    () => translateStream(REQ, CFG, () => {}, undefined, { fetch: fetchOf(textStream(raw, 4, "end_turn")) }),
    (e: unknown) => e instanceof LlmError && e.raw !== undefined && e.raw.text === raw && e.raw.stopReason === "end_turn",
  );
});

test("message_start 里 input_tokens 为 0 时退回 message_delta 的值", async () => {
  // MiniMax 的实际行为：message_start.usage.input_tokens 恒为 0
  const chunks = [
    evt({ type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } }),
    evt({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }),
    evt({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 37, output_tokens: 49 } }),
  ];
  const res = await callMessagesStream(CFG, "s", "u", { onDelta: () => {} }, { fetch: fetchOf(chunks) });
  assert.deepEqual(res.usage, { inputTokens: 37, outputTokens: 49 });
});

/* ---------- 生词讲解的流式解析 ---------- */

/** 顶层字段都已闭合，生词正在往外蹦。 */
const HEAD = '{"translation": "抽象总会泄漏", "context_note": "本文里指底层细节挡不住", "vocab": [';
const V1 = '{"word": "abstraction", "phonetic": "/ˌæbˈstrækʃn/", "pos": "noun", "meaning": "抽象层", "note": null}';
const V2 = '{"word": "leak", "phonetic": "/liːk/", "pos": "verb", "meaning": "渗漏出来", "note": "此处是比喻"}';

test("生词一条一条地出现，半条不算", () => {
  assert.deepEqual(closedVocab(HEAD, SEL), [], "数组刚开头，一条都没有");
  assert.deepEqual(closedVocab(HEAD + V1.slice(0, 40), SEL).length, 0, "写到一半的对象不推");
  assert.deepEqual(
    closedVocab(HEAD + V1, SEL).map((v) => v.word),
    ["abstraction"],
  );
  assert.deepEqual(
    closedVocab(`${HEAD + V1}, ${V2}`, SEL).map((v) => v.word),
    ["abstraction", "leak"],
  );
});

test("闭合的条目里缺词或缺意思照样丢掉", () => {
  assert.deepEqual(closedVocab(HEAD + '{"word": "leak"}', SEL), [], "只有词没有意思不叫讲解");
});

test("meaning 里的右花括号不会被当成对象结束", () => {
  const tricky = '{"word": "brace", "meaning": "花括号 } 本身", "pos": null, "phonetic": null, "note": null}';
  const got = closedVocab(HEAD + tricky, SEL);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.meaning, "花括号 } 本身");
});

test("数组收尾后不再往下扫", () => {
  const after = `${HEAD + V1}], "trailing": [{"word": "x", "meaning": "y"}]}`;
  assert.deepEqual(
    closedVocab(after, SEL).map((v) => v.word),
    ["abstraction"],
  );
});

test("最多认 5 条", () => {
  const many = Array.from({ length: 8 }, (_, i) => `{"word": "w${i}", "meaning": "m${i}"}`).join(", ");
  assert.equal(closedVocab(HEAD + many, SEL).length, 5);
});

test("还没写到 vocab 就没有生词", () => {
  assert.deepEqual(closedVocab('{"translation": "泄漏"', SEL), []);
});

test("短语选区：生词里的 pos 不会盖掉整条选区的 pos", () => {
  // closedFields 是拍平扫的，不在 vocab 之前打住的话，
  // 明明选的是名词短语，词性却成了里面某个生词的 verb
  const raw =
    '{"translation": "抽象泄漏", "phonetic": "/ˌæbˈstrækʃn liːks/", "pos": "noun phrase", ' +
    '"usage": "常作主语", "vocab": [' +
    V2 +
    "]}";
  const p = partialOf(raw, "phrase", SEL);
  assert.equal(p.pos, "noun phrase");
  assert.equal(p.phonetic, "/ˌæbˈstrækʃn liːks/");
  assert.equal(p.usage, "常作主语");
  assert.equal(p.vocab[0]!.pos, "verb", "生词自己的词性照常带出来");
});

test("topLevelSlice 在 vocab 之前打住", () => {
  assert.equal(topLevelSlice('{"a": "1", "vocab": [{"pos": "verb"}]}'), '{"a": "1", ');
  assert.equal(topLevelSlice('{"a": "1"}'), '{"a": "1"}', "没有 vocab 就是全文");
});

test("单词选区不解析 vocab——模型硬给也不显示", () => {
  const raw = `${HEAD + V1}]}`;
  assert.deepEqual(partialOf(raw, "word", SEL).vocab, []);
  assert.equal(partialOf(raw, "sentence", SEL).vocab.length, 1);
});

test("整句选区不显示 usage，和 normalizeTranslation 同一条规矩", () => {
  const raw = '{"translation": "…", "usage": "句子的用法？"}';
  assert.equal(partialOf(raw, "sentence", SEL).usage, null);
  assert.equal(partialOf(raw, "phrase", SEL).usage, "句子的用法？");
});

test("译文里出现 \"vocab\": 不会把顶层字段截掉", () => {
  // 合法 JSON 的字符串里引号必须转义，写到这个词时长成 \"vocab\":，
  // `b` 后面跟的是反斜杠，匹配不上——这条不变量是那个粗暴正则的全部依据
  const raw = String.raw`{"translation": "the \"vocab\": list", "pos": "noun", "context_note": "x"`;
  const p = partialOf(raw, "phrase", SEL);
  assert.equal(p.contextNote, "x");
  assert.equal(p.pos, "noun");
  assert.equal(topLevelSlice(raw), raw, "整段都还是顶层");
});

test("流式解析同样只留选中文本里的词", () => {
  // 用户只选了 every abstraction，leak 是这一段别处的词
  const raw = `${HEAD + V1}, ${V2}]}`;
  assert.deepEqual(
    closedVocab(raw, "every abstraction").map((v) => v.word),
    ["abstraction"],
    "逐条推送时就该挡掉，不能等到最终校正",
  );
  assert.deepEqual(
    partialOf(raw, "sentence", "every abstraction").vocab.map((v) => v.word),
    ["abstraction"],
  );
});

test("模型在 JSON 之前照抄字段名也不受影响", () => {
  const chatty =
    '好的，我会给出 "vocab": 这个字段。\n' +
    '{"translation": "泄漏", "context_note": "y", "vocab": [{"word": "a", "meaning": "b"}]}';
  const p = partialOf(chatty, "sentence", SEL);
  assert.equal(p.contextNote, "y", "取最后一次出现，绕开前面那句废话里的假键");
  assert.equal(p.vocab.length, 1);
});
