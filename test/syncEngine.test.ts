import { test, after } from "node:test";
import assert from "node:assert/strict";
import { foldOutbox, freshState, memoryDriver, installStorage, localStorage, withDataLock, type StateDriver } from "../src/sync/storage.ts";
import { mergeRecord, recordKey, validateRecord, type SyncRecord, type SyncOperation } from "../src/sync/protocol.ts";

const BASE = "https://sync.example.test";
const TOKEN_A = "private-device-token-user-a";
const TOKEN_B = "private-device-token-user-b";
const TOKEN_A2 = "private-second-device-token-user-a";
type Entry = { sequence: number; record: SyncRecord };
type Account = { head: number; records: Map<string, SyncRecord>; changes: Entry[]; operations: Map<string, string> };
interface RequestLog { url: string; method: string; headers: Headers; body: string; credentials?: RequestCredentials; redirect?: RequestRedirect }

/** HTTP-shaped transport fixture: the production client still builds every request and parses every response. */
class SyncServer {
  serverId = "server-one";
  pageSize = 2;
  offline = false;
  revoked = false;
  losePushAck = false;
  failSnapshotContinuation = false;
  malformedPull = false;
  rejectPush: string | undefined;
  /** A server older than the client has no usage endpoint at all. */
  supportsUsage = true;
  usage: Array<{ userId: string; body: { deviceId: string; platform: string; days: Record<string, Record<string, number>> } }> = [];
  afterSnapshotCreated: (() => void) | undefined;
  beforePullResponse: (() => void) | undefined;
  /** Runs after the server has committed a push and before the client hears about it. */
  beforePushResponse: (() => Promise<void>) | undefined;
  calls: RequestLog[] = [];
  accounts = new Map<string, Account>();
  snapshots = new Map<string, { userId: string; head: number; records: SyncRecord[] }>();
  account(userId = "user-a"): Account {
    let account = this.accounts.get(userId);
    if (!account) { account = { head: 0, records: new Map(), changes: [], operations: new Map() }; this.accounts.set(userId, account); }
    return account;
  }
  add(record: SyncRecord, userId = "user-a"): void {
    const account = this.account(userId);
    const key = recordKey(record);
    const merged = mergeRecord(account.records.get(key), validateRecord(record));
    if (JSON.stringify(account.records.get(key)) === JSON.stringify(merged)) return;
    account.records.set(key, merged);
    account.changes.push({ sequence: ++account.head, record: structuredClone(merged) });
  }
  async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : "";
    this.calls.push({ url: url.href, method, headers, body, credentials: init.credentials, redirect: init.redirect });
    if (this.offline) throw new TypeError("Network unavailable");
    const authorization = headers.get("authorization");
    const userId = authorization === `Bearer ${TOKEN_A}` || authorization === `Bearer ${TOKEN_A2}` ? "user-a"
      : authorization === `Bearer ${TOKEN_B}` ? "user-b" : undefined;
    if (this.revoked || !userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const account = this.account(userId);
    if (url.pathname === "/v1/info") return Response.json({ serverId: this.serverId, userId, protocol: 1 });
    if (url.pathname === "/v1/sync/snapshot") {
      let token = url.searchParams.get("token");
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      if (!token) {
        token = crypto.randomUUID();
        this.snapshots.set(token, { userId, head: account.head, records: structuredClone([...account.records.values()]) });
        this.afterSnapshotCreated?.();
        this.afterSnapshotCreated = undefined;
      } else if (this.failSnapshotContinuation) {
        this.failSnapshotContinuation = false;
        throw new TypeError("Snapshot connection interrupted");
      }
      const snapshot = this.snapshots.get(token);
      if (!snapshot || snapshot.userId !== userId) return Response.json({ error: "Snapshot expired" }, { status: 410 });
      const records = snapshot.records.slice(cursor, cursor + this.pageSize);
      return Response.json({ token, head: snapshot.head, records, cursor: cursor + records.length,
        hasMore: cursor + records.length < snapshot.records.length, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (url.pathname === "/v1/sync/pull") {
      const cursor = Number(url.searchParams.get("cursor"));
      if (this.malformedPull) return Response.json({ records: [], cursor, hasMore: true });
      const changes = account.changes.filter(entry => entry.sequence > cursor);
      const page = changes.slice(0, this.pageSize);
      this.beforePullResponse?.();
      return Response.json({ records: page.map(entry => entry.record), cursor: page.at(-1)?.sequence ?? cursor, hasMore: changes.length > page.length });
    }
    if (url.pathname === "/v1/sync/push" && method === "POST") {
      const request = JSON.parse(body) as { deviceId: string; operations: SyncOperation[] };
      // Production validates the whole batch first and rejects all of it over a single bad record.
      const refusal = this.rejectPush ?? request.operations.flatMap(operation => {
        try { validateRecord(operation.record); return []; } catch (error) { return [(error as Error).message]; }
      })[0];
      if (refusal) return Response.json({ error: "INVALID_REQUEST", message: refusal }, { status: 400 });
      const accepted: string[] = [];
      for (const operation of request.operations) {
        const previous = account.operations.get(operation.opId);
        const serialized = JSON.stringify(operation.record);
        if (previous && previous !== serialized) return Response.json({ error: "Operation identity reused" }, { status: 409 });
        if (!previous) { this.add(operation.record, userId); account.operations.set(operation.opId, serialized); }
        accepted.push(operation.opId);
      }
      const hook = this.beforePushResponse;
      this.beforePushResponse = undefined;
      await hook?.();
      if (this.losePushAck) { this.losePushAck = false; throw new TypeError("Connection lost after server commit"); }
      return Response.json({ accepted, head: account.head });
    }
    if (url.pathname === "/v1/usage" && method === "POST" && this.supportsUsage) {
      this.usage.push({ userId, body: JSON.parse(body) });
      return Response.json({ accepted: 1, ignored: 0 });
    }
    return Response.json({ error: "Unexpected endpoint" }, { status: 404 });
  }
}

let server = new SyncServer();
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => server.fetch(input, init);
// Production captures fetch at import time to bypass Android's text-only bridge.
const engine = await import("../src/sync/engine.ts");
after(async () => { await engine.disconnectSync(); globalThis.fetch = originalFetch; });

function device(userId = "user-a", token = TOKEN_A) {
  const state = freshState();
  state.config = { enabled: true, baseUrl: BASE, token, userId, serverId: "server-one" };
  const driver = memoryDriver(state);
  installStorage(driver);
  return driver;
}
function setting(id: string, value: unknown, counter = 1): SyncRecord {
  return validateRecord({ type: "setting", id, value, stamp: { counter, deviceId: "server-device" }, generation: "initial", deleted: false });
}
async function freshServer(): Promise<void> {
  // Clear the previous configureSync timer before switching the globally installed device.
  try { await engine.disconnectSync(); } catch { /* No device installed at the first test. */ }
  server = new SyncServer();
}

test("sync configuration binds identity, permits same-user token rotation, and keeps secrets out of visible status and business data", async () => {
  await freshServer();
  const driver = memoryDriver();
  installStorage(driver);
  await localStorage().set({ settings: { translateEnabled: true }, llm: { apiKey: "local-llm-key" } });
  const status = await engine.configureSync(BASE, TOKEN_A, true);
  assert.equal(status.userId, "user-a");
  assert.equal(status.tokenSet, true);
  assert.doesNotMatch(JSON.stringify(status), /private-device-token/);
  const stored = await driver.read();
  assert.equal(stored.config.token, TOKEN_A);
  assert.doesNotMatch(JSON.stringify(stored.data), /private-device-token/);
  assert.doesNotMatch(JSON.stringify(stored.outbox), /private-device-token|local-llm-key/);
  await assert.rejects(engine.configureSync(BASE, TOKEN_B, true), /另一个账号/);
  assert.equal((await driver.read()).config.token, TOKEN_A);
  await engine.configureSync(BASE, TOKEN_A2, true);
  assert.equal((await driver.read()).config.token, TOKEN_A2);
  const count = server.calls.length;
  await assert.rejects(engine.testSync("https://different.example.test"), /Token/);
  await assert.rejects(engine.testSync("https://user:pass@sync.example.test", TOKEN_A));
  assert.equal(server.calls.length, count);
  for (const request of server.calls) {
    assert.equal(request.credentials, "omit");
    assert.equal(request.redirect, "error");
    assert.doesNotMatch(request.url + request.body, /private-device-token|private-second-device-token|local-llm-key/);
  }
});

test("two complete local devices merge first snapshots and local edits, then converge through incremental push and pull", async () => {
  await freshServer();
  server.add(setting("translateEnabled", true));
  const desktop = device();
  await localStorage().set({ settings: { idleTimeoutMs: 43210 } });
  assert.equal((await engine.runSync()).error, null);
  assert.equal((await desktop.read()).outbox.length, 0);
  assert.equal((await desktop.read()).data.settings.translateEnabled, true);
  assert.ok(server.calls.some(request => request.url.includes("/sync/snapshot")));
  const phone = device("user-a", TOKEN_A2);
  await localStorage().set({ settings: { paragraphDwellMs: 987 } });
  assert.equal((await engine.runSync()).error, null);
  assert.equal((await phone.read()).data.settings.idleTimeoutMs, 43210);
  installStorage(desktop);
  const snapshotsBefore = server.calls.filter(request => request.url.includes("/sync/snapshot")).length;
  assert.equal((await engine.runSync()).error, null);
  assert.equal((await desktop.read()).data.settings.paragraphDwellMs, 987);
  assert.equal(server.calls.filter(request => request.url.includes("/sync/snapshot")).length, snapshotsBefore);
  assert.equal((await desktop.read()).cursor, server.account().head);
  assert.deepEqual((await desktop.read()).records, (await phone.read()).records);
  const otherUser = device("user-b", TOKEN_B);
  assert.equal((await engine.runSync()).error, null);
  assert.equal(Object.keys((await otherUser.read()).records).length, 0);
});

test("a paginated snapshot keeps its watermark while concurrent server writes are pulled afterward", async () => {
  await freshServer();
  server.pageSize = 1;
  server.add(setting("translateEnabled", true));
  server.add(setting("paragraphDwellMs", 123));
  server.add(setting("idleTimeoutMs", 456));
  server.afterSnapshotCreated = () => server.add(setting("paragraphDwellMs", 789, 4));
  const driver = device();
  assert.equal((await engine.runSync()).error, null);
  const state = await driver.read();
  assert.equal(state.data.settings.paragraphDwellMs, 789);
  assert.equal(state.cursor, 4);
  const snapshotCalls = server.calls.filter(request => request.url.includes("/sync/snapshot"));
  assert.equal(snapshotCalls.length, 3);
  assert.ok(snapshotCalls.slice(1).every(request => new URL(request.url).searchParams.has("token")));
  const firstPull = server.calls.find(request => request.url.includes("/sync/pull"));
  assert.equal(new URL(firstPull!.url).searchParams.get("cursor"), "3");
});

test("an interrupted first snapshot resumes its saved page instead of marking incomplete data as synchronized", async () => {
  await freshServer();
  server.pageSize = 1;
  server.add(setting("translateEnabled", true));
  server.add(setting("paragraphDwellMs", 234));
  server.add(setting("idleTimeoutMs", 567));
  server.failSnapshotContinuation = true;
  const driver = device();
  const first = await engine.runSync();
  assert.match(first.error ?? "", /Snapshot connection interrupted/);
  const interrupted = await driver.read();
  assert.equal(interrupted.cursor, 0);
  assert.equal(interrupted.snapshot?.cursor, 1);
  assert.notEqual(interrupted.initializedRemote, true);
  assert.equal((await engine.runSync()).error, null);
  const final = await driver.read();
  assert.equal(final.cursor, 3);
  assert.equal(final.snapshot, undefined);
  assert.equal(final.initializedRemote, true);
  assert.equal(server.snapshots.size, 1);
});

test("an upload committed before acknowledgement loss is retried with the original operation identity and counted once", async () => {
  await freshServer();
  const driver = device();
  await localStorage().set({ sessions: [{ id: "session-one", articleId: "https://article.test/read", startTs: 1000, endTs: 5000, wordsRead: 20, endReason: "hidden" }] });
  const ids = (await driver.read()).outbox.map(operation => operation.opId);
  server.losePushAck = true;
  const first = await engine.runSync();
  assert.match(first.error ?? "", /Connection lost after server commit/);
  assert.deepEqual((await driver.read()).outbox.map(operation => operation.opId), ids);
  assert.equal(server.account().head, 1);
  assert.equal((await engine.runSync()).error, null);
  assert.equal(server.account().head, 1);
  assert.equal(server.account().operations.size, 1);
  assert.equal((await driver.read()).data.sessions.length, 1);
  assert.equal((await driver.read()).outbox.length, 0);
  const pushes = server.calls.filter(request => request.url.includes("/sync/push"));
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0]!.body, pushes[1]!.body);
});

test("pausing while offline is entirely local and preserves queued edits; a revoked token stops automatic synchronization", async () => {
  await freshServer();
  const driver = device();
  await localStorage().set({ settings: { paragraphDwellMs: 321 } });
  server.offline = true;
  const count = server.calls.length;
  const status = await engine.configureSync(BASE, undefined, false);
  assert.equal(status.enabled, false);
  assert.equal((await engine.runSync()).enabled, false);
  assert.equal(server.calls.length, count);
  assert.equal((await driver.read()).outbox.length, 1);
  await assert.rejects(engine.syncRequest("/v1/blobs/" + "a".repeat(64)), /启用同步/);
  assert.equal(server.calls.length, count);
  server.offline = false;
  await driver.update(state => { state.config.enabled = true; });
  server.revoked = true;
  const unauthorized = await engine.runSync();
  assert.equal(unauthorized.enabled, false);
  assert.match(unauthorized.error ?? "", /Token/);
  assert.equal((await driver.read()).outbox.length, 1);
  const failedRequests = server.calls.length;
  await engine.runSync();
  assert.equal(server.calls.length, failedRequests);
});

test("server identity changes and a nonadvancing pull page preserve local operations and stop the cycle", async () => {
  await freshServer();
  const driver = device();
  await localStorage().set({ settings: { paragraphDwellMs: 111 } });
  server.serverId = "replacement-server";
  assert.match((await engine.runSync()).error ?? "", /身份/);
  assert.equal(server.calls.filter(request => request.method === "POST").length, 0);
  server.serverId = "server-one";
  server.malformedPull = true;
  assert.match((await engine.runSync()).error ?? "", /游标没有前进/);
  assert.equal((await driver.read()).outbox.length, 1);
  assert.equal(server.calls.filter(request => request.method === "POST").length, 0);
});

test("clearing the local profile after the last identity check cannot reintroduce the former account's pulled data", async () => {
  await freshServer();
  server.add(setting("translateEnabled", true));
  const base = device();
  await base.update(state => { state.initializedRemote = true; });
  let resetAtNextRead = false;
  let reset: Promise<void> = Promise.resolve();
  const raced: StateDriver = {
    async read() {
      const before = await base.read();
      if (resetAtNextRead) {
        resetAtNextRead = false;
        reset = withDataLock(async () => { await base.update(state => { Object.assign(state, freshState()); }); });
      }
      return before;
    },
    update: fn => base.update(fn),
  };
  installStorage(raced);
  server.beforePullResponse = () => { resetAtNextRead = true; };
  await engine.runSync();
  await reset;
  const state = await base.read();
  assert.equal(state.config.userId, undefined);
  assert.equal(state.data.settings?.translateEnabled, undefined);
  assert.equal(Object.keys(state.records).length, 0);
  assert.equal(state.cursor, 0);
});

const article = (url: string, extra: Record<string, unknown> = {}) => ({
  id: url, url, title: "An article", totalWords: 900, trackedWords: 800, paragraphCount: 12,
  firstSeenTs: 1_000, lastSeenTs: 2_000, reachedBottom: false, finished: false, finishedTs: null, ...extra,
});
const session = (id: string, articleId: string) => ({ id, articleId, startTs: 1_000, endTs: 2_000, wordsRead: 40 });

test("a record that fails validation stays queued with its article's dependents, and everything else still uploads", async () => {
  await freshServer();
  const driver = device();
  const bad = "https://corrupt.example/wrong-identity", good = "https://fine.example/post";
  // Stored under one address while claiming another: nothing can be filled in to make this whole.
  await localStorage().set({
    articles: { [bad]: article(bad, { id: "https://elsewhere.example/" }), [good]: article(good) },
    sessions: [session("s-bad", bad), session("s-good", good)],
    settings: { idleTimeoutMs: 45_000 },
  });
  const queued = (await driver.read()).outbox.length;

  const status = await engine.runSync();
  assert.equal(status.error, null);
  assert.notEqual(status.lastSuccess, null);
  assert.equal(status.blocked, 2);
  assert.equal(status.pending, 2);
  // Told by reading material: which one is stuck, why, and what it holds back with it.
  assert.equal(status.blockedMaterials, 1);
  assert.deepEqual(status.blockedReasons, [`《An article》${bad}：文章记录：Entity identity mismatch；名下 1 个专注时段一起留在本机`]);
  assert.deepEqual(await engine.materialSync(bad), { state: "blocked", waiting: [["文章记录", 1], ["专注时段", 1]], reasons: ["文章记录：Entity identity mismatch"] });
  assert.deepEqual(await engine.materialSync(good), { state: "synced", waiting: [], reasons: [] });
  assert.equal((await engine.materialSync("https://never.example/seen")).state, "local");
  const uploaded = [...server.account().records.values()].map(record => `${record.type} ${record.id}`).sort();
  assert.deepEqual(uploaded, [`article ${good}`, "session s-good", "setting idleTimeoutMs"]);
  assert.ok(queued > 2);
  // Never sent, so the server never had the chance to refuse the batch.
  assert.equal(server.calls.some(call => call.body.includes("corrupt.example")), false);
  assert.deepEqual((await driver.read()).outbox.map(op => op.record.id).sort(), [bad, "s-bad"].sort());

  // Kept rather than dropped: once the record is whole, the next round carries it and its dependents.
  await localStorage().set({ articles: { [bad]: article(bad, { lastSeenTs: 3_000 }), [good]: article(good) } });
  const healed = await engine.runSync();
  assert.equal(healed.error, null);
  assert.equal(healed.blocked, 0);
  assert.deepEqual(healed.blockedReasons, []);
  assert.equal(healed.pending, 0);
  assert.ok(server.account().records.has(recordKey({ type: "article", id: bad })));
  assert.ok(server.account().records.has(recordKey({ type: "session", id: "s-bad" })));
});

test("repeated edits to a record that cannot upload leave one queued operation, not one per edit", async () => {
  await freshServer();
  const driver = device();
  const bad = "https://corrupt.example/still-reading";
  for (const lastSeenTs of [2_000, 3_000, 4_000]) await localStorage().set({ articles: { [bad]: article(bad, { id: "https://elsewhere.example/", lastSeenTs }) } });
  // Superseded attempts are dropped as they are queued, so a device that never syncs does not pile them up either.
  assert.equal((await driver.read()).outbox.length, 1);
  const status = await engine.runSync();
  assert.equal(status.blocked, 1);
  const left = (await driver.read()).outbox;
  assert.equal(left.length, 1);
  assert.equal((left[0]!.record.value as { lastSeenTs: number }).lastSeenTs, 4_000);
});

test("a refusal the local check did not foresee reports the server's reason, not only its error class", async () => {
  await freshServer();
  const driver = device();
  await localStorage().set({ settings: { idleTimeoutMs: 45_000 } });
  server.rejectPush = "Invalid snippet";
  const status = await engine.runSync();
  assert.match(status.error ?? "", /400/);
  assert.match(status.error ?? "", /INVALID_REQUEST · Invalid snippet/);
  assert.equal((await driver.read()).outbox.length, 1);
});

test("an article imported from an old export without its later fields is completed before it is queued", async () => {
  await freshServer();
  const driver = device();
  const url = "https://legacy.example/imported";
  // lib/merge.ts admits any article with an id and lastSeenTs, so this is what an old export leaves behind.
  await localStorage().set({ articles: { [url]: { id: url, url, title: "Imported", totalWords: 900, firstSeenTs: 1_000, lastSeenTs: 2_000 } } });
  const status = await engine.runSync();
  assert.equal(status.error, null);
  assert.equal(status.blocked, 0);
  assert.equal((await driver.read()).outbox.length, 0);
  const value = server.account().records.get(recordKey({ type: "article", id: url }))!.value as Record<string, unknown>;
  assert.deepEqual([value.trackedWords, value.paragraphCount, value.finished, value.reachedBottom], [0, 0, false, false]);
  assert.equal(value.totalWords, 900);
});

test("an incomplete article queued by an earlier client is repaired in place and released with its dependents", async () => {
  await freshServer();
  const driver = device();
  const url = "https://legacy.example/already-queued";
  const raw = { id: url, url, title: "Queued long ago", totalWords: 900, firstSeenTs: 1_000, lastSeenTs: 2_000 };
  const stamp = { counter: 0, deviceId: "this-device" };
  const stale: SyncRecord = { type: "article", id: url, value: raw, stamp, deleted: false, generation: "initial" };
  const child: SyncRecord = { type: "session", id: "s-queued", value: session("s-queued", url), stamp, deleted: false, generation: "initial", articleId: url };
  await driver.update(state => {
    state.data.articles = { [url]: raw };
    state.data.sessions = [session("s-queued", url)];
    for (const record of [stale, child]) state.records[recordKey(record)] = record;
    state.outbox = [{ opId: "stale-article-op", record: stale }, { opId: "child-op", record: child }];
  });
  assert.throws(() => validateRecord(stale), /Invalid article: trackedWords, paragraphCount, finished, reachedBottom/);

  const status = await engine.runSync();
  assert.equal(status.error, null);
  assert.equal(status.blocked, 0);
  assert.equal(status.pending, 0);
  assert.ok(server.account().records.has(recordKey({ type: "session", id: "s-queued" })));
  // The payload changed, so it must not travel under the operation id the old payload was queued with.
  assert.equal(server.account().operations.has("stale-article-op"), false);
  const local = (await driver.read()).data.articles[url];
  assert.deepEqual([local.trackedWords, local.paragraphCount, local.finished, local.reachedBottom], [0, 0, false, false]);
  assert.equal(local.title, "Queued long ago");
});

test("a reading material reports what of its own is still waiting, counting the words looked up in it", async () => {
  await freshServer();
  const driver = device();
  const url = "https://fine.example/material";
  await localStorage().set({ articles: { [url]: article(url) }, sessions: [session("s-1", url)] });
  assert.equal((await engine.runSync()).error, null);
  assert.equal((await engine.materialSync(url)).state, "synced");

  server.offline = true;
  await localStorage().set({
    sessions: [session("s-1", url), session("s-2", url)],
    snippets: [{ id: "w-1", articleId: url, url, articleTitle: "An article", text: "consolidate", kind: "word", context: "to consolidate memory",
      createdTs: 3_000, translation: "巩固", contextNote: "", pos: null, phonetic: null, lemma: "consolidate", usage: null, vocab: [], cardId: null }],
  });
  // A looked-up word is not the article's dependent on the wire, but it was looked up in it.
  assert.deepEqual(await engine.materialSync(url), { state: "pending", waiting: [["专注时段", 1], ["划词", 1]], reasons: [] });
  assert.equal((await driver.read()).outbox.find(op => op.record.type === "snippet")?.record.articleId, undefined);
  server.offline = false;

  await engine.disconnectSync();
  assert.equal((await engine.materialSync(url)).state, "local");
});

test("button counts ride along a successful cycle without entering the sync log, and an old server costs nothing but the counts staying queued", async () => {
  await freshServer();
  const driver = device();
  const usage = await import("../src/background/uiUsage.ts");
  let scheduled = 0;
  const { onLocalMutation } = await import("../src/sync/storage.ts");
  onLocalMutation(() => { scheduled++; });
  await usage.recordUiUsage(["articles.detail", "articles.detail", "not-an-event"]);
  const stored = await driver.read();
  assert.deepEqual(Object.values(stored.data[usage.KEY_UI_USAGE].days), [{ "articles.detail": 2 }]);
  assert.equal(stored.outbox.length, 0, "counters are not sync records");
  assert.equal(scheduled, 0, "a click must not schedule a sync cycle of its own");

  const status = await engine.runSync();
  assert.equal(status.error, null);
  assert.equal(server.usage.length, 1);
  assert.equal(server.usage[0]!.userId, "user-a");
  assert.deepEqual(server.usage[0]!.body, { deviceId: stored.deviceId, platform: "extension", days: stored.data[usage.KEY_UI_USAGE].days });
  const sent = server.calls.find(call => call.url.endsWith("/v1/usage"))!;
  assert.equal(sent.headers.get("authorization"), `Bearer ${TOKEN_A}`);
  assert.deepEqual((await usage.getUiUsage()).pending, []);
  assert.equal(scheduled, 0, "neither does the upload's own bookkeeping");
  await engine.runSync();
  assert.equal(server.usage.length, 1, "nothing new, nothing sent");

  // A server without the endpoint: the cycle still succeeds and the day stays queued for a later attempt.
  await freshServer();
  server.supportsUsage = false;
  const old = device();
  await usage.recordUiUsage(["speak"]);
  const outcome = await engine.runSync();
  assert.equal(outcome.error, null, "a missing usage endpoint is not a sync failure");
  assert.ok(outcome.lastSuccess);
  const kept = (await old.read()).data[usage.KEY_UI_USAGE];
  assert.equal(kept.pending.length, 1);
  assert.ok(kept.nextUploadAt > Date.now() + usage.UPLOAD_RETRY_MS, "asks a server that lacks it once a day, not once an hour");
  await engine.runSync();
  assert.equal(server.calls.filter(call => call.url.endsWith("/v1/usage")).length, 1);

  // A cycle that fails never gets as far as uploading counts.
  await freshServer();
  server.offline = true;
  device();
  await usage.recordUiUsage(["speak"]);
  assert.ok((await engine.runSync()).error);
  assert.equal(server.calls.some(call => call.url.endsWith("/v1/usage")), false);
  onLocalMutation(() => undefined);
});

// ---- folding queued operations ----

const foreign = (record: Omit<SyncRecord, "stamp" | "deleted" | "generation">, counter: number): SyncRecord =>
  validateRecord({ ...record, stamp: { counter, deviceId: "other-device" }, deleted: false, generation: "initial" });
const canonicalRecords = (records: Iterable<SyncRecord>): string[] => [...records].map(record => JSON.stringify(record, (_key, value) =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1)) : value)).sort();
/** Same seed, same edits: both runs below must start from identical devices, down to the device id inside every stamp. */
function namedDevice(deviceId: string) {
  const state = freshState();
  state.deviceId = deviceId;
  state.config = { enabled: true, baseUrl: BASE, token: TOKEN_A, userId: "user-a", serverId: "server-one" };
  const driver = memoryDriver(state);
  installStorage(driver);
  return driver;
}
function random(seed: number): () => number {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const URLS = ["https://fold.example/one", "https://fold.example/two"];
/** One local edit through the same storage calls the app makes. Values go down as well as up: finished flags are cleared, sessions shrink, clocks run backwards. */
async function randomEdit(next: () => number): Promise<void> {
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)]!;
  const data = await localStorage().get(null) as Record<string, any>;
  const url = pick(URLS), articles = { ...data.articles } as Record<string, unknown>, step = Math.floor(next() * 9);
  if (step === 0 && articles[url]) { delete articles[url]; await localStorage().set({ articles, deletedArticles: { ...data.deletedArticles, [url]: 1 } }); return; }
  if (step <= 2 || !articles[url]) {
    const deletedArticles = { ...data.deletedArticles }; delete deletedArticles[url];
    articles[url] = article(url, { title: pick(["Draft", "Final", "Retitled"]), lastSeenTs: 1_000 + Math.floor(next() * 9_000), reachedBottom: next() < 0.5, finished: next() < 0.5 });
    await localStorage().set({ articles, deletedArticles }); return;
  }
  if (step === 3) { await localStorage().set({ [`pos:${url}`]: { articleId: url, hash: pick(["h1", "h2", "h3"]), index: Math.floor(next() * 12), offset: next(), paragraphCount: 12, savedTs: Math.floor(next() * 9_000) } }); return; }
  if (step === 4) {
    const list = [...(data[`p:${url}`] ?? [])] as Array<Record<string, any>>, hash = pick(["h1", "h2", "h3"]), at = list.findIndex(item => item.hash === hash);
    if (at < 0) list.push({ hash, index: list.length, words: 40, firstSeenTs: 1_000 + Math.floor(next() * 500), dwellMs: Math.floor(next() * 400) });
    else list[at] = { ...list[at], dwellMs: list[at]!.dwellMs + Math.floor(next() * 400) };
    await localStorage().set({ [`p:${url}`]: list }); return;
  }
  if (step === 5) {
    const id = pick(["s1", "s2"]), sessions = (data.sessions ?? []).filter((item: { id: string }) => item.id !== id);
    await localStorage().set({ sessions: [...sessions, { id, articleId: url, startTs: 1_000, endTs: 1_500 + Math.floor(next() * 4_000), wordsRead: Math.floor(next() * 90) }] }); return;
  }
  if (step === 6) { await localStorage().set({ settings: { ...data.settings, idleTimeoutMs: 30_000 + Math.floor(next() * 5) * 1_000, translateEnabled: next() < 0.5 } }); return; }
  const id = pick(["n1", "n2"]), snippets = (data.snippets ?? []).filter((item: { id: string }) => item.id !== id);
  if (step === 7 && snippets.length !== (data.snippets ?? []).length) { await localStorage().set({ snippets }); return; }
  await localStorage().set({ snippets: [...snippets, { id, articleId: url, url, articleTitle: "An article", text: pick(["leak", "seep"]), kind: "word", context: "Every abstraction leaks.", translation: "泄漏", contextNote: pick(["", "暴露细节"]), createdTs: Math.floor(next() * 9_000), vocab: [] }] });
}
/** What another device left on the server before this one connected, overlapping the records edited below. */
function seedServer(): void {
  server.add(foreign({ type: "article", id: URLS[0]!, value: article(URLS[0]!, { finished: true, finishedTs: 8_000, lastSeenTs: 9_500 }) }, 5));
  server.add(foreign({ type: "paragraph", id: JSON.stringify([URLS[0], "h1"]), articleId: URLS[0], value: { articleId: URLS[0], hash: "h1", index: 0, words: 40, firstSeenTs: 900, dwell: { "other-device": 700 } } }, 6));
  server.add(foreign({ type: "position", id: URLS[1]!, articleId: URLS[1], value: { articleId: URLS[1], hash: "h2", index: 3, offset: 0.5, paragraphCount: 12, savedTs: 7_000 } }, 7));
  server.add(foreign({ type: "setting", id: "idleTimeoutMs", value: 99_000 }, 8));
}

