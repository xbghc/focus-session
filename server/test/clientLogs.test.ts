import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLogs } from '../src/clientLogs.ts';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const upload = (entries: unknown, extra: Record<string, unknown> = {}) => ({ deviceId: 'laptop', platform: 'extension', version: '0.3.15', entries, ...extra });
const failure = (extra: Record<string, unknown> = {}) => ({ kind: 'failure', entry: { ts: NOW - 60_000, source: 'translate', kind: 'parse', status: null, raw: '{"translation":', ...extra } });

test('entries keep their payload; append-only kinds are keyed by content, traces by id', () => {
  const trace = { kind: 'translation', entry: { id: 'abc', ts: NOW - 1000, status: 'error' } };
  const result = validateLogs(upload([failure(), failure(), trace, { ...trace, entry: { ...trace.entry, status: 'success' } }]), NOW);
  assert.deepEqual([result.deviceId, result.platform, result.version, result.ignored], ['laptop', 'extension', '0.3.15', 0]);
  assert.equal(result.entries[0]!.payload.raw, '{"translation":');
  // The same failure twice is one row on the server; a rewritten trace replaces the earlier upload.
  assert.equal(result.entries[0]!.key, result.entries[1]!.key);
  assert.match(result.entries[0]!.key, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual([result.entries[2]!.key, result.entries[3]!.key], ['id:abc', 'id:abc']);
  // Key order on the device does not change the content key.
  const reordered = validateLogs(upload([{ kind: 'failure', entry: { raw: '{"translation":', status: null, kind: 'parse', source: 'translate', ts: NOW - 60_000 } }]), NOW);
  assert.equal(reordered.entries[0]!.key, result.entries[0]!.key);
});

test('entries a sane clock could not produce, or too large to keep, are dropped and counted', () => {
  // A rejection would make the device resend the same batch forever.
  const result = validateLogs(upload([failure({ ts: Date.parse('2001-01-01') }), failure({ ts: NOW + 5 * 86_400_000 }), failure({ raw: 'x'.repeat(300_000) }), failure()]), NOW);
  assert.deepEqual([result.ignored, result.entries.length], [3, 1]);
});

test('malformed uploads are refused', () => {
  const refused = (value: unknown, message: RegExp) => assert.throws(() => validateLogs(value, NOW), message);
  refused(null, /JSON object/);
  refused(upload([], { deviceId: '' }), /deviceId/);
  refused(upload([], { platform: 'desktop' }), /platform/);
  refused(upload([], { version: 'v 1' }), /version/);
  refused(upload([], { version: undefined }), /version/);
  refused(upload({}), /entries array/);
  refused(upload([{ kind: 'secret', entry: { ts: NOW } }]), /log kind/);
  refused(upload([{ kind: 'failure', entry: [] }]), /JSON object/);
  refused(upload([{ kind: 'failure', entry: { ts: 'yesterday' } }]), /timestamp/);
  refused(upload(Array.from({ length: 501 }, () => failure())), /At most 500/);
});
