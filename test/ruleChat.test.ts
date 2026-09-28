import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TURNS,
  applyRuleChanges,
  followStoredList,
  normalizeUrlRule,
  parseRulePlan,
  ruleChatInput,
  ruleChatSystem,
  type UrlRuleList,
} from "../src/lib/ruleChat.ts";

/*
 * 名单对话的规矩：模型提的改动先过这一关才给人看，确认写入时再过一遍。
 */

const LISTS: UrlRuleList[] = [
  { key: "articleExcludedUrls", label: "文章记录黑名单", meaning: "不记录" },
  { key: "translationAllowedUrls", label: "翻译白名单", meaning: "自动翻译" },
];
const current = {
  articleExcludedUrls: ["ZhiHu.com", "https://example.com/search"],
  translationAllowedUrls: ["*.github.com", "nytimes.com"],
};
const plan = (changes: unknown[], reply = "好的") => parseRulePlan({ reply, changes }, LISTS, current);
const add = (list: string, rule: string) => ({ list, op: "add", rule, reason: "用户要求" });
const remove = (list: string, rule: string) => ({ list, op: "remove", rule, reason: "用户要求" });

test("规则整理成名单里的样子：域名小写、去掉 *.，网址去掉末尾的 /；写法不对的认不了", () => {
  assert.equal(normalizeUrlRule(" WeiBo.com "), "weibo.com");
  assert.equal(normalizeUrlRule("*.news.example.org"), "news.example.org");
  assert.equal(normalizeUrlRule("https://Example.com/Blog/"), "https://example.com/Blog");
  assert.equal(normalizeUrlRule("https://example.com/"), "https://example.com");
  for (const bad of ["com", "zhihu", "https://example.com/?q=1", "https://example.com/#top", "https://u:p@example.com/", "ftp://example.com", "知乎", "example.com/path", ""]) {
    assert.equal(normalizeUrlRule(bad), null, bad);
  }
});

test("正常的加和删：加的是整理过的写法，删的是名单里原样那一条", () => {
  const got = plan([add("articleExcludedUrls", "Weibo.com"), remove("articleExcludedUrls", "zhihu.com"), remove("translationAllowedUrls", "github.com")]);
  assert.deepEqual(got.changes.map((c) => [c.list, c.op, c.rule, c.label]), [
    ["articleExcludedUrls", "add", "weibo.com", "文章记录黑名单"],
    ["articleExcludedUrls", "remove", "ZhiHu.com", "文章记录黑名单"],
    ["translationAllowedUrls", "remove", "*.github.com", "翻译白名单"],
  ]);
  assert.deepEqual(got.rejected, []);
  assert.equal(got.reply, "好的");
});

test("挡掉的几种，各说为什么", () => {
  const got = plan([
    add("articleExcludedUrls", "co.uk"),
    add("articleExcludedUrls", "https://zhihu.com/question/1"),
    add("articleExcludedUrls", "www.zhihu.com"),
    add("articleExcludedUrls", "zhihu.com"),
    add("articleExcludedUrls", "https://example.com/search/advanced"),
    add("articleExcludedUrls", "zhihu"),
    remove("translationAllowedUrls", "weibo.com"),
    add("somethingElse", "a.com"),
    { list: "articleExcludedUrls", op: "replace", rule: "b.com" },
  ]);
  assert.deepEqual(got.changes, []);
  assert.deepEqual(got.rejected.map((r) => [r.rule, r.why]), [
    ["co.uk", "范围太宽：会命中这一整个国家后缀下的所有网站"],
    ["https://zhihu.com/question/1", "已被 ZhiHu.com 覆盖"],
    ["www.zhihu.com", "已被 ZhiHu.com 覆盖"],
    ["zhihu.com", "已经在文章记录黑名单里"],
    ["https://example.com/search/advanced", "已被 https://example.com/search 覆盖"],
    ["zhihu", "写法不对：只能是域名，或不带参数的完整网址"],
    ["weibo.com", "翻译白名单里没有这一条"],
    ["a.com", "不认识要改的是哪份名单"],
    ["b.com", "没说是加还是删"],
  ]);
  assert.equal(parseRulePlan({ changes: [add("articleExcludedUrls", "co.uk")] }, LISTS, current).reply, "提的改动都没法采用：");
});

test("重复的只留一条；模型只回了话没提改动也行；什么都没给算失败", () => {
  const got = plan([add("articleExcludedUrls", "weibo.com"), add("articleExcludedUrls", "WEIBO.com")]);
  assert.equal(got.changes.length, 1);
  assert.deepEqual(parseRulePlan({ reply: "你说的是哪个网站？", changes: [] }, LISTS, current), { reply: "你说的是哪个网站？", changes: [], rejected: [] });
  assert.equal(parseRulePlan({ changes: [] }, LISTS, current).reply, "没听出要改什么，换个说法试试？");
  assert.throws(() => parseRulePlan(null, LISTS, current), /模型没有给出有效的回答/);
  assert.throws(() => parseRulePlan({ answer: 1 }, LISTS, current), /模型没有给出有效的回答/);
});

test("套改动：加的接在末尾，删的按整理后的样子比，别的原样不动", () => {
  assert.deepEqual(
    applyRuleChanges(["ZhiHu.com", "*.github.com", "keep.me"], [
      { op: "add", rule: "weibo.com" },
      { op: "add", rule: "keep.me" },
      { op: "remove", rule: "zhihu.com" },
      { op: "remove", rule: "github.com" },
    ]),
    ["keep.me", "weibo.com"],
  );
});

test("设置页的名单框：没动过就换成存储里的，动过就在手改上套同样的改动", () => {
  const stored = ["a.com", "weibo.com"];
  const changes = [{ op: "add" as const, rule: "weibo.com" }];
  assert.deepEqual(followStoredList(["a.com"], ["a.com"], stored, changes), stored);
  assert.deepEqual(followStoredList(["a.com", "mine.com"], ["a.com"], stored, changes), ["a.com", "mine.com", "weibo.com"]);
  assert.deepEqual(followStoredList([], undefined, stored, changes), stored, "还没读到设置时当作没动过");
});

test("给模型的说明带上各份名单的现状；有当前页就说清「这个站」指它，没有就让它问", () => {
  const withPage = ruleChatSystem(LISTS, current, "https://www.zhihu.com/question/1?x=1");
  assert.match(withPage, /articleExcludedUrls「文章记录黑名单」：不记录/);
  assert.match(withPage, /"translationAllowedUrls":\["\*\.github\.com","nytimes\.com"\]/);
  assert.match(withPage, /用户正开着这一页：https:\/\/www\.zhihu\.com\/question\/1\?x=1/);
  assert.match(ruleChatSystem(LISTS, current), /这次没有开着的页面/);
});

test("只带最近几句对话", () => {
  const turns = Array.from({ length: MAX_TURNS + 3 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, text: `第 ${i} 句` }));
  const sent = JSON.parse(ruleChatInput(turns)).history as Array<{ text: string }>;
  assert.equal(sent.length, MAX_TURNS);
  assert.equal(sent.at(-1)!.text, `第 ${MAX_TURNS + 2} 句`);
});
