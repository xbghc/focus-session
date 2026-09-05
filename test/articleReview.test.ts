import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REVIEW_CHARS,
  REVIEW_MAX_TOKENS,
  buildReviewPrompt,
  clipText,
  generateArticleReview,
  normalizeArticleReview,
  toList,
} from "../src/lib/articleReview.ts";
import { LlmError } from "../src/lib/llm.ts";
import type { LlmConfig } from "../src/types.ts";
import { DEFAULT_LLM } from "../src/types.ts";

const CFG: LlmConfig = { ...DEFAULT_LLM, apiKey: "k", timeoutMs: 1_000 };
const FENCE = "```";

function okResponse(text: string, stopReason = "end_turn"): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text }],
      usage: { input_tokens: 4_000, output_tokens: 420 },
      stop_reason: stopReason,
    }),
    { status: 200 },
  );
}

const GOOD = JSON.stringify({
  outline: ["提出抽象总会泄漏", "用 ORM 的 N+1 查询举例", "推出：抽象要选，不能全信"],
  questions: ["作者说的代价具体指什么？", "文中举了哪两个例子？", "结论对写代码的人意味着什么？"],
});

/* ---------- 截断 ---------- */

test("正文没超限就原样送出", () => {
  assert.equal(clipText("短文", 100), "短文");
});

test("超限时优先断在段落边界", () => {
  const text = "第一段".padEnd(70, "a") + "\n\n" + "第二段".padEnd(70, "b");
  const cut = clipText(text, 100);
  assert.ok(cut.length <= 100);
  assert.ok(!cut.includes("第二段"), "应当在段落边界前收住");
  assert.ok(!cut.endsWith("\n"), "边界处的空行要一起去掉");
});

test("段落边界太靠前时宁可硬截，不能只留一小半", () => {
  const text = "开头\n\n" + "x".repeat(500);
  const cut = clipText(text, 100);
  assert.equal(cut.length, 100);
});

test("默认上限是 30K 字符", () => {
  assert.equal(MAX_REVIEW_CHARS, 30_000);
  assert.equal(clipText("x".repeat(40_000)).length, 30_000);
});

/* ---------- prompt ---------- */

test("完整正文的 prompt 不提截断", () => {
  const p = buildReviewPrompt({ title: "T", url: "https://a.com/x", text: "正文", fullChars: 2 });
  assert.match(p, /标题：T/);
  assert.match(p, /https:\/\/a\.com\/x/);
  assert.ok(!p.includes("截掉"), "没截断就不该提截断，凭空的免责声明会干扰输出");
});

test("被截断时告诉模型这是前百分之几，免得它把截断处当结尾", () => {
  const p = buildReviewPrompt({ title: "T", url: "u", text: "x".repeat(300), fullChars: 1_000 });
  assert.match(p, /前 30%/);
  assert.match(p, /不要编造结尾/);
});

test("无标题也能拼出 prompt", () => {
  assert.match(buildReviewPrompt({ title: "", url: "u", text: "t", fullChars: 1 }), /\(无标题\)/);
});

/* ---------- 宽容解析 ---------- */

test("数组原样收下，超量截断", () => {
  assert.deepEqual(toList(["a", "b"], 8), ["a", "b"]);
  assert.deepEqual(toList(["a", "b", "c"], 2), ["a", "b"]);
});

test("模型把数组写成一整段带编号的文本时按行救回来", () => {
  assert.deepEqual(toList("1. 第一点\n2. 第二点\n3. 第三点", 8), ["第一点", "第二点", "第三点"]);
  assert.deepEqual(toList("- 甲\n* 乙\n· 丙", 8), ["甲", "乙", "丙"]);
  assert.deepEqual(toList("（1）甲\n(2) 乙", 8), ["甲", "乙"]);
});

test("空行和空白项被丢掉", () => {
  assert.deepEqual(toList("甲\n\n   \n乙", 8), ["甲", "乙"]);
  assert.deepEqual(toList(null, 8), []);
  assert.deepEqual(toList(42, 8), []);
});

test("没有 outline 就算失败——大纲是这份材料的本体", () => {
  assert.throws(
    () => normalizeArticleReview({ questions: ["q"] }),
    (e: unknown) => e instanceof LlmError && e.kind === "parse",
  );
});

test("只有 outline 没有 questions 仍然可用", () => {
  const r = normalizeArticleReview({ outline: ["一", "二"] });
  assert.deepEqual(r.outline, ["一", "二"]);
  assert.deepEqual(r.questions, []);
});

/* ---------- 生成 ---------- */

test("生成成功时带回材料和用量", async () => {
  const { review, usage } = await generateArticleReview(
    { title: "T", url: "u", text: "正文", fullChars: 2 },
    CFG,
    1_700_000_000_000,
    { fetch: (async () => okResponse(GOOD)) as unknown as typeof fetch },
  );
  assert.equal(review.outline.length, 3);
  assert.equal(review.questions.length, 3);
  assert.equal(review.generatedTs, 1_700_000_000_000);
  assert.equal(review.model, DEFAULT_LLM.model);
  assert.deepEqual(usage, { inputTokens: 4_000, outputTokens: 420 });
});

test("包了 markdown 围栏也能救回来", async () => {
  const { review } = await generateArticleReview({ title: "T", url: "u", text: "t", fullChars: 1 }, CFG, 0, {
    fetch: (async () => okResponse(`${FENCE}json\n${GOOD}\n${FENCE}`)) as unknown as typeof fetch,
  });
  assert.equal(review.outline.length, 3);
});

const bodyOf = async (cfg: LlmConfig): Promise<Record<string, unknown>> => {
  let body: Record<string, unknown> = {};
  await generateArticleReview({ title: "T", url: "u", text: "t", fullChars: 1 }, cfg, 0, {
    fetch: (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return okResponse(GOOD);
    }) as unknown as typeof fetch,
  });
  return body;
};

test("配置低于回顾材料的下限时抬到下限", async () => {
  const body = await bodyOf({ ...CFG, maxTokens: 512 });
  assert.equal(body["max_tokens"], REVIEW_MAX_TOKENS);
});

test("用户把额度调得更大时按用户的来，不被收回去", async () => {
  const body = await bodyOf({ ...CFG, maxTokens: REVIEW_MAX_TOKENS * 4 });
  assert.equal(body["max_tokens"], REVIEW_MAX_TOKENS * 4, "下限不该当成封顶用");
});

test("默认配置已经高于回顾材料的下限", async () => {
  const body = await bodyOf(CFG);
  assert.equal(body["max_tokens"], DEFAULT_LLM.maxTokens);
  assert.ok(DEFAULT_LLM.maxTokens > REVIEW_MAX_TOKENS);
});

test("输出被截断时给出可操作的提示", async () => {
  await assert.rejects(
    () =>
      generateArticleReview({ title: "T", url: "u", text: "t", fullChars: 1 }, CFG, 0, {
        fetch: (async () => okResponse(`{"outline": ["一`, "max_tokens")) as unknown as typeof fetch,
      }),
    (e: unknown) => e instanceof LlmError && e.kind === "parse" && /max_tokens/.test(e.message),
  );
});

test("缺 API key 报 config，让界面能引导去设置页", async () => {
  await assert.rejects(
    () =>
      generateArticleReview({ title: "T", url: "u", text: "t", fullChars: 1 }, { ...CFG, apiKey: "" }, 0, {
        fetch: (() => Promise.reject(new Error("不该走到这"))) as unknown as typeof fetch,
      }),
    (e: unknown) => e instanceof LlmError && e.kind === "config",
  );
});
