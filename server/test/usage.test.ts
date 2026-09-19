import assert from 'node:assert/strict';
import test from 'node:test';
import { validateUsage } from '../src/usage.ts';

const NOW = Date.parse('2026-09-19T12:00:00Z');
const upload = (days: unknown, extra: Record<string, unknown> = {}) => ({ deviceId: 'phone', platform: 'app', days, ...extra });

test('usage uploads are flattened to rows; names need not be known to this server', () => {
  const result = validateUsage(upload({ '2026-09-18': { 'articles.detail': 3, 'added-by-a-newer-client': 1 }, '2026-09-19': { speak: 2 } }), NOW);
  assert.deepEqual(result, { deviceId: 'phone', platform: 'app', ignored: 0, rows: [
    { day: '2026-09-18', event: 'articles.detail', count: 3 },
    { day: '2026-09-18', event: 'added-by-a-newer-client', count: 1 },
    { day: '2026-09-19', event: 'speak', count: 2 },
  ] });
  assert.deepEqual(validateUsage(upload({}), NOW).rows, []);
});

test('days a sane clock could not produce are dropped and counted, not rejected', () => {
  // A rejection would make a device with a wrong date resend the same payload forever.
  const result = validateUsage(upload({ '2031-01-01': { speak: 1, 'nav.words': 4 }, '2020-01-01': { speak: 1 }, '2026-09-20': { speak: 5 }, '2026-09-21': { speak: 6 } }), NOW);
  assert.equal(result.ignored, 3);
  // The client's local today can be the server's tomorrow.
  assert.deepEqual(result.rows.map(row => row.day), ['2026-09-20', '2026-09-21']);
});

test('malformed uploads are refused', () => {
  const refused = (value: unknown, message: RegExp) => assert.throws(() => validateUsage(value, NOW), message);
  refused(null, /JSON object/);
  refused({ platform: 'app', days: {} }, /deviceId/);
  refused(upload({}, { platform: 'desktop' }), /platform/);
  refused(upload([]), /JSON object/);
  refused(upload({ yesterday: { speak: 1 } }), /Invalid day/);
  // PostgreSQL would answer a day that does not exist with a 500.
  refused(upload({ '2026-02-31': { speak: 1 } }), /Invalid day/);
  refused(upload({ '2026-09-19': [] }), /JSON object/);
  refused(upload({ '2026-09-19': { 'Has Spaces': 1 } }), /event name/);
  refused(upload({ '2026-09-19': { ['x'.repeat(65)]: 1 } }), /event name/);
  for (const count of [0, -1, 1.5, '3', null, 2_000_000_000]) refused(upload({ '2026-09-19': { speak: count } }), /count/);
  const manyDays = Object.fromEntries(Array.from({ length: 121 }, (_, index) => [new Date(NOW - index * 86_400_000).toISOString().slice(0, 10), { speak: 1 }]));
  refused(upload(manyDays), /At most 120 days/);
  refused(upload({ '2026-09-19': Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`e${index}`, 1])) }), /At most 200 events/);
});
