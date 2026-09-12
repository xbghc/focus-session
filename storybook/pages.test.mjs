import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { compilePages } from '../.storybook/pages-plugin.mjs';

const pages = await compilePages();
const scenarios = [
  ['popup', 'populated', 'current', '正在计时'],
  ['popup', 'empty', 'history', '还没有'],
  ['popup', 'error', 'current', '文章判断失败'],
  ['popup', 'populated', 'overview', '专注'],
  ['dashboard', 'populated', 'articles', '共 3 篇'],
  ['dashboard', 'empty', 'articles', '还没有阅读记录'],
  ['dashboard', 'populated', 'words', 'consolidate'],
  ['dashboard', 'populated', 'review', '显示答案'],
  ['dashboard', 'populated', 'articleReview', 'Understanding the browser event loop'],
  ['dashboard', 'populated', 'classification', 'LLM：非文章'],
  ['dashboard', 'error', 'classification', '判别失败'],
  ['app', 'populated', 'classification', 'LLM：非文章'],
  ['options', 'populated', 'articles', '文章记录黑名单'],
  ['sidepanel', 'populated', 'articles', 'consolidate'],
  ['app', 'populated', 'articles', '共 3 篇'],
  ['appOptions', 'populated', 'articles', '返回'],
  ['reader', 'populated', 'articles', 'Attention is a practice'],
  ['reader', 'loading', 'articles', 'LLM 正在判断'],
  ['reader', 'empty', 'articles', '抓不到这一页'],
];
for (const [page, state, tab, expected] of scenarios) test(`${page}: ${state} / ${tab}`, async () => {
  const html = pages[page].replace('<!--PREVIEW_CONFIG-->', `<script>window.__PREVIEW__=${JSON.stringify({ page, state, tab })}</script>`);
  let closeWindow;
  const dom = new JSDOM(html, {
    url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      closeWindow = window.close.bind(window);
      window.structuredClone = structuredClone;
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.scrollTo = () => {};
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    },
  });
  try {
    await new Promise(resolve => setTimeout(resolve, tab === 'classification' ? 450 : 100));
    assert.deepEqual(Array.from(dom.window.__previewErrors), []);
    dom.window.document.querySelectorAll("script").forEach(script => script.remove());
    assert.ok(dom.window.document.body.textContent.includes(expected), `missing ${expected}: ${dom.window.document.body.textContent.slice(0, 1200)}`);
    assert.equal(dom.window.localStorage.getItem('fs:update:auto'), 'off');
  } finally { closeWindow(); }
});

test('page bundles inline their assets and replace only the App platform boot', () => {
  assert.equal(Object.keys(pages).length, 7);
  for (const html of Object.values(pages)) {
    assert.ok(html.includes('connect-src'));
    assert.equal(/<script[^>]+src=/.test(html), false);
    assert.equal(/<link[^>]+rel="stylesheet"/.test(html), false);
    assert.ok(html.includes('data:font/woff2;base64,'));
  }
});
