import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import type { Article } from "../src/types.ts";
import { indexedDriver, trackChanges } from "../src/sync/storage.ts";
import type { StateDriver, SyncState } from "../src/sync/storage.ts";
import { recordKey } from "../src/sync/protocol.ts";

const articleId = "https://example.org/indexeddb-article";
const article = (): Article => ({
  id: articleId, url: articleId, title: "Before migration", totalWords: 200, trackedWords: 200,
  wordsRead: 0, paragraphCount: 2, readParagraphCount: 0, sessionCount: 0, totalMs: 0,
  maxSessionMs: 0, firstSeenTs: 100, lastSeenTs: 100, reachedBottom: false, finished: false,
  finishedTs: null,
});
const legacy = () => ({ articles: { [articleId]: article() }, localOnly: { theme: "dark" } });

/** Real IDB transactions/object stores; only the browser IDB implementation is simulated. */
async function withDatabase(run: (name: string, factory: IDBFactory, connections: Set<IDBDatabase>) => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const factory = new IDBFactory();
  const connections = new Set<IDBDatabase>();
  const open = factory.open.bind(factory);
  factory.open = (...args: Parameters<IDBFactory["open"]>) => {
    const request = open(...args);
    request.addEventListener("success", () => { connections.add(request.result); });
    return request;
  };
  Object.defineProperty(globalThis, "indexedDB", { value: factory, writable: true, configurable: true });
  const name = `focus-indexeddb-test-${randomUUID()}`;
  try { await run(name, factory, connections); }
  finally {
    for (const database of connections) database.close();
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Test leaked an open IndexedDB connection"));
    });
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  }
}

async function rawState(factory: IDBFactory, name: string): Promise<SyncState | undefined> {
  if (!(await factory.databases()).some(database => database.name === name)) return undefined;
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!database.objectStoreNames.contains("state")) return undefined;
    return await new Promise<SyncState | undefined>((resolve, reject) => {
      const transaction = database.transaction("state", "readonly");
      const request = transaction.objectStore("state").get("root");
      transaction.oncomplete = () => resolve(request.result as SyncState | undefined);
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
  } finally { database.close(); }
}

async function changeTitle(driver: StateDriver, title: string): Promise<void> {
  await driver.update(state => {
    const before = structuredClone(state.data);
    state.data.articles[articleId].title = title;
    trackChanges(state, before, state.data);
  });
}

test("IndexedDB migrates legacy data once and does not reseed an existing database", async () => {
  await withDatabase(async name => {
    const original = legacy();
    const baseline = structuredClone(original);
    let seedCalls = 0;
    const seed = async () => { seedCalls++; return original; };
    const first = indexedDriver(seed, name);
    const initial = await first.read();
    assert.deepEqual(initial.data, baseline);
    assert.equal(initial.outbox.length, 1, "migration creates one upload for the existing article");
    assert.deepEqual(initial.records[recordKey({ type: "article", id: articleId })], initial.outbox[0]!.record);
    assert.equal(initial.outbox[0]!.record.id, articleId);
    await first.read();
    await changeTitle(first, "Changed after migration");
    const committed = await first.read();
    assert.equal(seedCalls, 1);
    assert.deepEqual(original, baseline, "migration never mutates the source store");
    const second = indexedDriver(seed, name);
    assert.deepEqual(await second.read(), committed, "a second instance reuses persisted state and operation IDs");
    assert.equal(seedCalls, 1, "an existing root does not reread legacy storage");
  });
});

test("IndexedDB serializes interleaved writes from two driver instances without lost updates", async () => {
  await withDatabase(async name => {
    const first = indexedDriver(async () => legacy(), name);
    const second = indexedDriver(async () => legacy(), name);
    const [firstInitial, secondInitial] = await Promise.all([first.read(), second.read()]);
    assert.deepEqual(firstInitial, secondInitial, "concurrent initialization publishes exactly one root");
    assert.equal(firstInitial.outbox.length, 1, "racing initialization does not queue duplicate migration operations");
    const initialCounter = firstInitial.counter;
    const initialOperations = firstInitial.outbox.length;
    await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? first : second).update(state => {
      const before = structuredClone(state.data);
      state.data.articles[articleId].title = `Concurrent edit ${index}`;
      state.data.appliedEdits = [...(state.data.appliedEdits ?? []), index];
      trackChanges(state, before, state.data);
      state.cursor++;
    })));
    const result = await first.read();
    assert.deepEqual(await second.read(), result);
    assert.equal(result.cursor, 40);
    assert.equal(result.counter, initialCounter + 40);
    assert.equal(result.outbox.length, initialOperations + 40);
    assert.equal(new Set(result.outbox.map(operation => operation.opId)).size, initialOperations + 40);
    assert.deepEqual([...result.data.appliedEdits].sort((a: number, b: number) => a - b), Array.from({ length: 40 }, (_, index) => index));
  });
});

