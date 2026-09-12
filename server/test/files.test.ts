import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { FileStore } from '../src/files.ts';
import { bearerToken, generateToken, hashToken } from '../src/auth.ts';
import { canonical, validateOperations } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { validateManifest } from '../src/manifest.ts';

test('opaque credentials are high entropy and represented by a non-reversible digest', () => {
  const token = generateToken();
  assert.match(token, /^fs_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, generateToken());
  assert.equal(bearerToken(`Bearer ${token}`), token);
  assert.equal(hashToken(token).length, 64);
  assert.notEqual(hashToken(token), token);
  for (const header of [undefined, '', 'Bearer short', `Basic ${token}`, `Bearer ${token} trailing`]) assert.throws(() => bearerToken(header));
});

test('canonical receipts are independent of JSON key order', () => {
  assert.equal(canonical({ a: [1, 2], z: { c: 4, b: 3 } }), canonical({ z: { b: 3, c: 4 }, a: [1, 2] }));
  assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }));
  assert.throws(() => validateOperations({ deviceId: 'device', operations: new Array(201).fill({}) }));
  assert.throws(() => readConfig({ DATABASE_URL: 'postgres://local', CORS_ORIGINS: '*' }));
  assert.throws(() => readConfig({ DATABASE_URL: 'postgres://local', PORT: '70000' }));
});

test('file uploads verify hashes, bound size, isolate users, and remove incomplete temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'focus-server-files-'));
  try {
    const store = new FileStore(directory, 32);
    const user = randomUUID();
    const content = Buffer.from('article content');
    const hash = createHash('sha256').update(content).digest('hex');
    const blob = await store.put(user, hash, 'text/html', Readable.from([content.subarray(0, 3), content.subarray(3)]));
    assert.equal(blob.size, content.length);
    assert.equal(await store.exists(blob), true);
    assert.deepEqual(await readFile(store.path(blob.storageKey)), content);
    assert.notEqual(store.storageKey(randomUUID(), hash), blob.storageKey);
    await store.put(user, hash, 'text/html', Readable.from([content]));
    await assert.rejects(store.put(user, '0'.repeat(64), 'text/plain', Readable.from([content])), /SHA-256/);
    await assert.rejects(store.put(user, hash, 'text/plain', Readable.from([Buffer.alloc(33)])), /MAX_BLOB_BYTES/);
    await assert.rejects(store.put(user, hash, 'text/plain', Readable.from([content]), 1), /quota/);
    assert.throws(() => store.storageKey('../escape', hash));
    assert.throws(() => store.path('../escape'));
    const entries = await readdir(directory, { recursive: true });
    assert.equal(entries.some(name => name.endsWith('.upload')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('archive manifest validates URLs, resource metadata and immutable version identity', () => {
  const manifest = { articleId: 'article', version: 'v1', title: 'Title', url: 'https://example.org/', htmlHash: 'a'.repeat(64), resources: [], missingResources: [], createdTs: 1 };
  assert.deepEqual(validateManifest(manifest), manifest);
  assert.throws(() => validateManifest({ ...manifest, url: 'javascript:alert(1)' }));
  assert.throws(() => validateManifest({ ...manifest, htmlHash: '../data' }));
  assert.throws(() => validateManifest({ ...manifest, resources: [{ hash: 'a'.repeat(64), size: -1, mime: 'image/png' }] }));
  assert.throws(() => validateManifest({ ...manifest, resources: [{ hash: 'a'.repeat(64), size: 1, mime: 'text/html\r\nX-Injected: yes' }] }));
});
