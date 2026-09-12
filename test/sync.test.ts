import { test } from "node:test";
import assert from "node:assert/strict";
import type { Article, ParagraphRecord, Session, Snippet, StoredCard } from "../src/types.ts";
import { DEFAULT_LLM, DEFAULT_SETTINGS } from "../src/types.ts";
import { gradeCard, newCard } from "../src/lib/review.ts";
import { mergeRecord, recordKey, validateRecord } from "../src/sync/protocol.ts";
import type { SyncRecord } from "../src/sync/protocol.ts";
import { applyRemote, freshState, installStorage, localStorage, memoryDriver, trackChanges, withDataLock } from "../src/sync/storage.ts";
import type { StateDriver } from "../src/sync/storage.ts";
import { configureSync, disconnectSync, normalizeServerUrl, syncStatus } from "../src/sync/engine.ts";
import { commitSession, exportAll, importBundle, serialize } from "../src/background/store.ts";
import { addSnippet, deleteSnippet, gradeStoredCard } from "../src/background/vocab.ts";

const URL_A = "https://example.com/reading";
const NOW = Date.UTC(2026, 8, 12, 9);
const article = (patch: Partial<Article> = {}): Article => ({
  id: URL_A, url: URL_A, title: "Offline reading", totalWords: 200, trackedWords: 200,
  wordsRead: 0, paragraphCount: 2, readParagraphCount: 0, sessionCount: 0, totalMs: 0,
  maxSessionMs: 0, firstSeenTs: NOW, lastSeenTs: NOW, reachedBottom: false, finished: false,
  finishedTs: null, ...patch,
});
const session = (id: string, deviceId: string, patch: Partial<Session> = {}): Session => ({
  id, deviceId, articleId: URL_A, url: URL_A, title: "Offline reading", startTs: NOW,
  endTs: NOW + 10_000, wordsRead: 100, endReason: "hidden", ...patch,
});
const paragraph = (patch: Partial<ParagraphRecord> = {}): ParagraphRecord => ({
  hash: "paragraph-one", index: 0, words: 100, firstSeenTs: NOW, dwellMs: 500, ...patch,
});
const snippet = (id: string, cardId: string | null): Snippet => ({
  id, articleId: URL_A, url: URL_A, articleTitle: "Offline reading", text: "leak", kind: "word",
  context: "Every abstraction leaks.", createdTs: NOW, translation: "泄漏", contextNote: "暴露底层细节",
  pos: "verb", phonetic: null, lemma: "leak", usage: null, vocab: [], cardId,
});
function device(id: string, data: Record<string, unknown> = {}): StateDriver {
  const state = freshState(data);
  state.deviceId = id;
  trackChanges(state, {}, state.data, true);
  return memoryDriver(state);
}
async function change(driver: StateDriver, write: (data: Record<string, any>) => void): Promise<void> {
  await driver.update(state => {
    const before = structuredClone(state.data);
    write(state.data);
    trackChanges(state, before, state.data);
  });
}
async function records(driver: StateDriver): Promise<SyncRecord[]> {
  return Object.values((await driver.read()).records);
}
async function exchange(a: StateDriver, b: StateDriver, cursor = 1): Promise<void> {
  const [aRecords, bRecords] = await Promise.all([records(a), records(b)]);
  await applyRemote(a, bRecords, cursor);
  await applyRemote(b, aRecords, cursor);
}
const cardData = (): Record<string, unknown> => ({
  articles: { [URL_A]: article() }, snippets: [snippet("source-original", "card-original")],
  cards: [newCard("card-original", "leak", ["source-original"], NOW)],
});
const addInput = () => ({
  articleId: URL_A, url: URL_A, articleTitle: "Offline reading", text: "leak", kind: "word" as const,
  context: "Every abstraction leaks.", now: NOW + 100_000,
  result: { translation: "泄漏", contextNote: "", pos: "verb", phonetic: null, lemma: "leak", usage: null, vocab: [] },
});

