import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { SyncRecord } from '../../src/sync/protocol.ts';
import { Database } from '../src/database.ts';
import { FileStore } from '../src/files.ts';

function record(name: string, counter = 1, deviceId = 'device-a'): SyncRecord {
  const id = `https://example.org/${name}`;
  const value = { id, url: id, title: name, totalWords: 100, trackedWords: 10, paragraphCount: 5, firstSeenTs: 1, lastSeenTs: 2, finished: false, reachedBottom: false };
  return { type: 'article', id, value, generation: 'initial', stamp: { counter, deviceId }, deleted: false };
}

test('PostgreSQL atomic sync, user isolation, concurrency, restart and archive references', { skip: !process.env.DATABASE_URL }, async t => {
  const connection = process.env.DATABASE_URL!;
  const bootstrap = new pg.Pool({ connectionString: connection });
  // Every run owns one fresh schema and only drops that exact generated schema.
  const schema = `focus_test_${randomUUID().replaceAll('-', '')}`;
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const database = new Database(url.toString());
  try {
    await database.init();
    const one = await database.createUser('one');
    const two = await database.createUser('two');
    const userId = one.user.id;
    await t.test('identity is stable and tokens can be independently revoked', async () => {
      assert.equal((await database.authenticate(one.token))?.id, userId);
      assert.equal((await database.authenticate(two.token))?.id, two.user.id);
      const extra = await database.issueToken(userId, 'second device');
      assert.equal((await database.authenticate(extra.token))?.id, userId);
      assert.equal(await database.revokeToken(extra.tokenId), true);
      assert.equal(await database.authenticate(extra.token), undefined);
      assert.equal((await database.authenticate(one.token))?.id, userId);
      const reopened = new Database(url.toString());
      try { await reopened.init(); assert.equal(reopened.serverId, database.serverId); }
      finally { await reopened.close(); }
    });
    await t.test('retries are idempotent, reused IDs reject and the entire batch rolls back', async () => {
      const operation = { opId: 'one', record: record('article') };
      assert.deepEqual(await database.push(userId, 'a', [operation]), { accepted: ['one'], head: 1 });
      assert.deepEqual(await database.push(userId, 'a', [operation]), { accepted: ['one'], head: 1 });
      await assert.rejects(database.push(userId, 'a', [{ opId: 'second', record: record('uncommitted') }, { opId: 'one', record: record('different') }]), /different payload/);
      const page = await database.pull(userId, 0, 200);
      assert.equal(page.records.length, 1);
      assert.equal(page.cursor, 1);
      assert.deepEqual(await database.pull(two.user.id, 0, 200), { records: [], cursor: 0, hasMore: false });
      await assert.rejects(database.pull(userId, 999, 200), /older than this device/);
    });
    await t.test('concurrent device writes have gapless commit order and stable page cursors', async () => {
      await Promise.all(Array.from({ length: 20 }, (_, index) => database.push(userId, `device-${index}`, [{ opId: `parallel-${index}`, record: record(`parallel-${index}`) }])));
      const all: SyncRecord[] = [];
      let cursor = 0;
      let hasMore = true;
      while (hasMore) {
        const page = await database.pull(userId, cursor, 3);
        all.push(...page.records);
        cursor = page.cursor;
        hasMore = page.hasMore;
      }
      assert.equal(all.length, 21);
      assert.equal(new Set(all.map(item => item.id)).size, 21);
      assert.equal(cursor, 21);
    });
    await t.test('same-lifecycle deletes dominate an offline edit', async () => {
      await database.push(userId, 'a', [{ opId: 'delete', record: { ...record('article', 2), deleted: true } }]);
      await database.push(userId, 'b', [{ opId: 'old-offline-edit', record: record('article', 3, 'b') }]);
      const current = (await database.pool.query('SELECT record FROM records WHERE user_id=$1 AND id=$2', [userId, record('article').id])).rows[0].record;
      assert.equal(current.deleted, true);
    });
    await t.test('snapshot pages retain a stable waterline while new edits arrive', async () => {
      const first = await database.snapshot(userId, undefined, 0, 3);
      assert.equal(first.records.length, 3);
      assert.equal(first.hasMore, true);
      const change = await database.push(userId, 'a', [{ opId: 'after-snapshot', record: record('after-snapshot') }]);
      const records = [...first.records];
      let page = first;
      while (page.hasMore) {
        page = await database.snapshot(userId, first.token, page.cursor, 3);
        assert.equal(page.head, first.head);
        records.push(...page.records);
      }
      assert.equal(records.some(value => value.id === record('after-snapshot').id), false);
      const next = await database.pull(userId, first.head, 200);
      assert.equal(next.records.some(value => value.id === record('after-snapshot').id), true);
      assert.equal(next.cursor, change.head);
      await assert.rejects(database.snapshot(two.user.id, first.token, 0, 200), /does not belong/);
    });
    await t.test('incremental pages are bounded by bytes as well as record count', async () => {
      const separate = await database.createUser('large records');
      const operations = Array.from({ length: 6 }, (_, index) => {
        const articleId = `https://example.org/large-${index}`;
        return { opId: `large-${index}`, record: { type: 'articleText', id: articleId, articleId, value: { articleId, text: 'x'.repeat(450_000) }, stamp: { counter: 1, deviceId: 'a' }, generation: 'initial', deleted: false } as SyncRecord };
      });
      await database.push(separate.user.id, 'a', operations);
      const first = await database.pull(separate.user.id, 0, 200);
      assert.equal(first.hasMore, true);
      assert.ok(Buffer.byteLength(JSON.stringify(first.records)) < 2 * 1024 * 1024);
      const next = await database.pull(separate.user.id, first.cursor, 200);
      assert.equal(first.records.length + next.records.length, 6);
      assert.equal(next.hasMore, false);
    });
    await t.test('archive files must exist, versions are immutable and other users cannot reference blobs', async () => {
      const hash = createHash('sha256').update('body').digest('hex');
      const manifest = { articleId: 'https://example.org/archive', version: 'v1', title: 'Saved', url: 'https://example.org/archive', htmlHash: hash, resources: [{ hash, mime: 'text/html', size: 4 }], missingResources: [], createdTs: 1 };
      await assert.rejects(database.publishArchive(userId, manifest), /Upload every/);
      await database.saveBlob(userId, { hash, storageKey: `users/${userId}/blobs/${hash.slice(0, 2)}/${hash}`, size: 4, mime: 'text/html' }, 100);
      const first = await database.publishArchive(userId, manifest);
      assert.equal(first.record.type, 'archive');
      assert.equal((await database.publishArchive(userId, manifest)).head, first.head);
      assert.equal((await database.pool.query('SELECT count(*) FROM archive_resources WHERE user_id=$1', [userId])).rows[0].count, '1');
      await assert.rejects(database.publishArchive(userId, { ...manifest, title: 'changed' }), /immutable/);
      const newer = await database.publishArchive(userId, { ...manifest, version: 'v2', title: 'Newer' });
      const retried = await database.publishArchive(userId, manifest);
      assert.equal(retried.head, newer.head);
      assert.equal((retried.record.value as { version: string }).version, 'v2');
      const losing = await database.publishArchive(userId, { ...manifest, version: 'v3', title: 'Concurrent candidate', stamp: { counter: 0, deviceId: 'offline' } });
      assert.equal((losing.record.value as { version: string }).version, 'v2');
      assert.equal((await database.pool.query('SELECT count(*) FROM archive_versions WHERE user_id=$1', [userId])).rows[0].count, '3');
      await assert.rejects(database.publishArchive(two.user.id, manifest), /Upload every/);
      assert.equal(await database.blob(two.user.id, hash), undefined);
      await assert.rejects(database.saveBlob(userId, { hash: '0'.repeat(64), storageKey: `users/${userId}/blobs/00/${'0'.repeat(64)}`, size: 100, mime: 'text/plain' }, 100), /quota/);
    });
    await t.test('concurrent resource uploads reserve user quota without leaving rejected files', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'focus-pg-files-'));
      try {
        const store = new FileStore(directory, 100);
        const separate = await database.createUser('quota');
        const bodies = [Buffer.alloc(60, 1), Buffer.alloc(60, 2)];
        const results = await Promise.allSettled(bodies.map(body => {
          const hash = createHash('sha256').update(body).digest('hex');
          return database.uploadBlob(separate.user.id, hash, 100, available => store.put(separate.user.id, hash, 'application/octet-stream', Readable.from([body]), available));
        }));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.filter(result => result.status === 'rejected').length, 1);
        const paths = await readdir(directory, { recursive: true });
        assert.equal(paths.filter(path => /[a-f0-9]{64}$/.test(path)).length, 1);
        assert.equal(paths.some(path => path.endsWith('.upload')), false);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  } finally {
    await database.close();
    await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
    await bootstrap.end();
  }
});
