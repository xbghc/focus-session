import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords } from "../src/lib/wordcount.ts";
import { normalizeUrl, isExcluded, hostnameOf } from "../src/lib/url.ts";
import { quantile, wordsPerMinute, formatDuration } from "../src/lib/stats.ts";
import { hashText } from "../src/lib/hash.ts";

test("英文按词计数", () => {
  assert.equal(countWords("the quick brown fox"), 4);
  assert.equal(countWords("  spaced   out  words  "), 3);
  assert.equal(countWords("don't hyphen-ated"), 2);
  assert.equal(countWords(""), 0);
  assert.equal(countWords("!!! ??? ---"), 0);
});

test("中文按字符计数，标点不计", () => {
  assert.equal(countWords("你好世界"), 4);
  assert.equal(countWords("你好，世界！"), 4);
});

test("中英混排分别统计后相加", () => {
  assert.equal(countWords("读 React 文档"), 1 + 1 + 2, "读(1) + React(1) + 文档(2)");
  // 无空格混排不能被算成一个词
  assert.equal(countWords("读React"), 2);
});

test("日文假名与韩文按字符计数", () => {
  assert.equal(countWords("こんにちは"), 5);
  assert.equal(countWords("안녕하세요"), 5);
});

test("数字与代码标识符按词计数", () => {
  assert.equal(countWords("HTTP 404 error_code"), 3);
});

test("normalizeUrl 去掉 hash 与跟踪参数", () => {
  assert.equal(normalizeUrl("https://a.com/p?utm_source=x&id=3#top"), "https://a.com/p?id=3");
  assert.equal(normalizeUrl("https://a.com/p?fbclid=abc"), "https://a.com/p");
  assert.equal(normalizeUrl("https://a.com/p#section"), "https://a.com/p");
});

test("normalizeUrl 保留有意义的查询参数并稳定排序", () => {
  assert.equal(normalizeUrl("https://a.com/p?b=2&a=1"), normalizeUrl("https://a.com/p?a=1&b=2"));
  assert.ok(normalizeUrl("https://a.com/p?page=2").includes("page=2"));
});

test("normalizeUrl 对非法输入原样返回", () => {
  assert.equal(normalizeUrl("not a url"), "not a url");
});

test("hostnameOf", () => {
  assert.equal(hostnameOf("https://news.example.com/x"), "news.example.com");
  assert.equal(hostnameOf("garbage"), "");
});

test("排除域名匹配子域，且不误伤同后缀域名", () => {
  assert.equal(isExcluded("mail.google.com", ["google.com"]), true);
  assert.equal(isExcluded("google.com", ["google.com"]), true);
  assert.equal(isExcluded("notgoogle.com", ["google.com"]), false, "后缀相同但不是子域");
  assert.equal(isExcluded("x.com", ["*.x.com"]), true);
  assert.equal(isExcluded("a.com", []), false);
  assert.equal(isExcluded("a.com", ["  ", ""]), false, "空白项不应匹配一切");
});

test("quantile 线性插值", () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([5, 1, 3], 0.5), 3, "输入乱序也应正确");
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([7], 0.9), 7);
});

test("wordsPerMinute", () => {
  assert.equal(wordsPerMinute(300, 60_000), 300);
  assert.equal(wordsPerMinute(150, 30_000), 300);
  assert.equal(wordsPerMinute(100, 0), 0, "零时长不能返回 Infinity");
});

test("formatDuration", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(90_000), "1m 30s");
  assert.equal(formatDuration(3_700_000), "1h 1m");
  assert.equal(formatDuration(-5), "0s");
});

test("hashText 稳定且能区分不同文本", () => {
  assert.equal(hashText("同一段落"), hashText("同一段落"));
  assert.notEqual(hashText("段落 A"), hashText("段落 B"));
  assert.match(hashText("x"), /^[0-9a-z]+$/);
});
