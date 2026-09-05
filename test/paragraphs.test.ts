import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractArticle, isInReadingView } from "../src/content/paragraphs.ts";

const VH = 900;
const rect = (top: number, height: number) => ({ top, height, bottom: top + height });

test("短段落露出一半才算在读", () => {
  assert.equal(isInReadingView(rect(100, 200), VH), true, "完全可见");
  assert.equal(isInReadingView(rect(-150, 200), VH), false, "只剩 50px 露在上边");
  assert.equal(isInReadingView(rect(-100, 200), VH), true, "刚好露出一半");
  assert.equal(isInReadingView(rect(VH - 40, 200), VH), false, "只从下边探出 40px");
});

test("超过视口高度的长段落只要占住半屏就算在读", () => {
  // 高 3 屏的段落，可见度永远到不了 50%，但占满视口时显然是在读
  assert.equal(isInReadingView(rect(0, VH * 3), VH), true);
  assert.equal(isInReadingView(rect(VH - 500, VH * 3), VH), true, "占住 500px（>半屏）");
  assert.equal(isInReadingView(rect(VH - 100, VH * 3), VH), false, "只占住 100px");
});

test("完全离开视口不算在读", () => {
  assert.equal(isInReadingView(rect(-500, 200), VH), false);
  assert.equal(isInReadingView(rect(VH + 10, 200), VH), false);
});

test("退化输入不崩溃", () => {
  assert.equal(isInReadingView(rect(0, 0), VH), false);
  assert.equal(isInReadingView(rect(0, 200), 0), false);
});

/* ---------- extractArticle ---------- */

const para = (tag: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<p>${tag} ${i}. Sentence padding long enough to survive readability scoring of candidate blocks in the document tree.</p>`,
  ).join("");

function docFrom(bodyHtml: string): Document {
  return new JSDOM(`<!doctype html><html><head><title>Fixture</title></head><body>${bodyHtml}</body></html>`, {
    url: "https://example.com/article",
  }).window.document as unknown as Document;
}

before(() => {
  // extractArticle 只依赖传入的 document，但 jsdom 的 Element 需要全局构造器可用
  const dom = new JSDOM("");
  (globalThis as Record<string, unknown>).Node ??= dom.window.Node;
});

test("抽取正文并剔除导航/侧栏/评论/页脚", () => {
  const doc = docFrom(`
    <nav>${para("NAVJUNK", 2)}</nav>
    <aside>${para("SIDEBARJUNK", 3)}</aside>
    <article><h1>真正的标题</h1>${para("REAL", 10)}</article>
    <div class="comments">${para("COMMENTJUNK", 4)}</div>
    <footer>${para("FOOTERJUNK", 2)}</footer>`);

  const res = extractArticle(doc);
  assert.ok(res, "应成功抽取");
  const texts = res.paragraphs.map((p) => p.el.textContent ?? "");
  assert.ok(
    texts.every((t) => !/JUNK/.test(t)),
    `不应含页面垃圾内容：${texts.filter((t) => /JUNK/.test(t)).join(" | ")}`,
  );
  assert.equal(texts.filter((t) => /REAL/.test(t)).length, 10);
});

test("段落映射回的是活动 DOM 的节点，不是副本", () => {
  const doc = docFrom(`<article>${para("REAL", 8)}</article>`);
  const res = extractArticle(doc);
  assert.ok(res);
  for (const p of res.paragraphs) {
    assert.equal(p.el.ownerDocument, doc, "必须属于原文档");
    assert.equal(p.el.isConnected, true, "必须仍挂在活动 DOM 上");
  }
});

test("解析后不在页面上留下标记属性", () => {
  const doc = docFrom(`<article>${para("REAL", 8)}</article>`);
  extractArticle(doc);
  assert.equal(doc.querySelectorAll("[data-fs-p]").length, 0);
});

test("嵌套块只计最内层，避免同一段文本重复计数", () => {
  const doc = docFrom(`<article>
    ${para("REAL", 8)}
    <ul><li><p>嵌套在列表项里的段落，内容要足够长才不会被清洗掉，这里多写一些中文字符来凑够长度。</p></li></ul>
  </article>`);
  const res = extractArticle(doc);
  assert.ok(res);
  const nested = res.paragraphs.filter((p) => (p.el.textContent ?? "").includes("嵌套在列表项里"));
  assert.equal(nested.length, 1, "li 和它内部的 p 不能各记一次");
  assert.equal(nested[0]!.el.tagName, "P", "应保留最内层的块");
});

test("重复文本（隐藏副本/打印版）只计一次", () => {
  const dup = `<p>这段文字在页面上出现了两次，需要足够长以免被 readability 清洗掉，所以继续补充一些内容。</p>`;
  const doc = docFrom(`<article>${para("REAL", 8)}${dup}${dup}</article>`);
  const res = extractArticle(doc);
  assert.ok(res);
  const hits = res.paragraphs.filter((p) => (p.el.textContent ?? "").includes("出现了两次"));
  assert.equal(hits.length, 1);
});

test("字数统计：trackedWords 是段落之和且不超过 totalWords", () => {
  const doc = docFrom(`<article>${para("REAL", 10)}
    <div>裸文本节点，没有被任何块级元素包住，因此不可观测，但会计入 totalWords。</div>
  </article>`);
  const res = extractArticle(doc);
  assert.ok(res);
  assert.equal(
    res.trackedWords,
    res.paragraphs.reduce((n, p) => n + p.words, 0),
  );
  assert.ok(res.trackedWords > 0);
  assert.ok(res.totalWords >= res.trackedWords, `${res.totalWords} >= ${res.trackedWords}`);
});

test("段落 index 连续且 hash 唯一", () => {
  const doc = docFrom(`<article>${para("REAL", 12)}</article>`);
  const res = extractArticle(doc);
  assert.ok(res);
  assert.deepEqual(
    res.paragraphs.map((p) => p.index),
    res.paragraphs.map((_, i) => i),
  );
  assert.equal(new Set(res.paragraphs.map((p) => p.hash)).size, res.paragraphs.length);
});

test("非文章页返回 null", () => {
  const doc = docFrom(`<div><a href="/a">链接</a><a href="/b">另一个</a></div>`);
  assert.equal(extractArticle(doc), null);
});

test("中文文章能正确抽取并按字符计数", () => {
  const cn = Array.from(
    { length: 10 },
    (_, i) =>
      `<p>第${i}段。这是一段足够长的中文正文内容，用来测试抽取流程在中文页面上的表现，需要保证长度超过清洗阈值才不会被丢掉。</p>`,
  ).join("");
  const doc = docFrom(`<article><h1>中文标题</h1>${cn}</article>`);
  const res = extractArticle(doc);
  assert.ok(res, "中文文章应能抽取");
  assert.ok(res.paragraphs.length >= 10);
  assert.ok(res.trackedWords > 300, `中文按字符计数应有几百字，实际 ${res.trackedWords}`);
});
