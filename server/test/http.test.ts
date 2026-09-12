import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { generateToken } from '../src/auth.ts';
import { readConfig } from '../src/config.ts';
import type { Database } from '../src/database.ts';
import { FileStore } from '../src/files.ts';
import type { StoredBlob } from '../src/files.ts';
import { createHttpServer } from '../src/http.ts';

test('HTTP requires token, checks CORS and body limits, scopes blobs and serves inert content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'focus-server-http-'));
  const userId = randomUUID();
  const otherId = randomUUID();
  const token = generateToken();
  const otherToken = generateToken();
  const blobs = new Map<string, StoredBlob>();
  let healthy = true;
  const fake: Pick<Database, 'serverId' | 'authenticate' | 'healthy' | 'push' | 'pull' | 'snapshot' | 'blob' | 'uploadBlob' | 'publishArchive'> = {
    serverId: randomUUID(),
    authenticate: async value => value === token ? { id: userId, name: 'one' } : value === otherToken ? { id: otherId, name: 'two' } : undefined,
    healthy: async () => { if (!healthy) throw new Error('down'); return true; },
    push: async (_user, _device, operations) => ({ accepted: operations.map(op => op.opId), head: 1 }),
    pull: async (_user, cursor) => ({ records: [], cursor, hasMore: false }),
    snapshot: async () => { throw new Error('unexpected'); },
    blob: async (user, hash) => blobs.get(`${user}:${hash}`),
    uploadBlob: async (user, hash, quota, write) => {
      const blob = await write(quota);
      blobs.set(`${user}:${hash}`, blob);
      return blob;
    },
    publishArchive: async () => { throw new Error('unexpected'); },
  };
  const config = readConfig({ DATABASE_URL: 'postgres://unused', DATA_DIR: directory, CORS_ORIGINS: 'https://allowed.example', MAX_JSON_BYTES: '100', MAX_BLOB_BYTES: '100' });
  const server = createHttpServer(config, fake, new FileStore(directory, config.maxBlobBytes));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const authorization = `Bearer ${token}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    healthy = false;
    assert.equal((await fetch(`${base}/health`)).status, 503);
    assert.equal((await fetch(`${base}/v1/info`)).status, 401);
    const info = await fetch(`${base}/v1/info`, { headers: { authorization } });
    assert.deepEqual(await info.json(), { serverId: fake.serverId, userId, userName: 'one', protocol: 1 });
    assert.equal((await fetch(`${base}/v1/info`, { headers: { authorization, Origin: 'https://evil.example' } })).status, 403);
    const preflight = await fetch(`${base}/v1/sync/push`, { method: 'OPTIONS', headers: { Origin: 'https://allowed.example' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://allowed.example');
    assert.equal((await fetch(`${base}/v1/sync/pull?cursor=-1`, { headers: { authorization } })).status, 400);
    assert.equal((await fetch(`${base}/v1/sync/push`, { method: 'POST', headers: { authorization }, body: '{}' })).status, 415);
    assert.equal((await fetch(`${base}/v1/sync/push`, { method: 'POST', headers: { authorization, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(`${base}/v1/sync/push`, { method: 'POST', headers: { authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(101) }) })).status, 413);
    const content = '<script>alert(1)</script><p>Hello</p>';
    const hash = createHash('sha256').update(content).digest('hex');
    const endpoint = `${base}/v1/blobs/${hash}`;
    assert.equal((await fetch(endpoint, { method: 'PUT', headers: { authorization, 'Content-Type': 'text/html' }, body: content })).status, 201);
    const response = await fetch(endpoint, { headers: { authorization } });
    assert.equal(await response.text(), content);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-disposition')!, /^attachment/);
    assert.match(response.headers.get('content-security-policy')!, /sandbox/);
    assert.equal((await fetch(endpoint, { method: 'HEAD', headers: { authorization } })).status, 200);
    assert.equal((await fetch(endpoint, { headers: { authorization: `Bearer ${otherToken}` } })).status, 404);
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(`${base}/v1/blobs/${'0'.repeat(64)}`, { method: 'PUT', headers: { authorization }, body: content })).status, 422);
    assert.equal((await fetch(endpoint, { method: 'PUT', headers: { authorization }, body: 'x'.repeat(101) })).status, 413);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