test("edits folded while offline leave the server and the device exactly where syncing after every edit would", async () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const run = async (everyEdit: boolean) => {
      await freshServer();
      seedServer();
      const driver = namedDevice("device-under-test");
      assert.equal((await engine.runSync()).error, null);
      const next = random(seed);
      for (let edit = 0; edit < 70; edit++) {
        await randomEdit(next);
        if (everyEdit) assert.equal((await engine.runSync()).error, null);
      }
      const queued = (await driver.read()).outbox;
      assert.equal(new Set(queued.map(op => recordKey(op.record))).size, queued.length, "at most one queued operation per record");
      const final = await engine.runSync();
      assert.deepEqual([final.error, final.pending, final.blocked], [null, 0, 0]);
      const account = server.account(), state = await driver.read();
      const pushed = server.calls.filter(call => call.url.endsWith("/v1/sync/push")).reduce((n, call) => n + JSON.parse(call.body).operations.length, 0);
      return { server: canonicalRecords(account.records.values()), device: canonicalRecords(Object.values(state.records)), changes: account.changes.length, pushed };
    };
    const stepwise = await run(true), folded = await run(false);
    assert.deepEqual(folded.server, stepwise.server, `seed ${seed}: server records`);
    assert.deepEqual(folded.device, stepwise.device, `seed ${seed}: device records`);
    assert.deepEqual(folded.device, folded.server, `seed ${seed}: the device converges on what the server holds`);
    assert.ok(folded.pushed <= folded.server.length, `seed ${seed}: one upload per record at most, got ${folded.pushed}`);
    assert.ok(folded.pushed < stepwise.pushed / 2 && folded.changes < stepwise.changes, `seed ${seed}: ${folded.pushed} uploads against ${stepwise.pushed}`);
  }
});

