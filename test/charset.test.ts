import { test } from "node:test";
import assert from "node:assert/strict";
import { charsetOf, decodeWith, hasBom, pickCharset, sniffCharset } from "../src/lib/charset.ts";

/** ASCII 串 → 字节。构造页面头部用。 */
const ascii = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

/** GBK 的「中文」。TextEncoder 只会 UTF-8，非 UTF-8 的样本只能手写字节。 */
const GBK_ZHONGWEN = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);

test("charsetOf 从 Content-Type 里取 charset，大小写和引号都认", () => {
  assert.equal(charsetOf("text/html; charset=UTF-8"), "utf-8");
  assert.equal(charsetOf('text/html;charset="GBK"'), "gbk");
  assert.equal(charsetOf("text/html"), null);
  assert.equal(charsetOf(null), null);
});

test("sniffCharset 认 meta 声明的两种写法", () => {
  assert.equal(sniffCharset(ascii('<html><head><meta charset="gbk">')), "gbk");
  assert.equal(sniffCharset(ascii("<meta http-equiv=Content-Type content='text/html; charset=Big5'>")), "big5");
  assert.equal(sniffCharset(ascii("<html><head><title>没声明</title>")), null);
});

test("sniffCharset 只看前 4KB：声明埋得太深就当没有", () => {
  const deep = ascii("<html><head>" + " ".repeat(5000) + '<meta charset="gbk">');
  assert.equal(sniffCharset(deep), null);
});

test("pickCharset 的次序：响应头 > meta > 兜底 UTF-8", () => {
  const withMeta = ascii('<meta charset="gbk">');
  assert.deepEqual(pickCharset("text/html; charset=utf-8", withMeta), { charset: "utf-8", from: "header" });
  assert.deepEqual(pickCharset("text/html", withMeta), { charset: "gbk", from: "meta" });
  assert.deepEqual(pickCharset(null, ascii("<html>")), { charset: "utf-8", from: "default" });
});

test("GBK 的字节按 gbk 解得出来，一个字节都没掉", () => {
  const got = decodeWith(GBK_ZHONGWEN, "gbk");
  assert.equal(got.text, "中文");
  assert.equal(got.replacementChars, 0);
  assert.equal(got.fellBack, false);
});

test("同一串字节按 utf-8 解就成了替换字符——诊断日志靠这个数发现编码挑错了", () => {
  const got = decodeWith(GBK_ZHONGWEN, "utf-8");
  assert.equal(got.replacementChars, 4);
  assert.equal(got.fellBack, false);
});

test("认不出的编码名退回 UTF-8 并记下来，而不是让整页打不开", () => {
  const got = decodeWith(ascii("hello"), "x-nonesuch");
  assert.equal(got.text, "hello");
  assert.equal(got.fellBack, true);
  assert.equal(got.replacementChars, 0);
});

test("BOM 认得出来；TextDecoder 自己会把它从正文里吃掉", () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
  assert.equal(hasBom(bom), true);
  assert.equal(hasBom(ascii("hi")), false);
  assert.equal(decodeWith(bom, "utf-8").text, "hi");
});