test("two offline devices merge paragraph contributions without counting a shared legacy baseline twice", async () => {
  const seed = { articles: { [URL_A]: article() }, [`p:${URL_A}`]: [paragraph()] };
  const a = device("computer", seed), b = device("phone", seed);
  await change(a, data => { data[`p:${URL_A}`][0].dwellMs += 300; data.sessions = [session("session-computer", "computer")]; });
  await change(b, data => {
    data[`p:${URL_A}`][0].dwellMs += 700;
    data[`p:${URL_A}`].push(paragraph({ hash: "paragraph-two", index: 1, dwellMs: 400 }));
    data.sessions = [session("session-phone", "phone")];
  });
  await exchange(a, b);
  const left = (await a.read()).data, right = (await b.read()).data;
  assert.deepEqual(left.sessions.map((s: Session) => s.id), right.sessions.map((s: Session) => s.id));
  assert.equal(left.sessions.length, 2, "same timestamp on different devices is not a duplicate");
  assert.equal(left[`p:${URL_A}`][0].dwellMs, 1500, "500 shared + 300 computer + 700 phone");
  assert.equal(left.articles[URL_A].wordsRead, 200, "read words are a paragraph union");
  assert.deepEqual(left[`p:${URL_A}`], right[`p:${URL_A}`]);
  await exchange(a, b, 2);
  assert.equal((await a.read()).data[`p:${URL_A}`][0].dwellMs, 1500, "retry does not add durations");
});

test("recovered and final session uploads reuse identity and duplicate final uploads do not add paragraph dwell", async () => {
  const driver = device("computer", { articles: { [URL_A]: article() } });
  installStorage(driver);
  await commitSession(session("stable-session", "computer", { endTs: NOW + 5_000, endReason: "recovered", wordsRead: 0 }), []);
  await commitSession(session("stable-session", "computer"), [paragraph({ dwellMs: 1000 })]);
  await commitSession(session("stable-session", "computer"), [paragraph({ dwellMs: 1000 })]);
  const data = (await driver.read()).data;
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].endTs, NOW + 10_000);
  assert.equal(data[`p:${URL_A}`][0].dwellMs, 1000);
  const copy = device("phone");
  const remote = await records(driver);
  await applyRemote(copy, [...remote, ...remote], 2);
  assert.equal((await copy.read()).data.sessions.length, 1);
  assert.equal((await copy.read()).data[`p:${URL_A}`][0].dwellMs, 1000);
});

test("article deletion dominates stale offline writes and recreation cannot be overwritten by an older lifecycle", async () => {
  const initial = { articles: { [URL_A]: article() }, sessions: [session("old-session", "computer")], [`p:${URL_A}`]: [paragraph()] };
  const a = device("computer", initial), b = device("phone", initial);
  await change(a, data => { data.articles = {}; data.sessions = []; delete data[`p:${URL_A}`]; });
  await change(b, data => { data.sessions.push(session("offline-session", "phone")); data.articles[URL_A].title = "Stale title"; });
  const stale = (await records(b)).find(r => r.type === "article")!;
  await exchange(a, b);
  assert.equal((await a.read()).data.articles[URL_A], undefined);
  assert.equal((await b.read()).data.sessions.length, 0);
  await change(a, data => {
    data.articles = { [URL_A]: article({ title: "Reopened article" }) };
    data.sessions = [session("new-session", "computer", { startTs: NOW + 100_000, endTs: NOW + 110_000 })];
  });
  await applyRemote(a, [{ ...stale, stamp: { counter: 100_000, deviceId: "phone" } }], 2);
  const recovered = (await a.read()).data;
  assert.equal(recovered.articles[URL_A].title, "Reopened article");
  assert.deepEqual(recovered.sessions.map((s: Session) => s.id), ["new-session"]);
  await exchange(a, b, 3);
  assert.equal((await b.read()).data.articles[URL_A].title, "Reopened article");
  assert.equal((await b.read()).data.sessions.length, 1);
});

