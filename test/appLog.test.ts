import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AppError, ReaderFetch } from "../src/types.ts";
import {
  KEY_APP_ERROR,
  KEY_READER_FETCH,
  MAX_ERROR_ENTRIES,
  MAX_FETCH_ENTRIES,
  MAX_STACK_CHARS,
  MAX_TEXT_CHARS,
  getAppErrors,
  getFetchLog,
  recordAppError,
  recordFetch,
} from "../src/background/appLog.ts";

/** 与 llmLog.test.ts 同款内存 storage：深拷贝，暴露"改了没写回"这类错误。 */
function fakeArea() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys: string | string[] | null) {
      if (keys === null) return structuredClone(Object.fromEntries(data));
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
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

function fetchEntry(over: Partial<ReaderFetch> = {}): ReaderFetch {
  return {
    ts: 1,
    url: "https://example.com/a",
    finalUrl: "https://example.com/a",
    status: 200,
    contentType: "text/html; charset=utf-8",
    charset: "utf-8",
    charsetFrom: "header",
    bytes: 4096,
    bom: false,
    fellBack: false,
    replacementChars: 0,
    title: "标题",
    chars: 1200,
    error: null,
    ms: 320,
    ...over,
  };
}

function errorEntry(over: Partial<AppError> = {}): AppError {
  return {
    ts: 1,
    kind: "error",
    message: "x is not a function",
    at: "read.js:12:34",
    stack: "at main (read.js:12:34)",
    ...over,
  };
}

test("没有记录、或键被写坏，都读成空数组", async () => {
  assert.deepEqual(await getFetchLog(), []);
  assert.deepEqual(await getAppErrors(), []);
  await area.set({ [KEY_READER_FETCH]: "garbage", [KEY_APP_ERROR]: 7 });
  assert.deepEqual(await getFetchLog(), []);
  assert.deepEqual(await getAppErrors(), []);
});

test("抓取只留最近 MAX_FETCH_ENTRIES 条，丢最早的", async () => {
  for (let i = 0; i < MAX_FETCH_ENTRIES + 5; i++) await recordFetch(fetchEntry({ ts: i }));
  const log = await getFetchLog();
  assert.equal(log.length, MAX_FETCH_ENTRIES);
  assert.equal(log[0]?.ts, 5);
  assert.equal(log.at(-1)?.ts, MAX_FETCH_ENTRIES + 4);
});

test("错误只留最近 MAX_ERROR_ENTRIES 条", async () => {
  for (let i = 0; i < MAX_ERROR_ENTRIES + 3; i++) await recordAppError(errorEntry({ ts: i }));
  const log = await getAppErrors();
  assert.equal(log.length, MAX_ERROR_ENTRIES);
  assert.equal(log[0]?.ts, 3);
});

test("抓取记录里的长字段被截断，null 的还是 null", async () => {
  const long = "x".repeat(MAX_TEXT_CHARS + 200);
  await recordFetch(fetchEntry({ url: long, title: long, finalUrl: null, error: null }));
  const got = (await getFetchLog())[0];
  assert.ok(got);
  assert.ok(got.url.length < long.length);
  assert.ok(got.url.includes("已截断"));
  assert.ok(got.title?.includes("已截断"));
  assert.equal(got.finalUrl, null);
  assert.equal(got.error, null);
});

test("调用栈的上限比别的字段宽：切太短往往正好切掉出错的那一帧", async () => {
  const stack = "at f (a.js:1:1)".repeat(400);
  assert.ok(stack.length > MAX_STACK_CHARS);
  await recordAppError(errorEntry({ stack }));
  const got = (await getAppErrors())[0];
  assert.ok(got?.stack);
  assert.ok(got.stack.length > MAX_TEXT_CHARS);
  assert.ok(got.stack.includes("已截断"));
});

test("落盘失败不往外抛：日志是附属品，不能反过来把阅读器搞坏", async () => {
  area.set = async () => {
    throw new Error("配额满了");
  };
  await recordFetch(fetchEntry());
  await recordAppError(errorEntry());
});
