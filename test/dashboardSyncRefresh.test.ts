import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

test("首页开着的时候，另一台设备刚读的文章自己冒到最上面；没变就不重画", async () => {
  const dom = new JSDOM(readFileSync(new URL("../src/dashboard/dashboard.html", import.meta.url), "utf8"), { url: "https://extension.test/dashboard.html", pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  g["document"] = dom.window.document; g["window"] = dom.window; g["location"] = dom.window.location;
  const article = (name: string, lastSeenTs: number, extra: Record<string, unknown> = {}) => ({ id: `https://example.com/${name}`, url: `https://example.com/${name}`, title: name,
    finished: false, trackedWords: 100, totalWords: 100, wordsRead: 0, totalMs: 0, sessionCount: 0, lastSeenTs, ...extra });
  let articles = [article("on-the-computer", 1_000)];
  let updatedTs = 1;
  let lists = 0;
  const listeners: Array<(msg: unknown) => unknown> = [];
  g["chrome"] = { storage: { local: { get: async () => ({}) } }, runtime: {
    onMessage: { addListener: (fn: (msg: unknown) => unknown) => void listeners.push(fn) },
    sendMessage: async (msg: { type: string }) => {
      // 速度摘要的 updatedTs 每次落库都在变，不能因为它就重画
      if (msg.type === "articles:list") { lists++; return { articles: [...articles].sort((a, b) => b.lastSeenTs - a.lastSeenTs), speed: { sessions: 3, windowDays: 30, updatedTs: updatedTs++ } }; }
      if (msg.type === "review:stats") return { dueNow: 0 };
      if (msg.type === "article:review-due") return { items: [], stats: { dueNow: 0 } };
      return {};
    } } };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const doc = dom.window.document;
  const titles = () => [...doc.querySelectorAll("#articles .article-card .title a")].map(a => a.textContent);
  const broadcast = () => listeners.map(fn => fn({ type: "sync:updated" }));
  await import("../src/dashboard/index.ts");
  await tick();
  assert.deepEqual(titles(), ["on-the-computer"]);
  assert.equal(listeners.length, 1);

  // 后台同步拉到了手机上刚读的那篇
  articles.push(article("on-the-phone", 2_000, { sessionCount: 1, wordsRead: 40 }));
  assert.deepEqual(broadcast(), [false], "共用的消息总线上不应答");
  await tick();
  assert.deepEqual(titles(), ["on-the-phone", "on-the-computer"]);

  // 拉到的东西和文章无关（复习卡、设置）：列表一个节点都不换，正选着的字、正要点的键不受打扰
  const first = doc.querySelector("#articles .article-card");
  broadcast(); await tick();
  assert.equal(doc.querySelector("#articles .article-card"), first);

  // 这一页重新回到眼前：再取一次（取列表会催后台同步一轮）
  const before = lists;
  doc.dispatchEvent(new dom.window.Event("visibilitychange"));
  await tick();
  assert.equal(lists, before + 1);
  assert.equal(doc.querySelector("#articles .article-card"), first);

  // 别的设备上标了读完：看得见的变化照常重画
  articles = articles.map(a => a.title === "on-the-phone" ? { ...a, finished: true } : a);
  broadcast(); await tick();
  assert.equal(doc.querySelector("#articles .article-card .pill")!.textContent, "读完");

  // 正在复习：不在文章这一栏就不取，翻到一半的卡不能被换掉
  (doc.querySelector('.tab[data-tab="review"]') as HTMLButtonElement).click(); await tick();
  const idle = lists;
  broadcast(); await tick();
  assert.equal(lists, idle);

  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  dom.window.close();
});