test("IndexedDB aborts business data, versions, outbox and cursor together when a transaction throws", async () => {
  await withDatabase(async (name, factory) => {
    const driver = indexedDriver(async () => legacy(), name);
    const baseline = await driver.read();
    const failure = new Error("Simulated business failure");
    await assert.rejects(driver.update(state => {
      const before = structuredClone(state.data);
      state.data.articles[articleId].title = "Must not commit";
      trackChanges(state, before, state.data);
      state.cursor = 500;
      state.snapshot = { token: "unfinished", head: 500, cursor: 10 };
      throw failure;
    }), error => error === failure);
    assert.deepEqual(await driver.read(), baseline);
    assert.deepEqual(await rawState(factory, name), baseline, "no portion of the failed update reached the object store");
    await changeTitle(driver, "Subsequent write succeeds");
    assert.equal((await driver.read()).outbox.length, baseline.outbox.length + 1);
  });
});

test("IndexedDB storage-clone failures roll back all modified state and leave the driver usable", async () => {
  await withDatabase(async (name, factory) => {
    const driver = indexedDriver(async () => legacy(), name);
    const baseline = await driver.read();
    await assert.rejects(driver.update(state => {
      const before = structuredClone(state.data);
      state.data.articles[articleId].title = "Not cloneable";
      trackChanges(state, before, state.data);
      state.cursor = 600;
      state.data.invalidFunction = () => undefined;
    }), error => error instanceof Error && error.name === "DataCloneError");
    assert.deepEqual(await rawState(factory, name), baseline);
    await changeTitle(driver, "Recovered after clone failure");
    assert.equal((await driver.read()).data.articles[articleId].title, "Recovered after clone failure");
  });
});

test("IndexedDB reopen resumes pending operations, cursor and snapshot when legacy storage is unavailable", async () => {
  await withDatabase(async (name, _factory, connections) => {
    const first = indexedDriver(async () => legacy(), name);
    await changeTitle(first, "Pending offline edit");
    await first.update(state => {
      state.config = { enabled: true, baseUrl: "https://sync.example.org", token: "local-only-token", serverId: "server", userId: "user" };
      state.cursor = 71;
      state.failures = 2;
      state.retryAt = 123_000;
      state.snapshot = { token: "snapshot-token", head: 81, cursor: 10 };
    });
    const committed = await first.read();
    for (const database of connections) database.close();
    let seedCalls = 0;
    const reopened = indexedDriver(async () => { seedCalls++; throw new Error("Legacy store no longer available"); }, name);
    assert.deepEqual(await reopened.read(), committed);
    assert.equal(seedCalls, 0);
    const detached = await reopened.read();
    detached.data.articles[articleId].title = "Caller changed a detached read";
    detached.outbox.length = 0;
    assert.deepEqual(await reopened.read(), committed, "reads do not leak mutable references into persistence");
  });
});

test("IndexedDB rejects a failed migration without an empty commit and can retry a transient seed failure", async () => {
  await withDatabase(async (name, factory) => {
    let unavailable = true;
    const original = legacy();
    const failure = new Error("Temporary legacy read failure");
    const driver = indexedDriver(async () => {
      if (unavailable) throw failure;
      return original;
    }, name);
    await assert.rejects(driver.read(), error => error === failure);
    assert.equal(await rawState(factory, name), undefined, "failed migration never installs an empty replacement");
    unavailable = false;
    const recovered = await driver.read();
    assert.deepEqual(recovered.data, original);
    assert.equal(recovered.outbox.length, 1);
    assert.deepEqual(await rawState(factory, name), recovered);
  });
});
