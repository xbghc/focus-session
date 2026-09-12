import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { Database } from "../src/database.ts";
import { FileStore } from "../src/files.ts";
import { createHttpServer } from "../src/http.ts";
import { readConfig } from "../src/config.ts";
import { newCard } from "../../src/lib/review.ts";
import { gradeStoredCard } from "../../src/background/vocab.ts";
import { memoryDriver, installStorage, localStorage } from "../../src/sync/storage.ts";
import { configureSync, disconnectSync, runSync, syncRequest } from "../../src/sync/engine.ts";

test("real HTTP clients synchronize offline reading, reviews and archived bytes through PostgreSQL", { skip: !process.env.DATABASE_URL }, async () => {
  const connection = process.env.DATABASE_URL!;
  const bootstrap = new Database(connection);
  const schema = `focus_engine_${randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "focus-sync-engine-"));
  const url = new URL(connection);
  url.searchParams.set("options", `-c search_path=${schema}`);
  let database: Database | undefined;
  let http: Server | undefined;
  try {
    await bootstrap.pool.query(`CREATE SCHEMA "${schema}"`);
    database = new Database(url.toString());
    await database.init();
    const first = await database.createUser("client integration");
    const isolated = await database.createUser("isolated integration");
    const config = readConfig({ DATABASE_URL: url.toString(), DATA_DIR: directory, HOST: "127.0.0.1" });
    const service = createHttpServer(config, database, new FileStore(directory, config.maxBlobBytes));
    http = service;
    await new Promise<void>((resolve, reject) => { service.once("error", reject); service.listen(0, "127.0.0.1", resolve); });
    const address = service.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const articleId = "https://article.test/saved";
    const now = Date.UTC(2026, 8, 12, 9);
    const desktop = memoryDriver();
    installStorage(desktop);
    await localStorage().set({
      settings: { paragraphDwellMs: 1357 },
      articles: { [articleId]: {
        id: articleId, url: articleId, title: "Saved article", totalWords: 200, trackedWords: 200,
        wordsRead: 0, paragraphCount: 2, readParagraphCount: 0, sessionCount: 0, totalMs: 0, maxSessionMs: 0,
        firstSeenTs: now, lastSeenTs: now, reachedBottom: false, finished: false, finishedTs: null,
      } },
      sessions: [{ id: "desktop-session", articleId, url: articleId, title: "Saved article", startTs: now, endTs: now + 5000, wordsRead: 100, endReason: "hidden" }],
      [`p:${articleId}`]: [{ hash: "paragraph-one", index: 0, words: 100, firstSeenTs: now, dwellMs: 500 }],
      snippets: [{ id: "saved-snippet", articleId, url: articleId, articleTitle: "Saved article", text: "leak", kind: "word",
        context: "Every abstraction leaks.", createdTs: now, translation: "泄漏", contextNote: "暴露底层细节",
        pos: "verb", phonetic: null, lemma: "leak", usage: null, vocab: [], cardId: "saved-card" }],
      cards: [newCard("saved-card", "leak", ["saved-snippet"], now)],
    });
    await configureSync(baseUrl, first.token, true);
    assert.equal((await runSync()).error, null);
    assert.equal((await desktop.read()).outbox.length, 0);

    // Image and HTML bodies travel as binary requests through the production client.
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh0kAAAAASUVORK5CYII=", "base64");
    const imageHash = createHash("sha256").update(image).digest("hex");
    const html = `<p>An authenticated saved article.</p><img src="fs-blob:${imageHash}">`;
    const hash = createHash("sha256").update(html).digest("hex");
    await syncRequest(`/v1/blobs/${imageHash}`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: new Blob([image], { type: "image/png" }) });
    await syncRequest(`/v1/blobs/${hash}`, { method: "PUT", headers: { "Content-Type": "text/html" }, body: new Blob([html], { type: "text/html" }) });
    const manifest = { articleId, version: randomUUID(), title: "Saved article", url: articleId,
      htmlHash: hash, resources: [{ hash: imageHash, mime: "image/png", size: image.byteLength }], missingResources: [], createdTs: now };
    await syncRequest("/v1/archives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(manifest) });

    const phone = memoryDriver();
    installStorage(phone);
    await configureSync(baseUrl, first.token, true);
    assert.equal((await runSync()).error, null);
    const downloaded = await phone.read();
    assert.equal(downloaded.data.settings.paragraphDwellMs, 1357);
    assert.equal(downloaded.data.sessions.length, 1);
    assert.equal(downloaded.data.articles[articleId].wordsRead, 100);
    assert.equal(downloaded.data[`p:${articleId}`][0].dwellMs, 500);
    assert.equal(downloaded.data.snippets[0].text, "leak");
    assert.equal(downloaded.data.archives[articleId].htmlHash, hash);
    assert.equal(await (await syncRequest(`/v1/blobs/${hash}`)).text(), html);
    assert.deepEqual(Buffer.from(await (await syncRequest(`/v1/blobs/${imageHash}`)).arrayBuffer()), image);
    assert.equal((await syncRequest(`/v1/blobs/${hash}`, { method: "HEAD" })).status, 200);

    // Both devices grade the same offline base independently before reconnecting.
    await gradeStoredCard("saved-card", 3, now + 10_000);
    await localStorage().set({
      sessions: [...downloaded.data.sessions, { id: "phone-session", articleId, url: articleId, title: "Saved article", startTs: now + 10_000, endTs: now + 15_000, wordsRead: 100, endReason: "hidden" }],
      [`p:${articleId}`]: [
        { ...downloaded.data[`p:${articleId}`][0], dwellMs: 1200 },
        { hash: "paragraph-two", index: 1, words: 100, firstSeenTs: now + 11_000, dwellMs: 400 },
      ],
    });
    installStorage(desktop);
    await gradeStoredCard("saved-card", 2, now + 20_000);
    const desktopRead = await desktop.read();
    await localStorage().set({ [`p:${articleId}`]: [{ ...desktopRead.data[`p:${articleId}`][0], dwellMs: 800 }] });
    assert.equal((await runSync()).error, null);
    installStorage(phone);
    assert.equal((await runSync()).error, null);
    installStorage(desktop);
    assert.equal((await runSync()).error, null);
    const left = await desktop.read(), right = await phone.read();
    assert.equal(left.data.reviewEvents.length, 2);
    assert.equal(left.data.cards[0].reps, 2);
    assert.deepEqual(left.data.cards, right.data.cards);
    assert.deepEqual(left.data[`p:${articleId}`], right.data[`p:${articleId}`]);
    assert.equal(left.data[`p:${articleId}`][0].dwellMs, 1500);
    assert.equal(left.data.articles[articleId].wordsRead, 200);
    assert.equal(left.data.sessions.length, 2);
    assert.equal(left.outbox.length + right.outbox.length, 0);

    const other = memoryDriver();
    installStorage(other);
    await configureSync(baseUrl, isolated.token, true);
    assert.equal((await runSync()).error, null);
    assert.equal(Object.keys((await other.read()).data.archives).length, 0);
    assert.equal((await other.read()).data.snippets.length, 0);
    await assert.rejects(syncRequest(`/v1/blobs/${hash}`), (error: unknown) => (error as { status?: number }).status === 404);
  } finally {
    await disconnectSync();
    if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
    if (database) await database.close();
    await bootstrap.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await bootstrap.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "focus-sync-engine-"));
    await rm(directory, { recursive: true, force: true });
  }
});
