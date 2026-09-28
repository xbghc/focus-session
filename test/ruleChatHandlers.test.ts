import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { memoryBackend } from "../src/app/shim.ts";
import { DEFAULT_LLM, DEFAULT_SETTINGS, type LlmFailure, type Settings } from "../src/types.ts";
import { ruleChatHandlers } from "../src/core/background/ruleChat.ts";
import { READING_URL_LISTS } from "../src/features/reading/settings.ts";
import { TRANSLATION_URL_LISTS } from "../src/features/translation/settings.ts";
import { allowTranslationSite, getSettings } from "../src/background/store.ts";
import { bookkeepingSettled, getLlmLog } from "../src/background/llmLog.ts";

/*
 * 名单对话的后台：一句话只换来改动清单，不写；确认时在最新的名单上重新核一遍再写，别的设置不碰。
 */

const h = ruleChatHandlers([...READING_URL_LISTS, ...TRANSLATION_URL_LISTS]);
const chat = (turns: Array<{ role: "user" | "assistant"; text: string }>, pageUrl?: string) =>
  h["rules:chat"]({ type: "rules:chat", turns, ...(pageUrl ? { pageUrl } : {}) });
const apply = (changes: unknown[]) => h["rules:apply"]({ type: "rules:apply", changes: changes as never });

let local = memoryBackend();
let answer: unknown;
let status = 200;
let requests: Array<{ system: string; user: string }> = [];
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  local = memoryBackend();
  (globalThis as Record<string, unknown>).chrome = { storage: { local } };
  requests = [];
  status = 200;
  await local.set({
    settings: { ...DEFAULT_SETTINGS, articleExcludedUrls: ["zhihu.com"], translationAllowedUrls: ["nytimes.com"], finishRatio: 0.7 },
    llm: { ...DEFAULT_LLM, apiKey: "test-only" },
    articles: {
      a: { id: "a", url: "https://www.weibo.com/1" },
      b: { id: "b", url: "https://weibo.com/2" },
      c: { id: "c", url: "https://github.com/x" },
    },
  });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ system: body.system, user: body.messages[0].content });
    if (status !== 200) return new Response('{"error":{"message":"boom"}}', { status });
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" }));
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });

test("说一句只换来改动清单，不写；加的每条带上命中了几篇已有记录", async () => {
  answer = {
    reply: "把微博加进文章记录黑名单，GitHub 加进翻译白名单。",
    changes: [
      { list: "articleExcludedUrls", op: "add", rule: "weibo.com", reason: "用户不想记微博" },
      { list: "translationAllowedUrls", op: "add", rule: "github.com", reason: "用户要在 GitHub 上翻译" },
    ],
  };
  const res = await chat([{ role: "user", text: "微博别记了，GitHub 上开翻译" }], "https://github.com/x");
  assert.ok(res.ok);
  assert.deepEqual(res.changes.map((c) => [c.list, c.rule, c.hits]), [["articleExcludedUrls", "weibo.com", 2], ["translationAllowedUrls", "github.com", 1]]);
  assert.deepEqual((await getSettings()).articleExcludedUrls, ["zhihu.com"], "还没确认，名单不动");
  const [req] = requests;
  assert.match(req!.system, /现在的内容：\{"articleExcludedUrls":\["zhihu\.com"\],"translationAllowedUrls":\["nytimes\.com"\]\}/);
  assert.match(req!.system, /用户正开着这一页：https:\/\/github\.com\/x/);
  assert.deepEqual(JSON.parse(req!.user), { history: [{ role: "user", text: "微博别记了，GitHub 上开翻译" }] });
});

test("确认：在最新的名单上重新核、重新套，别的设置不碰", async () => {
  // 清单出来之后、点确认之前，别处（「本站始终开启」）已经把 github.com 加进去了
  await allowTranslationSite("https://github.com/x");
  const res = await apply([
    { list: "articleExcludedUrls", label: "文章记录黑名单", op: "add", rule: "weibo.com", reason: "" },
    { list: "articleExcludedUrls", label: "文章记录黑名单", op: "remove", rule: "zhihu.com", reason: "" },
    { list: "translationAllowedUrls", label: "翻译白名单", op: "add", rule: "github.com", reason: "" },
  ]);
  assert.ok(res.ok);
  assert.deepEqual(res.applied.map((c) => `${c.op} ${c.rule}`), ["add weibo.com", "remove zhihu.com"]);
  assert.deepEqual(res.rejected, [{ rule: "github.com", why: "已经在翻译白名单里" }]);
  const s: Settings = await getSettings();
  assert.deepEqual(s.articleExcludedUrls, ["weibo.com"]);
  assert.deepEqual(s.translationAllowedUrls, ["nytimes.com", "github.com"]);
  assert.equal(s.finishRatio, 0.7);
});

test("确认时也不放过界面递来的坏规则", async () => {
  const res = await apply([
    { list: "articleExcludedUrls", label: "x", op: "add", rule: "co.uk", reason: "" },
    { list: "finishRatio", label: "x", op: "add", rule: "a.com", reason: "" },
  ]);
  assert.ok(res.ok);
  assert.deepEqual(res.applied, []);
  assert.equal(res.rejected.length, 2);
  assert.deepEqual((await getSettings()).articleExcludedUrls, ["zhihu.com"]);
});

test("模型调用失败：说清原因，现场进诊断日志；最后一句不是人说的就不去问", async () => {
  status = 500;
  const res = await chat([{ role: "user", text: "知乎别记了" }]);
  assert.equal(res.ok, false);
  assert.match(!res.ok ? res.error : "", /HTTP 500/);
  await bookkeepingSettled();
  const [f] = (await getLlmLog()) as LlmFailure[];
  assert.equal(f!.source, "ruleChat");
  assert.deepEqual(f!.request, { message: "知乎别记了", pageUrl: null });

  const before = requests.length;
  assert.deepEqual(await chat([{ role: "assistant", text: "你好" }]), { ok: false, error: "先说一句要怎么改" });
  assert.equal(requests.length, before);
});