test("a metadata change does not refresh the version of an earlier manual completion decision", async () => {
  const a = device("computer", { articles: { [URL_A]: article() } });
  await change(a, data => { data.articles[URL_A].manualFinished = { value: false, pending: true }; });
  const first = (await records(a)).find(r => r.type === "article")!;
  const stamp = (first.value as Article).manualFinished!.stamp;
  await change(a, data => { data.articles[URL_A].lastSeenTs += 100_000; });
  const second = (await records(a)).find(r => r.type === "article")!;
  assert.deepEqual((second.value as Article).manualFinished!.stamp, stamp);
  const newer = structuredClone(first);
  (newer.value as Article).manualFinished = { value: true, stamp: { counter: stamp!.counter + 1, deviceId: "phone" } };
  newer.stamp = { counter: stamp!.counter + 1, deviceId: "phone" };
  await applyRemote(a, [newer], 1);
  assert.equal((await a.read()).data.articles[URL_A].finished, true);
});

test("two independently created cards for one lemma merge all sources and rebind snippet card IDs", async () => {
  const a = device("computer", { snippets: [snippet("source-a", "card-a")], cards: [newCard("card-a", "leak", ["source-a"], NOW)] });
  const b = device("phone", { snippets: [snippet("source-b", "card-b")], cards: [newCard("card-b", "leak", ["source-b"], NOW)] });
  await exchange(a, b);
  const left = (await a.read()).data, right = (await b.read()).data;
  assert.equal(left.cards.length, 1);
  assert.deepEqual(left.cards[0].snippetIds, ["source-a", "source-b"]);
  assert.deepEqual(left.cards, right.cards);
  assert.ok(left.snippets.every((s: Snippet) => s.cardId === left.cards[0].id));
});

test("deleting the last known snippet does not discard a concurrently added source on another device", async () => {
  const a = device("computer", cardData()), b = device("phone", cardData());
  installStorage(a);
  await deleteSnippet("source-original");
  installStorage(b);
  const added = await addSnippet(addInput());
  await exchange(a, b);
  for (const driver of [a, b]) {
    const data = (await driver.read()).data;
    assert.deepEqual(data.snippets.map((s: Snippet) => s.id), [added.snippet.id]);
    assert.equal(data.cards.length, 1, "surviving independent source remains reviewable");
    assert.deepEqual(data.cards[0].snippetIds, [added.snippet.id]);
    assert.equal(data.snippets[0].cardId, data.cards[0].id);
  }
});

test("concurrent offline reviews are both replayed, converge, and do not replay again on a repeated pull", async () => {
  const a = device("computer", cardData()), b = device("phone", cardData());
  installStorage(a);
  await gradeStoredCard("card-original", 3, NOW + 1000);
  installStorage(b);
  await gradeStoredCard("card-original", 4, NOW + 2000);
  await exchange(a, b);
  const left = (await a.read()).data, right = (await b.read()).data;
  assert.equal(left.reviewEvents.length, 2);
  assert.equal(left.cards[0].reps, 2);
  assert.deepEqual(left.cards, right.cards);
  const saved = structuredClone(left.cards);
  await exchange(a, b, 2);
  assert.deepEqual((await a.read()).data.cards, saved);
  installStorage(a);
  await gradeStoredCard(saved[0].id, 3, NOW + 86_400_000);
  await exchange(a, b, 3);
  assert.equal((await b.read()).data.cards[0].reps, 3);
  assert.deepEqual((await a.read()).data.cards, (await b.read()).data.cards);
});

test("adding a previously deleted lemma immediately resumes its dormant review history and stays stable on pull", async () => {
  const driver = device("computer", cardData());
  installStorage(driver);
  await gradeStoredCard("card-original", 3, NOW + 1000);
  await deleteSnippet("source-original");
  const added = await addSnippet(addInput());
  assert.ok(added.card);
  const before = (await driver.read()).data.cards[0] as StoredCard;
  assert.equal(before.reps, 1, "dormant history resumes locally without requiring an online sync");
  assert.equal(added.card.reps, before.reps, "the returned card matches the durable local state");
  await applyRemote(driver, [], 1);
  const after = (await driver.read()).data.cards[0] as StoredCard;
  assert.equal(after.id, before.id);
  assert.equal(after.reps, before.reps, "an empty pull does not change the resumed card");
  assert.equal(after.due, before.due);
});

