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
  settleUiUpload,
  summarizeUiUsage,
  type UiEvent,
} from "../src/lib/uiUsage.ts";
import {
  KEY_UI_USAGE,
  UPLOAD_EVERY_MS,
  UPLOAD_RETRY_MS,
  UPLOAD_UNSUPPORTED_MS,
  getUiUsage,
  recordUiUsage,
  uploadUiUsage,
  type UiUsageUpload,
} from "../src/background/uiUsage.ts";
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
  assert.deepEqual(once, { since: "2026-09-19", days: { "2026-09-19": { "articles.detail": 2 } }, pending: ["2026-09-19"], nextUploadAt: 0 });
  const next = bumpUiUsage(once, ["articles.detail", "speak"], NOON + DAY);
  assert.equal(next.since, "2026-09-19", "since 是第一次记数那天，之后不动");
  assert.deepEqual(next.days["2026-09-20"], { "articles.detail": 1, "speak": 1 });
  assert.deepEqual(next.pending, ["2026-09-19", "2026-09-20"], "哪天动过，哪天就等着上传");
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
  assert.deepEqual([...log.pending].sort(), Object.keys(log.days).sort(), "滚掉的那天也不再等着上传");
});

test("normalize：形状不对的整份当空的，坏的天和坏的数丢掉", () => {
  assert.deepEqual(normalizeUiUsage(undefined), emptyUiUsage());
  assert.deepEqual(normalizeUiUsage("x"), emptyUiUsage());
  assert.deepEqual(
    normalizeUiUsage({ since: "2026-09-01", days: { "2026-09-01": { "speak": 3, "nope": 1, "page.open": -2, "nav.words": 1.5 }, "昨天": { "speak": 1 }, "2026-09-02": null } }),
    // 没有 pending 的是上传出现之前存下的：每一天服务器上都没有，都得传
    { since: "2026-09-01", days: { "2026-09-01": { "speak": 3 } }, pending: ["2026-09-01"], nextUploadAt: 0 },
  );
  const kept = normalizeUiUsage({ since: null, days: { "2026-09-01": { "speak": 1 } }, pending: ["2026-09-01", "2026-08-01", 7], nextUploadAt: 99 });
  assert.deepEqual([kept.pending, kept.nextUploadAt], [["2026-09-01"], 99], "等着上传的只能是还留着的天");
  assert.deepEqual(normalizeUiUsage({ days: { "2026-09-01": { "speak": 1 } }, pending: [] }).pending, [], "传完了的就是传完了，不因为重读一遍又全部重传");
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

/* ==================== 上传 ==================== */

test("settle：传的过程中没再涨的那几天划掉，涨了的留着", () => {
  let log = bumpUiUsage(emptyUiUsage(), ["speak"], NOON - DAY);
  log = bumpUiUsage(log, ["speak"], NOON);
  const sent = structuredClone(log.days);
  log = bumpUiUsage(log, ["speak"], NOON); // 请求在路上的时候又点了一下
  const after = settleUiUpload(log, sent, 123);
  assert.deepEqual([after.pending, after.nextUploadAt], [[dayKey(NOON)], 123]);
  assert.deepEqual(settleUiUpload(log, {}, 456).pending, log.pending, "没传成：一天都不划");
});

test("上传：发的是每天的累计数，成了就划掉并隔一阵再传；没有待传的、没到点的不发", async () => {
  const posts: UiUsageUpload[] = [];
  const post = async (body: UiUsageUpload) => { posts.push(structuredClone(body)); };
  await uploadUiUsage(post, "device-1", NOON);
  assert.equal(posts.length, 0, "什么都没点过");

  await recordUiUsage(["speak", "speak"], NOON - DAY);
  await recordUiUsage(["nav.words"], NOON);
  await uploadUiUsage(post, "device-1", NOON);
  assert.deepEqual(posts, [{ deviceId: "device-1", platform: "extension", days: { [dayKey(NOON - DAY)]: { "speak": 2 }, [dayKey(NOON)]: { "nav.words": 1 } } }]);
  const settled = await getUiUsage();
  assert.deepEqual([settled.pending, settled.nextUploadAt], [[], NOON + UPLOAD_EVERY_MS]);
  assert.equal(Object.keys(settled.days).length, 2, "传上去的还留在本机，设置页的表照样看得到");

  await recordUiUsage(["nav.words"], NOON + 1000);
  await uploadUiUsage(post, "device-1", NOON + 2000);
  assert.equal(posts.length, 1, "刚传过，攒着");
  await uploadUiUsage(post, "device-1", NOON + UPLOAD_EVERY_MS);
  assert.deepEqual(posts[1]!.days, { [dayKey(NOON)]: { "nav.words": 2 } }, "只发动过的那天，发的是累计数");
});

test("上传没成：待传的原样留着，一小时后再试；服务器没有这个接口就一天问一次；都不抛错", async () => {
  await recordUiUsage(["speak"], NOON);
  let calls = 0;
  const failing = (status?: number) => async () => { calls += 1; throw Object.assign(new Error("同步请求失败"), { status }); };
  await assert.doesNotReject(uploadUiUsage(failing(), "device-1", NOON));
  assert.deepEqual([(await getUiUsage()).pending, (await getUiUsage()).nextUploadAt], [[dayKey(NOON)], NOON + UPLOAD_RETRY_MS]);
  await uploadUiUsage(failing(), "device-1", NOON + UPLOAD_RETRY_MS - 1);
  assert.equal(calls, 1, "没到点不试");
  await uploadUiUsage(failing(404), "device-1", NOON + UPLOAD_RETRY_MS);
  assert.deepEqual([calls, (await getUiUsage()).nextUploadAt], [2, NOON + UPLOAD_RETRY_MS + UPLOAD_UNSUPPORTED_MS]);
  assert.deepEqual((await getUiUsage()).pending, [dayKey(NOON)]);
});