test("an edit that lands while its record is uploading, or after a lost acknowledgement, is sent again under a new operation id", async () => {
  await freshServer();
  const driver = namedDevice("device-in-flight");
  const url = URLS[0]!, key = recordKey({ type: "article", id: url });
  await localStorage().set({ articles: { [url]: article(url, { finished: true, finishedTs: 2_000 }) } });
  const first = (await driver.read()).outbox[0]!.opId;
  // The server has committed the first version; the second is written before the client learns that.
  server.beforePushResponse = () => localStorage().set({ articles: { [url]: article(url, { title: "Edited mid-flight", finished: false, lastSeenTs: 1_500 }) } });
  const status = await engine.runSync();
  assert.deepEqual([status.error, status.pending], [null, 0], "the same cycle goes round again for what arrived meanwhile");
  const sent = server.calls.filter(call => call.url.endsWith("/v1/sync/push")).map(call => JSON.parse(call.body).operations as SyncOperation[]);
  assert.deepEqual(sent.map(operations => operations.length), [1, 1]);
  assert.equal(sent[0]![0]!.opId, first);
  assert.notEqual(sent[1]![0]!.opId, first, "the folded operation never reuses an id the server may already hold");
  const merged = server.account().records.get(key)!.value as Record<string, unknown>;
  assert.deepEqual([merged.title, merged.finished, merged.lastSeenTs], ["Edited mid-flight", true, 2_000]);
  assert.deepEqual(canonicalRecords([server.account().records.get(key)!]), canonicalRecords([(await driver.read()).records[key]!]));

  server.losePushAck = true;
  await localStorage().set({ articles: { [url]: article(url, { title: "Committed, never acknowledged", lastSeenTs: 3_000 }) } });
  assert.match((await engine.runSync()).error ?? "", /Connection lost/);
  await localStorage().set({ articles: { [url]: article(url, { title: "Edited after the lost acknowledgement", lastSeenTs: 2_500 }) } });
  assert.equal((await driver.read()).outbox.length, 1);
  await driver.update(state => { state.retryAt = 0; });
  const recovered = await engine.runSync();
  assert.deepEqual([recovered.error, recovered.pending], [null, 0]);
  const settled = server.account().records.get(key)!.value as Record<string, unknown>;
  assert.deepEqual([settled.title, settled.finished, settled.lastSeenTs], ["Edited after the lost acknowledgement", true, 3_000]);
  assert.deepEqual(canonicalRecords(server.account().records.values()), canonicalRecords(Object.values((await driver.read()).records)));
});

