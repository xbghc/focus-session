import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from '../src/app/shim.ts';
import { DEFAULT_LLM, DEFAULT_SETTINGS } from '../src/types.ts';
import { classifyHistoryArticle } from '../src/background/articleFilter.ts';

const id = 'https://example.com/article';
let area = memoryBackend();
let websiteCalls = 0;
let llmCalls = 0;
let decision: unknown;
let webpageStatus = 200;
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  area = memoryBackend(); websiteCalls = 0; llmCalls = 0; webpageStatus = 200;
  decision = { isArticle: false, reason: '目录页面' };
  (globalThis as Record<string, unknown>).chrome = { storage: { local: area } };
  await area.set({ articles: { [id]: { id, url: id, title: '示例' } }, settings: { ...DEFAULT_SETTINGS, articleExcludedUrls: ['example.com'] }, llm: { ...DEFAULT_LLM, apiKey: 'test-only' } });
  globalThis.fetch = async (input) => {
    if (String(input).startsWith('https://example.com')) {
      websiteCalls++;
      return new Response('<html><body><h1>目录</h1><a href="/a">文章一</a></body></html>', { status: webpageStatus, headers: { 'content-type': 'text/html' } });
    }
    llmCalls++;
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(decision) }], usage: { input_tokens: 50, output_tokens: 20 }, stop_reason: 'end_turn' }), { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });

test('优先存档正文；历史复查不会把黑名单当作 LLM 结论', async () => {
  await area.set({ [`t:${id}`]: { text: '完整的文章正文' } });
  decision = { isArticle: true, reason: '独立论述' };
  assert.deepEqual(await classifyHistoryArticle(id), { ok: true, isArticle: true, reason: '独立论述', source: 'saved' });
  assert.equal(websiteCalls, 0); assert.equal(llmCalls, 1);
});

test('没有正文时抓取原网址再调用模型', async () => {
  assert.deepEqual(await classifyHistoryArticle(id), { ok: true, isArticle: false, reason: '目录页面', source: 'fetched' });
  assert.equal(websiteCalls, 1); assert.equal(llmCalls, 1);
});

test('抓取失败不会进入非文章结果，也不调用模型猜测', async () => {
  webpageStatus = 403;
  const result = await classifyHistoryArticle(id);
  assert.equal(result.ok, false); assert.match(result.reason, /403/); assert.equal(llmCalls, 0);
});

test('登录验证页面和不合法模型输出都是失败', async () => {
  for (const raw of [{ unavailable: true }, { isArticle: 'false', reason: '错误格式' }]) {
    decision = raw;
    assert.equal((await classifyHistoryArticle(id)).ok, false);
  }
});

test('已删除记录不抓取、不调用模型', async () => {
  assert.equal((await classifyHistoryArticle('missing')).ok, false);
  assert.equal(websiteCalls, 0); assert.equal(llmCalls, 0);
});
