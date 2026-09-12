import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { DEFAULT_SETTINGS } from "../src/types.ts";

test("历史页选择筛选结果、建议经勾选采用、批量删除仅发送选中 ID", async () => {
  const dom = new JSDOM(readFileSync(new URL("../src/dashboard/dashboard.html", import.meta.url), "utf8"), { url: "https://extension.test/dashboard.html" });
  const g = globalThis as Record<string, unknown>;
  g["document"] = dom.window.document; g["window"] = dom.window; g["location"] = dom.window.location;
  g["confirm"] = () => true;
  let articles = ["search", "essay", "locked"].map((name, index) => ({ id: name, url: `https://example.com/${name}`, title: name,
    finished: false, trackedWords: 100, totalWords: 100, wordsRead: 0, totalMs: 0, sessionCount: 0, lastSeenTs: index + 1 }));
  let lockedAttempts = 0;
  const requests: Array<{ type: string; articleIds?: string[]; articleId?: string; settings?: unknown }> = [];
  g["chrome"] = { runtime: { sendMessage: async (msg: typeof requests[number]) => {
    requests.push(msg);
    if (msg.type === "article:classify-history" && msg.articleId === "locked" && lockedAttempts++ === 0) return { ok: false, reason: "HTTP 403" };
    if (msg.type === "article:classify-history") return { ok: true, isArticle: msg.articleId !== "search", reason: "内容类型判断", source: "saved" };
    if (msg.type === "articles:list") return { articles, speed: null };
    if (msg.type === "review:stats") return { dueNow: 0 };
    if (msg.type === "article:review-due") return { items: [], stats: { dueNow: 0 } };
    if (msg.type === "settings:get") return DEFAULT_SETTINGS;
    if (msg.type === "settings:set") return msg.settings;
    if (msg.type === "articles:blacklist-suggest") return { ok: true, suggestions: [{ pattern: "https://example.com/search", reason: "搜索目录" }] };
    if (msg.type === "articles:delete") { articles = articles.filter(a => !msg.articleIds!.includes(a.id)); return { ok: true, deleted: 1 }; }
    return {};
  } } };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const doc = dom.window.document;
  await import("../src/dashboard/index.ts");
  await tick();
  (doc.getElementById("manage-articles") as HTMLButtonElement).click();
  (doc.getElementById("select-articles") as HTMLInputElement).click();
  (doc.getElementById("classify-articles") as HTMLButtonElement).click(); await tick();
  assert.match(doc.getElementById("classification-progress")!.textContent!, /已处理 3 \/ 3/);
  assert.equal(requests.some(r => r.type === "articles:delete"), false, "筛选不会自动删除");
  assert.match(doc.getElementById("classification-progress")!.textContent!, /失败 1 篇/);
  (doc.getElementById("select-nonarticles") as HTMLButtonElement).click();
  assert.equal(doc.getElementById("selection-count")!.textContent, "已选 1 篇");
  assert.equal((doc.querySelector('input[aria-label="选择 essay"]') as HTMLInputElement).checked, false);
  assert.equal((doc.querySelector('input[aria-label="选择 locked"]') as HTMLInputElement).checked, false, "失败项不能被自动勾选");
  (doc.getElementById("retry-classification") as HTMLButtonElement).click(); await tick();
  assert.match(doc.getElementById("classification-progress")!.textContent!, /失败 0 篇/);
  const search = doc.getElementById("q-article") as HTMLInputElement;
  search.value = "search"; search.dispatchEvent(new dom.window.Event("input"));
  assert.equal(doc.getElementById("selection-count")!.textContent, "已选 1 篇");
  (doc.getElementById("suggest-blacklist") as HTMLButtonElement).click(); await tick();
  assert.equal(requests.some(r => r.type === "settings:set"), false, "建议不自动采用");
  (doc.querySelector("#blacklist-suggestions input") as HTMLInputElement).click();
  (doc.querySelector("#blacklist-suggestions button") as HTMLButtonElement).click(); await tick();
  assert.deepEqual(requests.find(r => r.type === "settings:set")!.settings, { articleExcludedUrls: ["https://example.com/search"] });
  (doc.getElementById("delete-articles") as HTMLButtonElement).click(); await tick();
  assert.deepEqual(requests.find(r => r.type === "articles:delete")!.articleIds, ["search"]);
  assert.equal(articles[0]!.id, "essay");
  assert.equal(doc.getElementById("selection-count")!.textContent, "已选 0 篇");
  dom.window.close();
});

test("安卓历史页面具备共用脚本所需的批量操作入口", () => {
  const dom = new JSDOM(readFileSync(new URL("../src/app/index.html", import.meta.url), "utf8"));
  for (const id of ["select-articles", "selection-count", "delete-articles", "suggest-blacklist", "article-action-status", "blacklist-suggestions", "classify-articles", "classification-panel", "select-nonarticles"]) {
    assert.ok(dom.window.document.getElementById(id), id);
  }
  dom.window.close();
});