test("folding keeps queue order and untouched ids, drops superseded invalid operations and leaves a trailing one for triage", async () => {
  const url = URLS[0]!, other = URLS[1]!;
  const local = (record: Record<string, unknown>, counter: number) => ({ generation: "initial", deleted: false, ...record, stamp: { counter, deviceId: "device-fold" } }) as unknown as SyncRecord;
  const position = (savedTs: number, counter: number) => local({ type: "position", id: url, articleId: url, value: { articleId: url, hash: "h1", index: 1, offset: 0, paragraphCount: 12, savedTs } }, counter);
  const state = freshState();
  state.outbox = [
    { opId: "article-1", record: local({ type: "article", id: url, value: article(url, { finished: true, finishedTs: 2_000 }) }, 1) },
    { opId: "position-1", record: position(10, 2) },
    { opId: "lone-setting", record: local({ type: "setting", id: "idleTimeoutMs", value: 45_000 }, 3) },
    { opId: "broken-then-fixed", record: local({ type: "article", id: other, value: { id: "https://elsewhere.example/" } }, 4) },
    { opId: "position-2", record: position(30, 5) },
    { opId: "article-2", record: local({ type: "article", id: url, value: article(url, { title: "Later", lastSeenTs: 1_200 }) }, 6) },
    { opId: "fixed", record: local({ type: "article", id: other, value: article(other) }, 7) },
    { opId: "position-3", record: position(20, 8) },
    { opId: "still-broken", record: local({ type: "session", id: "s-broken", articleId: url, value: { id: "s-broken", articleId: url, startTs: 9, endTs: 1, wordsRead: 0 } }, 9) },
  ];
  assert.equal(foldOutbox(state), 4);
  assert.deepEqual(state.outbox.map(op => `${op.record.type}:${op.record.stamp.counter}`), ["article:6", "position:8", "setting:3", "article:7", "session:9"]);
  const ids = state.outbox.map(op => op.opId);
  assert.deepEqual([ids[2], ids[3], ids[4]], ["lone-setting", "fixed", "still-broken"], "an operation that was not combined keeps the id the server may already know");
  assert.ok(!ids.slice(0, 2).some(id => /^(article|position)-/.test(id)));
  const folded = state.outbox[0]!.record.value as Record<string, unknown>;
  assert.deepEqual([folded.title, folded.finished, folded.finishedTs, folded.lastSeenTs], ["Later", true, 2_000, 2_000], "combined with mergeRecord, not replaced by the last edit");
  assert.equal((state.outbox[1]!.record.value as { savedTs: number }).savedTs, 20);
  assert.equal(foldOutbox(state), 0);
  assert.deepEqual(state.outbox.map(op => op.opId), ids, "folding a folded queue changes nothing");

  // Only the named records are touched when keys are given.
  const partial = freshState();
  partial.outbox = [{ opId: "a", record: position(1, 1) }, { opId: "b", record: position(2, 2) }, { opId: "c", record: local({ type: "setting", id: "idleTimeoutMs", value: 1 }, 3) }, { opId: "d", record: local({ type: "setting", id: "idleTimeoutMs", value: 2 }, 4) }];
  assert.equal(foldOutbox(partial, new Set([recordKey({ type: "setting", id: "idleTimeoutMs" })])), 1);
  assert.deepEqual(partial.outbox.map(op => op.opId).slice(0, 2), ["a", "b"]);
});