test("migrated FSRS checkpoint remains intact before new review events", async () => {
  const old = gradeCard(gradeCard(newCard("card-original", "leak", ["source-original"], NOW), 3, NOW), 4, NOW + 86_400_000);
  const a = device("computer", { ...cardData(), cards: [old] }), b = device("phone");
  await applyRemote(b, await records(a), 1);
  assert.deepEqual((await b.read()).data.cards, [old]);
  installStorage(b);
  await gradeStoredCard(old.id, 3, NOW + 2 * 86_400_000);
  await exchange(a, b, 2);
  assert.equal((await a.read()).data.cards[0].reps, old.reps + 1);
});

test("exporting and repeatedly importing review history preserves scores without double replay during sync", async () => {
  const a = device("computer", cardData());
  installStorage(a);
  await gradeStoredCard("card-original", 3, NOW + 1000);
  await gradeStoredCard("card-original", 4, NOW + 86_400_000);
  const bundle = JSON.parse(JSON.stringify(await exportAll()));
  assert.equal(bundle.reviewHistory.version, 1);
  assert.equal(bundle.reviewHistory.records.filter((r: SyncRecord) => r.type === "reviewEvent").length, 2);

  const b = device("phone");
  installStorage(b);
  assert.equal((await importBundle(bundle)).ok, true);
  assert.equal((await b.read()).data.cards[0].reps, 2);
  assert.equal((await importBundle(bundle)).ok, true);
  assert.equal((await b.read()).data.cards[0].reps, 2);
  assert.equal((await b.read()).data.reviewEvents.length, 2);
  await exchange(a, b, 1);
  assert.equal((await b.read()).data.cards[0].reps, 2);

  installStorage(b);
  await gradeStoredCard((await b.read()).data.cards[0].id, 2, NOW + 2 * 86_400_000);
  installStorage(a);
  await gradeStoredCard((await a.read()).data.cards[0].id, 1, NOW + 2 * 86_400_000 + 1000);
  await exchange(a, b, 2);
  assert.equal((await a.read()).data.cards[0].reps, 4);
  assert.deepEqual((await a.read()).data.cards, (await b.read()).data.cards);
  assert.deepEqual((await b.read()).data.reviewEvents.map((e: { grade: number }) => e.grade).sort(), [1, 2, 3, 4]);
});

test("a pull preserves local optimistic writes and their unacknowledged operation IDs", async () => {
  const a = device("computer", { articles: { [URL_A]: article() } });
  const b = device("phone", { articles: { [URL_A]: article() }, sessions: [session("remote-session", "phone")] });
  const fetched = await records(b);
  await change(a, data => { data.sessions = [session("new-local-session", "computer")]; });
  const pending = (await a.read()).outbox.map(op => op.opId);
  await applyRemote(a, fetched, 7);
  const final = await a.read();
  assert.deepEqual(final.outbox.map(op => op.opId), pending);
  assert.deepEqual(final.data.sessions.map((s: Session) => s.id).sort(), ["new-local-session", "remote-session"]);
  assert.equal(final.cursor, 7);
});

