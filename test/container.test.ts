import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractArticle, extractFromContainer } from "../src/content/paragraphs.ts";

/*
 * App 的阅读器从自己渲染的容器里抽段落。这里盯的是它和网页上那条路径的**一致性**：
 * 同一篇正文，两条路径得出同一批指纹，已读段落才能跨设备去重。
 */

const para = (tag: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<p>${tag} ${i}. Sentence padding long enough to survive readability scoring of candidate blocks in the document tree.</p>`,
  ).join("");

before(() => {
  const dom = new JSDOM("");
  (globalThis as Record<string, unknown>).Node ??= dom.window.Node;
});

test("容器抽取与整页抽取得出同一批段落指纹", () => {
  const body = `<article><h1>真正的标题</h1>${para("REAL", 10)}<ul><li><p>List item paragraph with enough words to count as a block of its own here.</p></li></ul></article>`;
  const full = new JSDOM(`<!doctype html><html><head><title>T</title></head><body><nav>${para("NAV", 2)}</nav>${body}</body></html>`, {
    url: "https://example.com/article",
  }).window.document as unknown as Document;
  const whole = extractArticle(full);
  assert.ok(whole);

  const own = new JSDOM(`<!doctype html><html><body><main id="article">${body}</main></body></html>`).window.document;
  const part = extractFromContainer(own.getElementById("article")!, "真正的标题");
  assert.ok(part);

  assert.deepEqual(
    part.paragraphs.map((p) => p.hash),
    whole.paragraphs.map((p) => p.hash),
  );
  assert.equal(part.trackedWords, whole.trackedWords);
  assert.equal(part.title, "真正的标题");
  // 段落对象指向容器里的活节点，追踪器要靠它量位置
  assert.ok(part.paragraphs.every((p) => p.el.isConnected));
});

test("只取最内层的块、空块跳过、重复文本只记一次", () => {
  const doc = new JSDOM(
    `<div id="a"><ul><li><p>Inner paragraph one with words.</p></li></ul><p></p><p>Twice the same.</p><p>Twice the same.</p></div>`,
  ).window.document;
  const res = extractFromContainer(doc.getElementById("a")!, "x");
  assert.ok(res);
  assert.equal(res.paragraphs.length, 2);
  assert.deepEqual(
    res.paragraphs.map((p) => p.index),
    [0, 1],
  );
});

test("容器里没有任何有字的块时返回 null", () => {
  const doc = new JSDOM(`<div id="a"><p>   </p><div>no block here</div></div>`).window.document;
  assert.equal(extractFromContainer(doc.getElementById("a")!, "x"), null);
});
