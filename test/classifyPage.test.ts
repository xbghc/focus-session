import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from '../src/app/shim.ts';
import { DEFAULT_LLM, DEFAULT_SETTINGS, type LlmFailure } from '../src/types.ts';
import { classifyPage, NETWORK_RETRY_MS, REFUSAL_TTL_MS, type FilterDeps } from '../src/features/reading/articleFilter.ts';
import { bookkeepingSettled, getLlmLog } from '../src/background/llmLog.ts';

/*
 * 打开页面时的文章判别：失败现场认得出是哪一页；断网隔几秒重发；内容审核拒掉的页一小时内不再去问。
 */

const URL_A = 'https://news.example.com/a';
const REFUSAL = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'input new_sensitive (1026)' }, request_id: 'x' });
const ARTICLE = JSON.stringify({ content: [{ type: 'text', text: '{"isArticle":true,"reason":"独立论述"}' }], usage: { input_tokens: 50, output_tokens: 20 }, stop_reason: 'end_turn' });

let local = memoryBackend();
let session = memoryBackend();
/** 每次调用模型时按顺序取一个回应；函数是抛出去的（断网）。 */
let replies: Array<() => Response> = [];
let calls = 0;
let clock = 1_000_000;
let waits: number[] = [];
const deps: FilterDeps = { wait: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock };
const offline = (): Response => { throw new TypeError('Failed to fetch'); };
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  local = memoryBackend(); session = memoryBackend(); calls = 0; waits = []; replies = [];
  (globalThis as Record<string, unknown>).chrome = { storage: { local, session } };
  await local.set({ settings: { ...DEFAULT_SETTINGS, articleExcludedUrls: [] }, llm: { ...DEFAULT_LLM, apiKey: 'test-only' } });
  globalThis.fetch = async () => {
    calls++;
    const next = replies.shift();
    if (!next) throw new Error('多调了一次模型');
    return next();
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });

async function failures(): Promise<LlmFailure[]> {
  await bookkeepingSettled();
  return getLlmLog();
}

test('内容审核拒掉：原因说人话，失败现场带网址和标题', async () => {
  replies = [() => new Response(REFUSAL, { status: 500 })];
  const got = await classifyPage(URL_A, '某新闻', '正文', deps);
  assert.deepEqual(got, { ok: false, reason: '模型服务商的内容审核拒绝了这段内容（input new_sensitive (1026)），这一页不记录' });
  assert.equal(calls, 1, '拒答不重发');
  const [f] = await failures();
  assert.equal(f!.kind, 'refused');
  assert.deepEqual(f!.request, { url: URL_A, title: '某新闻' });
});

test('拒掉的页一小时内再打开不再去问，过了一小时、换一页都照常问', async () => {
  replies = [() => new Response(REFUSAL, { status: 500 })];
  const first = await classifyPage(URL_A, '某新闻', '正文', deps);
  clock += REFUSAL_TTL_MS - 1;
  assert.deepEqual(await classifyPage(URL_A, '某新闻', '正文', deps), first);
  assert.equal(calls, 1);
  assert.equal((await failures()).length, 1, '也不在诊断日志里多占一格');

  replies = [() => new Response(ARTICLE)];
  assert.equal((await classifyPage('https://news.example.com/b', '另一篇', '正文', deps)).ok, true);
  clock += 1;
  replies = [() => new Response(ARTICLE)];
  assert.equal((await classifyPage(URL_A, '某新闻', '正文', deps)).ok, true);
  assert.equal(calls, 3);
});

test('别的失败不记住：普通的 HTTP 500 刷新就再问', async () => {
  replies = [() => new Response('{"error":{"message":"internal"}}', { status: 500 }), () => new Response(ARTICLE)];
  const got = await classifyPage(URL_A, '某新闻', '正文', deps);
  assert.equal(got.ok, false);
  assert.match(got.reason, /^文章判断失败：HTTP 500/);
  assert.equal((await classifyPage(URL_A, '某新闻', '正文', deps)).ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [], 'HTTP 错误不重发');
});

test('断网：隔几秒重发，成了的话之前那几次记成人没看见的失败', async () => {
  replies = [offline, offline, () => new Response(ARTICLE)];
  const got = await classifyPage(URL_A, '某新闻', '正文', deps);
  assert.deepEqual(got, { ok: true, isArticle: true, reason: '独立论述' });
  assert.deepEqual(waits, NETWORK_RETRY_MS);
  const log = await failures();
  assert.deepEqual(log.map((f) => [f.kind, f.recovered, f.request['retry']]), [['network', 'retry', undefined], ['network', 'retry', 1]]);
});

test('一直断网：重发两次后照实报错，三次失败都是人撞上的', async () => {
  replies = [offline, offline, offline];
  const got = await classifyPage(URL_A, '某新闻', '正文', deps);
  assert.equal(got.ok, false);
  assert.match(got.reason, /^文章判断失败：网络错误/);
  assert.equal(calls, 3);
  const log = await failures();
  assert.deepEqual(log.map((f) => [f.kind, f.recovered, f.request['retry']]), [['network', undefined, undefined], ['network', undefined, 1], ['network', undefined, 2]]);
  assert.equal(log[2]!.request['url'], URL_A);
});

test('没有 storage.session 也照常判别，只是记不住', async () => {
  (globalThis as Record<string, unknown>).chrome = { storage: { local } };
  replies = [() => new Response(REFUSAL, { status: 500 }), () => new Response(REFUSAL, { status: 500 })];
  assert.equal((await classifyPage(URL_A, '某新闻', '正文', deps)).ok, false);
  assert.equal((await classifyPage(URL_A, '某新闻', '正文', deps)).ok, false);
  assert.equal(calls, 2);
});
