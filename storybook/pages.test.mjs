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
  ['options', 'error', 'articles', '1 篇阅读材料（连同名下共 2 项记录）没通过校验，留在本机没有上传'],
  ['appOptions', 'error', 'articles', '1 篇阅读材料（连同名下共 2 项记录）没通过校验，留在本机没有上传'],
  ['sidepanel', 'populated', 'articles', 'consolidate'],
  ['app', 'populated', 'articles', '共 3 篇'],
  ['app', 'populated', 'articles', '深度阅读的技艺'],
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

test('sync settings keep secrets out of status, require a new token for a new address, and preserve local records on disconnect', async () => {
  const html = pages.options.replace('<!--PREVIEW_CONFIG-->', '<script>window.__PREVIEW__={page:"options",state:"populated",tab:"articles"}</script>');
  let closeWindow;
  const dom = new JSDOM(html, {
    url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      closeWindow = window.close.bind(window);
      window.structuredClone = structuredClone;
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    },
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  try {
    await settle();
    const { document, chrome } = dom.window;
    const token = document.getElementById('sync-token');
    assert.equal(token.value, '');
    assert.ok(document.getElementById('sync-summary').textContent.includes('同步已启用'));
    const before = await chrome.runtime.sendMessage({ type: 'data:export' });
    document.getElementById('sync-url').value = 'https://other.example.com';
    document.getElementById('sync-test').click();
    await settle();
    assert.ok(document.getElementById('sync-feedback').textContent.includes('重新填写 Token'));
    assert.equal((await chrome.runtime.sendMessage({ type: 'sync:get' })).baseUrl, 'https://sync.example.com');
    document.getElementById('sync-url').value = 'https://sync.example.com';
    token.value = 'preview-secret-never-rendered';
    document.getElementById('sync-save').click();
    await settle();
    assert.equal(token.value, '');
    assert.equal(document.getElementById('sync-summary').textContent.includes('preview-secret-never-rendered'), false);
    document.getElementById('sync-pause').click();
    await settle();
    assert.equal(document.getElementById('sync-run').disabled, true);
    document.getElementById('sync-disconnect').click();
    await settle();
    const status = await chrome.runtime.sendMessage({ type: 'sync:get' });
    assert.equal(status.tokenSet, false);
    assert.equal(status.enabled, false);
    const after = await chrome.runtime.sendMessage({ type: 'data:export' });
    assert.equal(after.articles.length, before.articles.length);
    assert.equal(after.snippets.length, before.snippets.length);
    assert.deepEqual(Array.from(dom.window.__previewErrors), []);
  } finally { closeWindow(); }
});

test('options form tracks unsaved changes, keeps blacklists on reset, and only the extension page gets a section index', async () => {
  const open = (page) => {
    const html = pages[page].replace('<!--PREVIEW_CONFIG-->', `<script>window.__PREVIEW__=${JSON.stringify({ page, state: 'populated', tab: 'articles' })}</script>`);
    let closeWindow;
    const dom = new JSDOM(html, {
      url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window) {
        closeWindow = window.close.bind(window);
        window.structuredClone = structuredClone;
        window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      },
    });
    return { dom, close: () => closeWindow() };
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));

  const app = open('appOptions');
  try {
    await settle();
    assert.equal(app.dom.window.document.querySelector('.section-nav'), null);
  } finally { app.close(); }

  const { dom, close } = open('options');
  try {
    await settle();
    const { document, chrome, Event } = dom.window;
    const type = (id, value) => { const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const bar = document.getElementById('savebar');
    const status = document.getElementById('status');
    const revert = document.getElementById('revert');

    const links = [...document.querySelectorAll('.section-nav a')];
    assert.equal(links.length, document.querySelectorAll('body > fieldset').length);
    assert.ok(links.every(link => document.getElementById(link.getAttribute('href').slice(1))?.tagName === 'FIELDSET'));
    assert.deepEqual([...document.querySelectorAll('.section-nav p')].map(p => p.textContent), ['连接', '偏好', '维护']);

    // 刚读进来的值不算修改；模型那组字段不归「保存」管，改了也不算
    assert.equal(bar.classList.contains('is-dirty'), false);
    assert.equal(revert.hidden, true);
    type('model', 'another-model');
    assert.equal(bar.classList.contains('is-dirty'), false);

    type('finishRatio', '85');
    type('excluded', 'https://example.com/search\nnews.example.com');
    assert.equal(bar.classList.contains('is-dirty'), true);
    assert.equal(status.textContent, '2 项修改尚未保存');
    assert.equal(revert.hidden, false);

    // 恢复默认只动开关和阈值，名单原样留着
    type('idle', '45');
    document.getElementById('reset').click();
    assert.equal(document.getElementById('idle').value, '30');
    assert.equal(document.getElementById('finishRatio').value, '80');
    assert.equal(document.getElementById('excluded').value, 'https://example.com/search\nnews.example.com');

    revert.click();
    assert.equal(bar.classList.contains('is-dirty'), false);
    assert.equal(document.getElementById('excluded').value.includes('news.example.com'), false);

    // stall 不大于 idle：不保存，错标在那一对框上，改了就消
    const saved = await chrome.runtime.sendMessage({ type: 'settings:get' });
    type('idle', '100'); type('stall', '90');
    document.getElementById('save').click();
    await settle();
    assert.deepEqual(await chrome.runtime.sendMessage({ type: 'settings:get' }), saved);
    assert.equal(document.getElementById('idle').getAttribute('aria-invalid'), 'true');
    assert.equal(document.getElementById('stall').validity.customError, true);
    assert.equal(status.classList.contains('error'), true);
    type('stall', '200');
    assert.equal(document.getElementById('idle').hasAttribute('aria-invalid'), false);
    assert.equal(document.getElementById('stall').validity.customError, false);

    document.getElementById('save').click();
    await settle();
    assert.equal((await chrome.runtime.sendMessage({ type: 'settings:get' })).stallTimeoutMs, 200_000);
    assert.equal(bar.classList.contains('is-dirty'), false);
    assert.deepEqual(Array.from(dom.window.__previewErrors), []);
  } finally { close(); }
});

