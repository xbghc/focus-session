import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  UI_EVENTS,
  UI_USAGE_DAYS,
  bumpUiUsage,
  createUiTracker,
  dayKey,
  emptyUiUsage,
  normalizeUiUsage,
  summarizeUiUsage,
  type UiEvent,
} from "../src/lib/uiUsage.ts";
import { KEY_UI_USAGE, getUiUsage, recordUiUsage } from "../src/background/uiUsage.ts";
import { clearLlmLog, llmLogBundle } from "../src/background/llmLog.ts";
import { clearData } from "../src/background/store.ts";

/** 与 llmLog.test.ts 同款内存 storage：深拷贝，暴露"改了没写回"这类错误。 */
function fakeArea() {
  const data = new Map<string, unknown>();
  return {
    data,
    writes: 0,
    async get(keys: string | string[] | null) {
      if (keys === null) return structuredClone(Object.fromEntries(data));
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      this.writes += 1;
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

let area = fakeArea();
(globalThis as Record<string, unknown>)["chrome"] = { storage: { get local() { return area; } } };
beforeEach(() => {
  area = fakeArea();
});

const DAY = 86_400_000;
/** 本地正午：加减整天不会因为夏令时或时区落到隔壁那天。 */
const NOON = new Date(2026, 8, 19, 12).getTime();

test("dayKey 按本地日期分桶，不按 UTC", () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 0, 30).getTime()), "2026-01-05");
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59).getTime()), "2026-01-05");
});

test("记数：同一天累加，表外的名字不收，不改传进来的对象", () => {
  const before = emptyUiUsage();
  const once = bumpUiUsage(before, ["articles.detail", "articles.detail", "nope", 42, "__proto__"], NOON);
  assert.deepEqual(before, emptyUiUsage());
  assert.deepEqual(once, { since: "2026-09-19", days: { "2026-09-19": { "articles.detail": 2 } } });
  const next = bumpUiUsage(once, ["articles.detail", "speak"], NOON + DAY);
  assert.equal(next.since, "2026-09-19", "since 是第一次记数那天，之后不动");
  assert.deepEqual(next.days["2026-09-20"], { "articles.detail": 1, "speak": 1 });
  assert.deepEqual(once.days["2026-09-19"], { "articles.detail": 2 });
});

test("一批里全是废名字：不开当天的桶，也不立 since", () => {
  assert.deepEqual(bumpUiUsage(emptyUiUsage(), ["nope"], NOON), emptyUiUsage());
});

test("过了保留期的桶在下一次记数时滚掉", () => {
  let log = bumpUiUsage(emptyUiUsage(), ["page.open"], NOON - UI_USAGE_DAYS * DAY);
  log = bumpUiUsage(log, ["page.open"], NOON - (UI_USAGE_DAYS - 1) * DAY);
  log = bumpUiUsage(log, ["page.open"], NOON);
  assert.deepEqual(Object.keys(log.days).sort(), [dayKey(NOON - (UI_USAGE_DAYS - 1) * DAY), dayKey(NOON)]);
});

test("normalize：形状不对的整份当空的，坏的天和坏的数丢掉", () => {
  assert.deepEqual(normalizeUiUsage(undefined), emptyUiUsage());
  assert.deepEqual(normalizeUiUsage("x"), emptyUiUsage());
  assert.deepEqual(
    normalizeUiUsage({ since: "2026-09-01", days: { "2026-09-01": { "speak": 3, "nope": 1, "page.open": -2, "nav.words": 1.5 }, "昨天": { "speak": 1 }, "2026-09-02": null } }),
    { since: "2026-09-01", days: { "2026-09-01": { "speak": 3 } } },
  );
});

test("报表：表里每个事件都有一行，零也列；次数多的在前，同次数按表里的顺序", () => {
  let log = emptyUiUsage();
  log = bumpUiUsage(log, ["words.delete"], NOON - 40 * DAY);
  log = bumpUiUsage(log, ["words.delete", "articles.detail"], NOON - 10 * DAY);
  log = bumpUiUsage(log, ["words.delete", "articles.detail", "articles.detail"], NOON);
  const s = summarizeUiUsage(log, NOON);
  assert.equal(s.since, dayKey(NOON - 40 * DAY));
  assert.equal(s.activeDays, 3);
  assert.equal(s.rows.length, Object.keys(UI_EVENTS).length);
  assert.deepEqual(s.rows.slice(0, 2).map((r) => [r.name, r.last7, r.last30, r.total]), [
    ["articles.detail", 2, 3, 3], // 和 words.delete 同为 3 次，表里排在前面
    ["words.delete", 1, 2, 3],
  ]);
  const zeros = s.rows.slice(2);
  assert.ok(zeros.every((r) => r.total === 0));
  assert.deepEqual(zeros.map((r) => r.name), (Object.keys(UI_EVENTS) as UiEvent[]).filter((n) => n !== "articles.detail" && n !== "words.delete"));
});

test("报表的七天窗含今天共七天", () => {
  let log = bumpUiUsage(emptyUiUsage(), ["speak"], NOON - 6 * DAY);
  log = bumpUiUsage(log, ["speak"], NOON - 7 * DAY);
  const row = summarizeUiUsage(log, NOON).rows.find((r) => r.name === "speak")!;
  assert.deepEqual([row.last7, row.last30], [1, 2]);
});

test("页面这头攒一批再发；flush 立刻交掉并撤掉计时器；发送抛错不外溢", async () => {
  const sent: UiEvent[][] = [];
  const tracker = createUiTracker((events) => { sent.push(events); }, 20);
  tracker.track("nav.review");
  tracker.track("review.words.grade");
  assert.deepEqual(sent, [], "没到点不发");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(sent, [["nav.review", "review.words.grade"]]);
  tracker.track("speak");
  tracker.flush();
  assert.deepEqual(sent[1], ["speak"]);
  tracker.flush();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sent.length, 2, "手里没东西不发，先前的计时器也不会再发一遍");

  const broken = createUiTracker(() => { throw new Error("后台没醒"); }, 20);
  broken.track("speak");
  assert.doesNotThrow(() => broken.flush());
});

test("落盘：并发两批不互相盖；全是废名字不写盘", async () => {
  await Promise.all([recordUiUsage(["speak"], NOON), recordUiUsage(["speak", "nav.words"], NOON)]);
  assert.deepEqual((await getUiUsage()).days["2026-09-19"], { "speak": 2, "nav.words": 1 });
  const writes = area.writes;
  await recordUiUsage(["nope"], NOON);
  await recordUiUsage([], NOON);
  assert.equal(area.writes, writes);
});

test("落盘失败吞掉", async () => {
  area.set = async () => { throw new Error("quota"); };
  await assert.doesNotReject(recordUiUsage(["speak"], NOON));
});

test("进诊断导出；「清空日志」不清它，「清空全部记录」才清", async () => {
  await recordUiUsage(["articles.search.open"], NOON);
  assert.deepEqual((await llmLogBundle("test")).usage.days["2026-09-19"], { "articles.search.open": 1 });
  await clearLlmLog();
  assert.ok(area.data.has(KEY_UI_USAGE), "清日志是排查的第一步，不该把攒了几周的计数归零");
  await clearData();
  assert.deepEqual(await getUiUsage(), emptyUiUsage());
});
