import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { sanitizeArticle } from "../src/app/sanitize.ts";

const doc = new JSDOM("<!doctype html><html><body></body></html>").window.document;
const clean = (html: string, base = "https://example.com/post/1"): string => sanitizeArticle(html, base, doc);

test("脚本、样式、iframe 连内容一起丢掉；事件属性去掉", () => {
  const out = clean(`<p onclick="x()">Hi<script>alert(1)</script></p><style>p{}</style><iframe src="x"></iframe>`);
  assert.equal(out, "<p>Hi</p>");
});

test("不认识的标签只留内容", () => {
  assert.equal(clean(`<center><font color="red">text</font></center>`), "text");
  assert.equal(clean(`<picture><source srcset="a.webp"><img src="https://x/a.png"></picture>`), `<img src="https://x/a.png">`);
});

test("链接只留 href，补全相对地址，javascript: 去掉，一律 noreferrer", () => {
  assert.equal(
    clean(`<a href="/next" class="c" id="i" target="_blank">n</a>`),
    `<a href="https://example.com/next" rel="noreferrer">n</a>`,
  );
  assert.equal(clean(`<a href="javascript:alert(1)">x</a>`), `<a rel="noreferrer">x</a>`);
  assert.equal(clean(`<a href="#fn1">x</a>`), `<a href="#fn1" rel="noreferrer">x</a>`);
});

test("图片：网络地址补全、内嵌图片放行、其他协议的图片整个去掉", () => {
  assert.equal(clean(`<img src="img/a.jpg" alt="A" style="w">`), `<img src="https://example.com/post/img/a.jpg" alt="A">`);
  const data = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(clean(`<img src="${data}">`), `<img src="${data}">`);
  assert.equal(clean(`<p><img src="javascript:x"></p>`), "<p></p>");
});

test("表格与列表的结构属性保留，其余属性去掉", () => {
  assert.equal(clean(`<td colspan="2" style="x">a</td>`), `<td colspan="2">a</td>`);
  assert.equal(clean(`<ol start="3" class="c"><li>a</li></ol>`), `<ol start="3"><li>a</li></ol>`);
});

test("svg 与表单不进正文", () => {
  assert.equal(clean(`<p>a</p><svg onload="x"><circle/></svg><form><input><button>b</button></form>`), "<p>a</p>");
});
