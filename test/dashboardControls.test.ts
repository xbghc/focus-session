import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

/*
 * 首页文章栏的搜索键、筛选键，和它们身上的埋点。
 * 一个文件只能装载一次首页脚本（模块有缓存），所以几件事串在同一个用例里按顺序走。
 */
test("搜索收成一个键、筛选一下就切，点过什么攒成一批交给后台", async () => {
  const dom = new JSDOM(readFileSync(new URL("../src/dashboard/dashboard.html", import.meta.url), "utf8"), { url: "https://extension.test/dashboard.html" });
  const g = globalThis as Record<string, unknown>;
  g["document"] = dom.window.document; g["window"] = dom.window; g["location"] = dom.window.location;
  const articles = [["essay", true], ["draft", false], ["notes", false]].map(([name, finished], index) => ({ id: name, url: `https://example.com/${name}`, title: name,
    finished, trackedWords: 100, totalWords: 100, wordsRead: 0, totalMs: 0, sessionCount: 0, lastSeenTs: index + 1 }));
  const batches: string[][] = [];
  g["chrome"] = { storage: { local: { get: async () => ({}) } }, runtime: { sendMessage: async (msg: { type: string; events?: string[] }) => {
    if (msg.type === "ui:track") { batches.push(msg.events!); return { ok: true }; }
    if (msg.type === "articles:list") return { articles, speed: null };
    if (msg.type === "review:stats") return { dueNow: 0 };
    if (msg.type === "article:review-due") return { items: [], stats: { dueNow: 0 } };
    return {};
  } } };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const doc = dom.window.document;
  await import("../src/dashboard/index.ts");
  await tick();

  const box = doc.getElementById("search-box")!;
  const toggle = doc.getElementById("search-toggle") as HTMLButtonElement;
  const input = doc.getElementById("q-article") as HTMLInputElement;
  const summary = doc.getElementById("article-summary")!;
  const titles = () => [...doc.querySelectorAll("#articles .article-card .title")].map(n => n.textContent);
  const type = (value: string) => { input.value = value; input.dispatchEvent(new dom.window.Event("input")); };
  const pressed = () => [...doc.querySelectorAll("#finish-filter button")].map(b => b.getAttribute("aria-pressed"));
  const filter = (value: string) => (doc.querySelector(`#finish-filter button[data-filter="${value}"]`) as HTMLButtonElement).click();

  // 起手：搜索收着，框进不去；筛选停在「全部」
  assert.equal(box.classList.contains("open"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(input.hasAttribute("inert"), true);
  assert.deepEqual(pressed(), ["true", "false", "false"]);
  assert.deepEqual(titles(), ["essay", "draft", "notes"]);
  assert.equal(summary.textContent, "共 3 篇，读完 1 篇");

  // 点开：框展开并拿到焦点
  toggle.click();
  assert.equal(box.classList.contains("open"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.getAttribute("aria-label"), "收起搜索");
  assert.equal(input.hasAttribute("inert"), false);
  assert.equal(doc.activeElement, input);
  type("dr"); type("dra");
  assert.deepEqual(titles(), ["draft"]);
  assert.equal(summary.textContent, "共 3 篇，读完 1 篇 · 显示 1 篇");

  // 有词的时候走开，框留着——收起来的话筛选还在生效却看不见
  box.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  assert.equal(box.classList.contains("open"), true);

  // Esc：清词、收起、焦点还给搜索键
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(box.classList.contains("open"), false);
  assert.equal(input.value, "");
  assert.equal(doc.activeElement, toggle);
  assert.deepEqual(titles(), ["essay", "draft", "notes"]);

  // 开着再点一下键：收起并清词
  toggle.click(); type("notes"); toggle.click();
  assert.equal(box.classList.contains("open"), false);
  assert.equal(input.value, "");
  assert.deepEqual(titles(), ["essay", "draft", "notes"]);

  // 空着走开自己收；焦点是落到搜索键上的不收（那一下归键自己的 click 管，否则会收了又开）
  toggle.click();
  box.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true, relatedTarget: toggle }));
  assert.equal(box.classList.contains("open"), true);
  box.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  assert.equal(box.classList.contains("open"), false);

  // 框收着却有词（浏览器后退时填回来的）：一重画就把框打开，不留看不见的筛选
  type("essay");
  assert.equal(box.classList.contains("open"), true);
  toggle.click();

  // 筛选：一下就切，按下的那个键记在 aria-pressed 上
  filter("reading");
  assert.deepEqual(pressed(), ["false", "true", "false"]);
  assert.deepEqual(titles(), ["draft", "notes"]);
  assert.equal(summary.textContent, "共 3 篇，读完 1 篇 · 显示 2 篇");
  filter("done");
  assert.deepEqual(titles(), ["essay"]);
  // 和搜索叠着用
  toggle.click(); type("draft");
  assert.deepEqual(titles(), []);
  assert.equal(doc.querySelector("#articles .empty")!.textContent, "没有匹配的文章");
  toggle.click();
  filter("");
  assert.deepEqual(titles(), ["essay", "draft", "notes"]);

  // 卡片上的键：展开详情记一次，收起不记；批量管理只记进去那一下
  const detail = () => doc.querySelector("#articles .article-card .detail-toggle") as HTMLButtonElement;
  detail().click(); await tick();
  detail().click();
  const manage = doc.getElementById("manage-articles") as HTMLButtonElement;
  manage.click(); manage.click();
  // 中键开原文也算打开；右键不算
  const link = () => doc.querySelector("#articles .article-card .title a") as HTMLAnchorElement;
  link().dispatchEvent(new dom.window.MouseEvent("auxclick", { bubbles: true, button: 1 }));
  link().dispatchEvent(new dom.window.MouseEvent("auxclick", { bubbles: true, button: 2 }));

  // 没到点不发；页面要走了，手里的一次交掉
  assert.deepEqual(batches, []);
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  assert.deepEqual(batches, [[
    "page.open",
    "articles.search.open", "articles.search.query", // 敲了两下键，只算搜了一次
    "articles.search.open", "articles.search.query",
    "articles.search.open", // 空着走开的那次：展开了，没搜
    "articles.search.query", // 框是被词顶开的，没人点键，所以只有这一条
    "articles.filter.reading", "articles.filter.done",
    "articles.search.open", "articles.search.query",
    "articles.filter.all",
    "articles.detail",
    "articles.manage",
    "articles.open",
  ]]);
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  assert.equal(batches.length, 1, "手里没东西不发");
  dom.window.close();
});

test("安卓首页有同一套搜索键和筛选键", () => {
  const dom = new JSDOM(readFileSync(new URL("../src/app/index.html", import.meta.url), "utf8"));
  const doc = dom.window.document;
  for (const id of ["search-box", "search-toggle", "q-article", "finish-filter", "article-summary"]) assert.ok(doc.getElementById(id), id);
  assert.deepEqual([...doc.querySelectorAll("#finish-filter button")].map(b => b.getAttribute("data-filter")), ["", "reading", "done"]);
  dom.window.close();
});