test("a business read-modify-write cannot delete records delivered by a concurrent pull", async () => {
  const a = device("computer", { articles: { [URL_A]: article() }, sessions: [session("original-session", "computer")] });
  const b = device("phone", { articles: { [URL_A]: article() }, sessions: [session("remote-session", "phone")] });
  installStorage(a);
  let didRead!: () => void, release!: () => void;
  const read = new Promise<void>(resolve => { didRead = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writer = serialize(async () => {
    const got = await localStorage().get("sessions");
    didRead();
    await gate;
    await localStorage().set({ sessions: [...got.sessions, session("new-local-session", "computer")] });
  });
  await read;
  const pull = applyRemote(a, await records(b), 1);
  await Promise.resolve();
  release();
  await Promise.all([writer, pull]);
  const state = await a.read();
  assert.deepEqual(state.data.sessions.map((s: Session) => s.id).sort(), ["new-local-session", "original-session", "remote-session"]);
  assert.equal(state.outbox.some(op => op.record.id === "remote-session" && op.record.deleted), false);
});

test("data lock recovers after a failed business operation", async () => {
  await assert.rejects(withDataLock(async () => { throw new Error("write failed"); }), /write failed/);
  assert.equal(await withDataLock(async () => 42), 42);
});

test("independent page contexts coordinate whole business operations through the same browser lock", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  const lockQueues = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request(name: string, callback: () => Promise<unknown>) {
      const next = (lockQueues.get(name) ?? Promise.resolve()).then(callback, callback);
      lockQueues.set(name, next.catch(() => undefined));
      return next;
    },
  } });
  try {
    const path = new URL("../src/sync/storage.ts", import.meta.url);
    path.searchParams.set("test-context", "second-page");
    const other = await import(path.href) as typeof import("../src/sync/storage.ts");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let values: string[] = [];
    let secondRead = false;
    const first = withDataLock(async () => { const before = [...values]; entered(); await gate; values = [...before, "first"]; });
    await ready;
    const second = other.withDataLock(async () => { secondRead = true; const before = [...values]; values = [...before, "second"]; });
    await Promise.resolve();
    assert.equal(secondRead, false, "the second module instance must wait for the first context");
    release();
    await Promise.all([first, second]);
    assert.deepEqual(values, ["first", "second"]);
  } finally {
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else delete (navigator as unknown as Record<string, unknown>).locks;
  }
});

test("invalid record in a pull rolls back records, local projection, outbox and cursor together", async () => {
  const driver = device("computer", { articles: { [URL_A]: article() } });
  const before = await driver.read();
  const valid: SyncRecord = { type: "session", id: "new-session", articleId: URL_A, generation: "initial", deleted: false,
    stamp: { counter: 10, deviceId: "phone" }, value: session("new-session", "phone") };
  const invalid = { ...valid, id: "invalid-session", stamp: { counter: -1, deviceId: "phone" } };
  await assert.rejects(applyRemote(driver, [valid, invalid], 20));
  assert.deepEqual(await driver.read(), before);
  await applyRemote(driver, [valid], 19);
  assert.equal((await driver.read()).cursor, 19, "a failure does not poison the next transaction");
});

test("local transaction exception preserves business data and pending operations", async () => {
  const driver = device("computer", { articles: { [URL_A]: article() } });
  const before = await driver.read();
  await assert.rejects(driver.update(state => {
    const old = structuredClone(state.data);
    state.data.sessions = [session("never-committed", "computer")];
    trackChanges(state, old, state.data);
    throw new Error("simulated storage commit failure");
  }), /simulated storage/);
  assert.deepEqual(await driver.read(), before);
});

test("credentials and diagnostics are absent from sync operations, public status, exports and content-script projections", async () => {
  const driver = device("computer", { articles: { [URL_A]: article() }, settings: DEFAULT_SETTINGS,
    llm: { ...DEFAULT_LLM, apiKey: "private-llm-secret" }, llmLog: [{ error: "private-log-text" }],
  });
  await driver.update(state => { state.config = { enabled: false, baseUrl: "https://sync.example.com", token: "private-sync-secret", userId: "owner", serverId: "server" }; });
  let projection: Record<string, unknown> = {};
  installStorage(driver, async data => { projection = data; });
  await localStorage().set({ llmUsage: { requests: 1 } });
  const values = [JSON.stringify((await driver.read()).outbox), JSON.stringify(await syncStatus()), JSON.stringify(await exportAll()), JSON.stringify(projection)];
  for (const value of values) for (const secret of ["private-llm-secret", "private-sync-secret", "private-log-text"]) assert.equal(value.includes(secret), false);
  assert.deepEqual(Object.keys(projection).sort(), ["settings", "speed"]);
  await configureSync("https://sync.example.com", undefined, false);
  await disconnectSync();
  const final = await driver.read();
  assert.equal(final.config.token, "");
  assert.equal(final.config.userId, "owner");
  assert.ok(final.data.articles[URL_A], "disconnect preserves local records and account binding");
});