test("a queue bloated by an earlier client is folded on the next local edit even if this device never syncs", async () => {
  await freshServer();
  const url = URLS[0]!;
  const state = freshState();
  state.deviceId = "device-never-synced";
  const driver = memoryDriver(state);
  installStorage(driver);
  await localStorage().set({ articles: { [url]: article(url) } });
  // What the previous client left behind: one operation per save of the same reading position.
  await driver.update(current => {
    for (let save = 1; save <= 300; save++) {
      const record = validateRecord({ type: "position", id: url, articleId: url, generation: "initial", deleted: false, stamp: { counter: ++current.counter, deviceId: current.deviceId },
        value: { articleId: url, hash: "h1", index: save % 12, offset: 0, paragraphCount: 12, savedTs: save } });
      current.records[recordKey(record)] = mergeRecord(current.records[recordKey(record)], record);
      current.outbox.push({ opId: `legacy-${save}`, record });
    }
  });
  assert.equal((await driver.read()).outbox.length, 301);
  await localStorage().set({ settings: { idleTimeoutMs: 45_000 } });
  const after = await driver.read();
  assert.deepEqual(after.outbox.map(op => op.record.type), ["article", "position", "setting"]);
  assert.deepEqual(after.outbox[1]!.record, after.records[recordKey({ type: "position", id: url })]);
  for (let save = 0; save < 50; save++) await localStorage().set({ [`pos:${url}`]: { articleId: url, hash: "h2", index: 2, offset: 0, paragraphCount: 12, savedTs: 1_000 + save } });
  assert.equal((await driver.read()).outbox.length, 3, "and it stays one operation per record from then on");
  assert.equal(server.calls.length, 0);
});

