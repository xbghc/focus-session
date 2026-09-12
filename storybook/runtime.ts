import { handle } from '../src/background/handle.ts';
import { installChromeShim, memoryBackend } from '../src/app/shim.ts';
import { ARTICLE_URL, fixtures } from './fixtures.ts';
import type { AnyMessage, PageState } from '../src/types.ts';

declare global { interface Window { __PREVIEW__: { state: string; tab: string; page: string }; __previewErrors: string[] } }
const options = window.__PREVIEW__;
const seed = fixtures(options.state === 'empty');
const storage = memoryBackend();
void storage.set(seed.data);
window.__previewErrors = [];
window.addEventListener('error', event => window.__previewErrors.push(event.message));
window.addEventListener('unhandledrejection', event => window.__previewErrors.push(String(event.reason)));
// All persisted data belongs to this frame, including the App update preferences.
const preferences = new Map<string, string>([['fs:update:auto', 'off']]);
Object.defineProperty(window, 'localStorage', { value: {
  getItem: (key: string) => preferences.get(key) ?? null,
  setItem: (key: string, value: string) => preferences.set(key, value), removeItem: (key: string) => preferences.delete(key),
  clear: () => preferences.clear(), key: (index: number) => [...preferences.keys()][index] ?? null,
  get length() { return preferences.size; },
} });
window.fetch = async () => { throw new Error('Storybook 使用本地模拟数据，不发送网络请求'); };
window.open = () => null;
window.close = () => undefined;
document.addEventListener('click', event => {
  const target = event.target as Element;
  if (target?.closest?.('a[href]')) event.preventDefault();
  if (target?.closest?.('#refetch')) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
document.addEventListener('submit', event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);

export const shim = installChromeShim({
  storage, version: '0.3.5', navigate: url => console.info('[Storybook navigation]', url),
  async handle(raw, sender) {
    const msg = raw as AnyMessage;
    switch (msg.type) {
      case 'article:classify-history':
        if (options.state === 'loading') return new Promise(() => {});
        await new Promise(resolve => setTimeout(resolve, 200));
        if (options.state === 'error' || msg.articleId.endsWith('article-2')) return { ok: false, reason: '正文抓取失败（HTTP 403），请打开原文后重试' };
        return { ok: true, isArticle: msg.articleId !== ARTICLE_URL, source: 'saved',
          reason: msg.articleId === ARTICLE_URL ? '这是目录和推荐链接集合，不是独立文章。（模拟结果）' : '正文围绕同一主题展开说明，是独立文章。（模拟结果）' };
      case 'article:classify':
        if (options.state === 'loading') return new Promise(() => {});
        return options.state === 'error' ? { ok: false, reason: '文章判断失败：模型响应超时，请刷新重试' }
          : { ok: true, isArticle: options.state !== 'nonArticle', reason: '这是一篇完整文章' };
      case 'articles:blacklist-suggest': return options.state === 'error' ? { ok: false, error: '模型响应超时（模拟）' }
        : { ok: true, suggestions: [{ pattern: msg.articleIds[0] || ARTICLE_URL, reason: '模拟建议：排除所选页面的具体路径。请核对该路径是否包含仍需记录的文章。' }] };
      case 'llm:test': return options.state === 'error' ? { ok: false, error: '连接超时（模拟）' } : { ok: true, model: 'storybook-preview' };
      case 'llm:get': return { ...seed.data.llm, apiKeySet: options.state !== 'empty' };
      case 'article:review': return { ok: true, review: seed.data[`r:${seed.articles[1]!.id}` as keyof typeof seed.data] };
      case 'review:assist': return { ok: true, text: '可以把 consolidate 和“把零散知识放在一起”联系起来。' };
      case 'page:capture': return { ok: false, error: '截图需要真实浏览器扩展或安卓宿主；此处只预览界面。' };
      default: return handle(msg, sender);
    }
  },
  connect(_name, port) {
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as { type: string };
      if (msg.type === 'ask') port.postMessage({ type: 'ask-done', res: { ok: true, text: '这里强调阅读后的主动回想。' } });
      else port.postMessage({ type: 'done', res: { ok: true, cached: true, snippet: seed.snippets[0]! } });
    });
  },
});
let pageState: PageState = options.state === 'nonArticle' || options.state === 'empty'
  ? { tracked: false, reason: '未识别为文章页', translateHere: 'available', screenshot: 'available' }
  : options.state === 'error' ? { tracked: false, reason: '文章判断失败：模型响应超时', translateHere: 'available', screenshot: 'available' }
  : options.state === 'loading' ? { tracked: false, reason: 'LLM 正在判断是否为文章…', translateHere: 'available', screenshot: 'available' }
  : { tracked: true, articleId: ARTICLE_URL, title: seed.articles[0]!.title,
      totalWords: 1500, trackedWords: 1400, wordsRead: 560, paragraphCount: 18, readParagraphCount: 7, activeSince: Date.now() - 125_000,
      screenshot: 'available' };
Object.assign(chrome.tabs, {
  query: async () => [{ id: 1, windowId: 1, active: true, url: ARTICLE_URL, title: seed.articles[0]!.title }],
  sendMessage: async (_id: number, msg: { type: string }) => {
    if (msg.type === 'page:translate-here') pageState = { ...pageState, translateHere: 'on' };
    return pageState;
  },
});
Object.assign(chrome.sidePanel, { open: async () => undefined });
// Reader error/empty stories exercise the actual fetch error UI; the normal story uses its cache.
if (options.page === 'reader' && options.state === 'empty') void storage.remove(`rh:${ARTICLE_URL}`);
window.addEventListener('DOMContentLoaded', () => {
  const tab = options.tab === 'articleReview' ? 'review' : options.tab;
  document.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)?.click();
  if (options.tab === 'classification') {
    setTimeout(() => {
      document.querySelector<HTMLButtonElement>('#manage-articles')?.click();
      document.querySelector<HTMLInputElement>('#select-articles')?.click();
      document.querySelector<HTMLButtonElement>('#classify-articles')?.click();
    }, 50);
  }
  if (options.tab === 'articleReview') document.querySelector<HTMLButtonElement>('[data-queue="articles"]')?.click();
});
