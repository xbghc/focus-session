import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { RuleChange } from "../src/types.ts";

/*
 * 名单对话框：说一句 → 列出改动、每条一个勾 → 点确认只写勾上的 → 写了什么补进对话记录，下一轮模型看得见。
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g["document"] = dom.window.document;

const { ruleChatBox } = await import("../src/popup/ruleChat.ts");

const WEIBO: RuleChange = { list: "articleExcludedUrls", label: "文章记录黑名单", op: "add", rule: "weibo.com", reason: "不想记微博", hits: 2 };
const GITHUB: RuleChange = { list: "translationAllowedUrls", label: "翻译白名单", op: "add", rule: "github.com", reason: "", hits: 0 };

let sent: Array<Record<string, unknown>> = [];
let replies: unknown[] = [];
let applied: RuleChange[][] = [];
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sent = [];
  replies = [];
  applied = [];
  dom.window.document.body.replaceChildren();
  g["chrome"] = {
    runtime: {
      sendMessage: async (msg: Record<string, unknown>) => {
        sent.push(structuredClone(msg));
        return replies.shift();
      },
    },
  };
});

function mount() {
  const box = ruleChatBox({ pageUrl: async () => "https://weibo.com/1", onApplied: (a) => { applied.push(a); } });
  dom.window.document.body.append(box);
  const input = box.querySelector<HTMLInputElement>(".rc-input")!;
  return {
    box,
    input,
    async say(text: string) {
      input.value = text;
      box.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      await flush();
    },
    turns: () => [...box.querySelectorAll(".rc-turn")].map((n) => n.textContent),
    button: (cls: string) => box.querySelector<HTMLButtonElement>(`.${cls}`)!,
  };
}

test("说一句：带上当前页问后台；回话和改动清单列出来，每条默认勾上，挡掉的另列", async () => {
  const ui = mount();
  replies = [{ ok: true, reply: "这样改：", changes: [WEIBO, GITHUB], rejected: [{ rule: "co.uk", why: "范围太宽" }] }];
  await ui.say("微博别记了，GitHub 开翻译");
  assert.deepEqual(sent[0], { type: "rules:chat", turns: [{ role: "user", text: "微博别记了，GitHub 开翻译" }], pageUrl: "https://weibo.com/1" });
  assert.deepEqual(ui.turns(), ["微博别记了，GitHub 开翻译", "这样改："]);
  const rows = [...ui.box.querySelectorAll(".rc-change")];
  assert.deepEqual(rows.map((r) => r.textContent), [
    "加进文章记录黑名单：weibo.com不想记微博 · 命中 2 篇已有记录",
    "加进翻译白名单：github.com命中 0 篇已有记录",
  ]);
  assert.ok(rows.every((r) => r.querySelector("input")!.checked));
  assert.equal(ui.box.querySelector(".rc-rejected")!.textContent, "没采用 co.uk：范围太宽");
  assert.equal(ui.input.value, "");
});

test("确认只写勾上的；写了什么补进对话记录，下一轮一起发给模型", async () => {
  const ui = mount();
  replies = [{ ok: true, reply: "这样改：", changes: [WEIBO, GITHUB], rejected: [] }];
  await ui.say("微博别记了，GitHub 开翻译");
  ui.box.querySelectorAll<HTMLInputElement>(".rc-change input")[1]!.checked = false;
  replies = [{ ok: true, applied: [WEIBO], rejected: [] }];
  ui.button("rc-confirm").click();
  await flush();
  assert.deepEqual(sent[1], { type: "rules:apply", changes: [WEIBO] });
  assert.deepEqual(applied, [[WEIBO]]);
  assert.equal(ui.box.querySelector(".rc-plan")!.childElementCount, 0);
  assert.equal(ui.turns().at(-1), "已写入：加进文章记录黑名单 weibo.com");

  replies = [{ ok: true, reply: "好", changes: [], rejected: [] }];
  await ui.say("还有知乎");
  assert.deepEqual((sent[2]!.turns as Array<{ text: string }>).map((t) => t.text), [
    "微博别记了，GitHub 开翻译", "这样改：", "已写入：加进文章记录黑名单 weibo.com", "还有知乎",
  ]);
});

test("不改了：清单收起，记录里说一声没采用", async () => {
  const ui = mount();
  replies = [{ ok: true, reply: "这样改：", changes: [WEIBO], rejected: [] }];
  await ui.say("微博别记了");
  ui.button("rc-cancel").click();
  assert.equal(ui.box.querySelector(".rc-plan")!.childElementCount, 0);
  assert.equal(ui.turns().at(-1), "（这次的改动没有采用）");
  assert.equal(sent.length, 1, "什么都没写");
});

test("没理解成：这句从记录里拿掉，字放回输入框，下一轮不带它", async () => {
  const ui = mount();
  replies = [{ ok: false, error: "HTTP 500" }];
  await ui.say("知乎别记了");
  assert.equal(ui.input.value, "知乎别记了");
  assert.deepEqual(ui.turns(), []);
  assert.match(ui.box.querySelector(".rc-error")!.textContent!, /没理解成：HTTP 500/);
  replies = [{ ok: true, reply: "好", changes: [], rejected: [] }];
  await ui.say("知乎别记了");
  assert.deepEqual(sent[1]!.turns, [{ role: "user", text: "知乎别记了" }]);
});

test("写入失败：清单留着、按钮放开，能再点一次", async () => {
  const ui = mount();
  replies = [{ ok: true, reply: "这样改：", changes: [WEIBO], rejected: [] }];
  await ui.say("微博别记了");
  replies = [{ ok: false, error: "磁盘满了" }];
  ui.button("rc-confirm").click();
  await flush();
  assert.equal(ui.button("rc-confirm").disabled, false);
  assert.match(ui.box.querySelector(".rc-plan .rc-error")!.textContent!, /没写进去：磁盘满了/);
  assert.deepEqual(applied, []);
});