test("a cycle with nothing to upload checks identity and downloads once; the closing download only follows an upload", async () => {
  await freshServer();
  device();
  assert.equal((await engine.runSync()).error, null);
  const paths = () => server.calls.map(call => `${call.method} ${new URL(call.url).pathname}`);
  assert.deepEqual(paths(), ["GET /v1/info", "GET /v1/sync/snapshot", "GET /v1/sync/pull"]);
  server.calls = [];
  assert.equal((await engine.runSync()).error, null);
  assert.deepEqual(paths(), ["GET /v1/info", "GET /v1/sync/pull"]);
  server.calls = [];
  await localStorage().set({ settings: { idleTimeoutMs: 45_000 } });
  const status = await engine.runSync();
  assert.deepEqual([status.error, status.pending], [null, 0]);
  assert.deepEqual(paths(), ["GET /v1/info", "GET /v1/sync/pull", "POST /v1/sync/push", "GET /v1/sync/pull"]);
  assert.equal((await syncDriverCursor()), server.account().head, "the closing download moves the cursor past this device's own upload");
});
async function syncDriverCursor(): Promise<number> { return (await (await import("../src/sync/storage.ts")).syncDriver().read()).cursor; }

test("reading on the computer, then opening the same article on the phone: the phone asks the server first and lands on the computer's position", async () => {
  await freshServer();
  const { handle } = await import("../src/background/handle.ts");
  const ephemeral: Record<string, unknown> = {};
  const g = globalThis as Record<string, any>;
  const prior = g["chrome"];
  g["chrome"] = { storage: { session: {
    get: async (key: string) => structuredClone({ [key]: ephemeral[key] }),
    set: async (values: Record<string, unknown>) => { Object.assign(ephemeral, structuredClone(values)); },
  } } };
  const id = "https://example.com/long-read";
  const meta = { articleId: id, url: id, title: "Long read", totalWords: 900, trackedWords: 900, paragraphCount: 30, expectedMs: 240_000 };
  const position = (hash: string, index: number, offset: number, savedTs: number) => ({ articleId: id, hash, index, offset, paragraphCount: 30, savedTs });
  const localState = async () => (await handle({ type: "article:local-state", articleId: id }, {}) as Record<string, any>)[`pos:${id}`];
  try {
    // The phone read a little of it last week and is up to date with the server.
    const phone = device("user-a", TOKEN_A2);
    await handle({ type: "article:meta", meta }, { tab: { id: 7 } });
    await handle({ type: "session:start", articleId: id, url: id, title: "Long read", startTs: 1_000 }, { tab: { id: 7 } });
    await handle({ type: "session:heartbeat", articleId: id, now: 6_000, wordsRead: 40, position: position("para-3", 3, 20, 6_000) }, { tab: { id: 7 } });
    assert.equal((await engine.runSync()).error, null);

    // Today, on the computer: further into the same article. Heartbeats push within seconds.
    const desktop = device("user-a", TOKEN_A);
    assert.equal((await engine.runSync()).error, null);
    assert.equal((await localState()).hash, "para-3", "the computer starts from where the phone stopped");
    await handle({ type: "session:start", articleId: id, url: id, title: "Long read", startTs: 100_000 }, { tab: { id: 1 } });
    await handle({ type: "session:heartbeat", articleId: id, now: 105_000, wordsRead: 300, position: position("para-17", 17, 64, 105_000) }, { tab: { id: 1 } });
    assert.equal((await engine.runSync()).error, null);
    assert.equal((await desktop.read()).outbox.length, 0);

    // Back on the phone. Its last pull predates the computer's session.
    installStorage(phone);
    await phone.update(state => { state.lastSuccess = Date.now() - 5 * 60_000; });
    assert.equal((await phone.read()).data[`pos:${id}`].hash, "para-3", "what the phone would have jumped to without asking");
    const before = server.calls.length;
    const resumed = await localState();
    assert.deepEqual([resumed.hash, resumed.index, resumed.offset], ["para-17", 17, 64]);
    assert.ok(server.calls.slice(before).some(call => call.url.includes("/v1/sync/pull")));

    // Just synchronised: opening the next article does not run another cycle.
    const quiet = server.calls.length;
    await localState();
    assert.equal(server.calls.length, quiet);

    // No network: the article still opens, promptly, on the position this device has.
    await phone.update(state => { state.lastSuccess = Date.now() - 5 * 60_000; });
    server.offline = true;
    const started = Date.now();
    assert.equal((await localState()).hash, "para-17");
    assert.ok(Date.now() - started < 2_000);
    // Backing off after that failure: the next open does not even try.
    const tried = server.calls.length;
    await localState();
    assert.equal(server.calls.length, tried);
  } finally { if (prior === undefined) delete g["chrome"]; else g["chrome"] = prior; }
});

test("a slow server delays opening an article by a bounded wait, never by the whole cycle", async () => {
  await freshServer();
  const phone = device();
  await phone.update(state => { state.lastSuccess = Date.now() - 60_000; state.initializedRemote = true; });
  let release: (() => void) | undefined;
  server.beforePullResponse = () => undefined;
  const realFetch = server.fetch.bind(server);
  server.fetch = async (input, init) => { await new Promise<void>(resolve => { release = resolve; setTimeout(resolve, 400); }); return realFetch(input, init); };
  const started = Date.now();
  await engine.syncBefore(80);
  assert.ok(Date.now() - started < 350, "gave up waiting while the first request was still in flight");
  release?.();
  // The cycle it started still finishes in the background and is not run twice.
  assert.equal((await engine.runSync()).error, null);
});
