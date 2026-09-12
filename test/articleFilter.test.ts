import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecision, parseSuggestions, samplePage } from "../src/lib/articleFilter.ts";
import { isUrlExcluded, matchesUrlRule } from "../src/lib/url.ts";

test("文章判断严格接受布尔值，错误响应不会默认收录", () => {
  assert.deepEqual(parseDecision({ isArticle: false, reason: "目录" }), { isArticle: false, reason: "目录" });
  assert.equal(parseDecision({ isArticle: true, reason: "短文" }).isArticle, true);
  for (const raw of [null, {}, { isArticle: "false", reason: "列表" }, { isArticle: true }]) {
    assert.throws(() => parseDecision(raw));
  }
});

test("长页送头中尾，短文不因长度被排除", () => {
  assert.equal(samplePage("短文"), "短文");
  const sample = samplePage("头".repeat(15_000) + "中".repeat(15_000) + "尾".repeat(15_000));
  assert.ok(sample.startsWith("头") && sample.includes("中") && sample.endsWith("尾"));
  assert.ok(sample.length < 31_000);
});

test("黑名单匹配域名边界、路径边界、协议，保留路径大小写", () => {
  assert.ok(matchesUrlRule("https://mail.example.com/a", "example.com"));
  assert.ok(matchesUrlRule("https://example.com/search/a?q=x", "https://example.com/search"));
  assert.ok(matchesUrlRule("https://example.com/a", "https://example.com/"));
  for (const url of ["https://evil-example.com/search", "https://example.com/searching", "https://example.com/Search", "http://example.com/search"]) {
    assert.equal(matchesUrlRule(url, "https://example.com/search"), false);
  }
  assert.equal(isUrlExcluded("https://example.com/a", ["*", "com", "https://example.com/?q=x"]), false);
});

test("LLM 建议去重，丢弃无关或无效规则", () => {
  const suggestions = parseSuggestions({ suggestions: [
    { pattern: "https://example.com/search", reason: "搜索页" },
    { pattern: "https://example.com/search", reason: "重复" },
    { pattern: "other.com", reason: "无关" },
    { pattern: "*", reason: "全部" },
  ] }, ["https://example.com/search?q=abc"]);
  assert.deepEqual(suggestions, [{ pattern: "https://example.com/search", reason: "搜索页" }]);
});