test('sync section keeps its explanation behind the title button and its diagnostics behind a one-line verdict', async () => {
  const open = (page, state) => {
    const html = pages[page].replace('<!--PREVIEW_CONFIG-->', `<script>window.__PREVIEW__=${JSON.stringify({ page, state, tab: 'articles' })}</script>`);
    let closeWindow;
    const dom = new JSDOM(html, {
      url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window) {
        closeWindow = window.close.bind(window);
        window.structuredClone = structuredClone;
        window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      },
    });
    return { dom, close: () => closeWindow() };
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));

  const healthy = open('options', 'populated');
  try {
    await settle();
    const { document, KeyboardEvent } = healthy.dom.window;
    const info = document.querySelector('#sync-settings legend button.info');
    const about = document.getElementById('sync-about');
    // The button's glyph is not part of the section's name.
    assert.equal(document.querySelector('.section-nav a').textContent, '设备同步');
    assert.equal(about.hidden, true);
    info.click();
    assert.equal(about.hidden, false);
    assert.equal(info.getAttribute('aria-expanded'), 'true');
    about.querySelector('p').click();
    assert.equal(about.hidden, false);
    document.querySelector('h1').click();
    assert.equal(about.hidden, true);
    info.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(about.hidden, true);
    assert.equal(info.getAttribute('aria-expanded'), 'false');

    assert.equal(document.getElementById('sync-details').open, false);
    assert.match(document.getElementById('sync-summary').textContent, /^同步已启用 · 上次同步 /);
    assert.equal(document.getElementById('sync-dot').dataset.tone, 'ok');
    assert.deepEqual([...document.querySelectorAll('#sync-facts dt')].map(dt => dt.textContent), ['上次成功', '待上传', '账号', '服务器', '本设备']);
    // The answer to a button press stays beside the buttons, outside the collapsed panel.
    document.getElementById('sync-test').click();
    await settle();
    const feedback = document.getElementById('sync-feedback');
    assert.ok(feedback.textContent.includes('连接成功'));
    assert.equal(feedback.closest('details'), null);
    assert.deepEqual(Array.from(healthy.dom.window.__previewErrors), []);
  } finally { healthy.close(); }

  const failing = open('options', 'error');
  try {
    await settle();
    const { document } = failing.dom.window;
    assert.equal(document.getElementById('sync-summary').textContent, '同步已启用 · 服务器暂时不可达（模拟）');
    assert.equal(document.getElementById('sync-dot').dataset.tone, 'error');
    assert.deepEqual([...document.querySelectorAll('#sync-facts dt')].map(dt => dt.textContent).slice(0, 4), ['错误', '上次成功', '待上传', '无法上传']);
    assert.equal(document.querySelectorAll('#sync-facts li').length, 1);
    assert.ok(document.querySelector('#sync-facts li').textContent.startsWith('《旧文章》'));
  } finally { failing.close(); }

  const app = open('appOptions', 'populated');
  try {
    await settle();
    const { document } = app.dom.window;
    assert.equal(document.querySelector('button.info'), null);
    assert.equal(document.getElementById('sync-about').hidden, false);
    assert.equal(document.getElementById('sync-settings').closest('details').querySelector('summary strong').textContent, '设备同步');
  } finally { app.close(); }
});

test('an article card unfolds into its own focus sessions, looked-up words and sync standing, on the extension and in the App', async () => {
  for (const page of ['dashboard', 'app']) {
    const html = pages[page].replace('<!--PREVIEW_CONFIG-->', `<script>window.__PREVIEW__=${JSON.stringify({ page, state: 'populated', tab: 'articles' })}</script>`);
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
    const settle = () => new Promise(resolve => setTimeout(resolve, 60));
    try {
      await settle();
      const { document } = dom.window;
      const toggle = index => document.querySelectorAll('#articles .article-card')[index].querySelector('button[aria-expanded]');
      assert.equal(document.querySelector('.material-detail'), null, page);
      for (const index of [0, 1, 2]) { toggle(index).click(); await settle(); }
      const details = [...document.querySelectorAll('.material-detail')];
      assert.equal(details.length, 3, page);
      assert.deepEqual([...details[0].querySelectorAll('h4')].map(h => h.textContent.split(' · ')[0]), ['专注时段', '划词', '同步']);
      assert.ok(details[0].textContent.includes('consolidate'));
      assert.ok(details[0].querySelector('.sync-line').textContent.startsWith('已同步到服务器'));
      assert.ok(details[1].textContent.includes('这篇里还没有划过词'));
      assert.ok(details[1].querySelector('.sync-line').textContent.includes('1 个专注时段、12 个段落'));
      assert.ok(details[2].querySelector('.sync-reason').textContent.includes('trackedWords'));
      // Survives the list being redrawn, and folds back.
      const search = document.getElementById('q-article');
      search.value = ''; search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      assert.equal(document.querySelectorAll('.material-detail').length, 3, page);
      assert.equal(toggle(0).textContent, '收起');
      toggle(0).click();
      assert.equal(document.querySelectorAll('.material-detail').length, 2, page);
      assert.deepEqual(Array.from(dom.window.__previewErrors), []);
    } finally { closeWindow(); }
  }
});