test("settings merge by field and LLM keys remain device-local", async () => {
  const seed = { settings: { ...DEFAULT_SETTINGS } };
  const a = device("computer", seed), b = device("phone", seed);
  await change(a, data => { data.settings.articleExcludedUrls = ["example.com"]; data.llm = { ...DEFAULT_LLM, apiKey: "computer-key" }; });
  await change(b, data => { data.settings.finishRatio = 0.95; data.llm = { ...DEFAULT_LLM, apiKey: "phone-key" }; });
  await exchange(a, b);
  for (const driver of [a, b]) {
    const data = (await driver.read()).data;
    assert.deepEqual(data.settings.articleExcludedUrls, ["example.com"]);
    assert.equal(data.settings.finishRatio, 0.95);
  }
  assert.equal((await a.read()).data.llm.apiKey, "computer-key");
  assert.equal((await b.read()).data.llm.apiKey, "phone-key");
});

test("a large legacy history cannot make untouched defaults override an explicit setting change", async () => {
  const a = device("computer", { settings: { ...DEFAULT_SETTINGS } });
  const history = Object.fromEntries(Array.from({ length: 30 }, (_, index) => {
    const url = `https://example.com/legacy-${index}`;
    return [url, article({ id: url, url })];
  }));
  const b = device("phone", { articles: history, settings: { ...DEFAULT_SETTINGS } });
  await change(a, data => { data.settings.finishRatio = 0.95; });
  await exchange(a, b);
  assert.equal((await a.read()).data.settings.finishRatio, 0.95);
  assert.equal((await b.read()).data.settings.finishRatio, 0.95);
});

test("malformed cards and mismatched payload identities are rejected before entering the shared log", () => {
  const envelope = { generation: "initial", deleted: false, stamp: { counter: 1, deviceId: "phone" } };
  assert.throws(() => validateRecord({ ...envelope, type: "card", id: "leak", value: { key: "leak", id: "card", snippetIds: "invalid", base: {} } }));
  assert.throws(() => validateRecord({ ...envelope, type: "session", id: "envelope-id", articleId: URL_A, value: session("payload-id", "phone") }));
  assert.throws(() => validateRecord({ ...envelope, type: "setting", id: "apiKey", value: "must-not-sync" }));
});

test("sync endpoints require HTTPS and reject embedded credentials or query parameters", () => {
  assert.equal(normalizeServerUrl(" https://sync.example.com/ "), "https://sync.example.com");
  assert.equal(normalizeServerUrl("http://localhost:8787/"), "http://localhost:8787");
  for (const url of ["http://192.168.1.2", "https://user:password@example.com", "https://example.com?token=secret", "https://example.com#fragment", "file:///tmp/server"]) {
    assert.throws(() => normalizeServerUrl(url));
  }
});

test("merge is commutative and idempotent for independently observed paragraph counters", () => {
  const base: SyncRecord = { type: "paragraph", id: JSON.stringify([URL_A, "paragraph-one"]), articleId: URL_A,
    generation: "initial", deleted: false, stamp: { counter: 4, deviceId: "computer" },
    value: { ...paragraph(), dwell: { legacy: 100, computer: 200 } } };
  const other: SyncRecord = { ...base, stamp: { counter: 4, deviceId: "phone" }, value: { ...paragraph(), dwell: { legacy: 100, phone: 300 } } };
  const merged = mergeRecord(base, other);
  assert.deepEqual(merged, mergeRecord(other, base));
  assert.deepEqual(merged, mergeRecord(merged, other));
  assert.equal(recordKey(merged), recordKey(base));
});
