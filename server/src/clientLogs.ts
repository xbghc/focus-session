import { createHash } from 'node:crypto';
import type pg from 'pg';
import { canonical } from './database.ts';
import { badRequest, identifier, object } from './errors.ts';

// Diagnostic logs uploaded by clients that have sync enabled: LLM call failures (with the model's raw
// output and the selected text), call timings, translation traces, reader fetches and uncaught errors.
// They are what the settings page's "diagnostic log" export holds, so a failed translation on some
// device can be looked at here instead of asking for the file. Unlike ui_usage these do carry content.
// Kept outside the sync log: no device ever reads them back, and they expire.

export const LOG_KINDS = ['failure', 'timing', 'translation', 'fetch', 'error'] as const;
export type LogKind = (typeof LOG_KINDS)[number];
export const LOG_PLATFORMS = ['extension', 'app'] as const;

export interface LogEntry { kind: LogKind; key: string; ts: number; payload: Record<string, unknown> }
export interface LogUpload { deviceId: string; platform: (typeof LOG_PLATFORMS)[number]; version: string; entries: LogEntry[]; ignored: number }

// A client keeps at most 10 + 50 + 100 + 30 + 30 entries; the margin covers a retention change.
const MAX_ENTRIES = 500;
// A failure carries up to 16 000 characters of model output plus the request fields.
const MAX_ENTRY_BYTES = 256 * 1024;
export const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

/**
 * Structural problems reject the upload. Single entries that are too large or carry a timestamp no
 * sane clock produces are dropped and counted instead: rejecting them would make the device resend
 * the same batch forever.
 *
 * Translation traces are rewritten in place on the device under the same id, so the id is their key
 * and a later upload replaces the earlier one. The other kinds are append-only and keyed by content.
 */
export function validateLogs(input: unknown, now = Date.now()): LogUpload {
  const raw = object(input);
  const deviceId = identifier(raw.deviceId, 'deviceId');
  if (!(LOG_PLATFORMS as readonly unknown[]).includes(raw.platform)) badRequest('Invalid platform');
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) badRequest('Invalid version');
  if (!Array.isArray(raw.entries)) badRequest('Expected an entries array');
  if (raw.entries.length > MAX_ENTRIES) badRequest(`At most ${MAX_ENTRIES} entries may be uploaded at once`);
  const entries: LogEntry[] = [];
  let ignored = 0;
  for (const item of raw.entries) {
    const wrapper = object(item);
    if (!(LOG_KINDS as readonly unknown[]).includes(wrapper.kind)) badRequest('Invalid log kind');
    const kind = wrapper.kind as LogKind;
    const payload = object(wrapper.entry);
    const ts = payload.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) badRequest('Invalid entry timestamp');
    const text = canonical(payload);
    const plausible = ts > now - 400 * DAY_MS && ts < now + 2 * DAY_MS;
    if (!plausible || Buffer.byteLength(text) > MAX_ENTRY_BYTES) { ignored++; continue; }
    const key = kind === 'translation' && typeof payload.id === 'string' && payload.id.length > 0 && payload.id.length <= 128
      ? `id:${payload.id}`
      : `sha256:${createHash('sha256').update(text).digest('hex')}`;
    entries.push({ kind, key, ts, payload });
  }
  return { deviceId, platform: raw.platform as LogUpload['platform'], version: raw.version, entries, ignored };
}

export interface LogQuery { userId?: string; kind?: LogKind; hours: number; limit: number; all: boolean }

/**
 * What `admin logs` prints. The summary covers every kind in the window; the entry list defaults to
 * the ones that mean something went wrong — failures, uncaught errors, translations that did not
 * succeed — newest first. `--kind` lists one kind in full, `--all` everything.
 */
export async function logsReport(pool: pg.Pool, query: LogQuery) {
  const args: unknown[] = [query.userId ?? null, query.hours];
  const filter = `($1::uuid IS NULL OR user_id=$1) AND ts > now() - make_interval(hours => $2::int)`;
  if (query.userId && !(await pool.query('SELECT 1 FROM users WHERE id=$1', [query.userId])).rowCount) throw new Error('User does not exist');
  const devices = (await pool.query(`SELECT user_id, device_id, platform, version, max(received_at) AS last_upload,
      count(*) FILTER (WHERE kind='failure')::int AS failures, count(*) FILTER (WHERE kind='error')::int AS errors,
      count(*) FILTER (WHERE kind='translation')::int AS translations,
      count(*) FILTER (WHERE kind='translation' AND payload->>'status' <> 'success')::int AS translations_not_ok,
      count(*) FILTER (WHERE kind='timing')::int AS timings, count(*) FILTER (WHERE kind='fetch')::int AS fetches
    FROM client_logs WHERE ${filter} GROUP BY user_id, device_id, platform, version ORDER BY last_upload DESC`, args)).rows;
  const failures = (await pool.query(`SELECT payload->>'source' AS source, payload->>'kind' AS kind, payload->>'status' AS status,
      coalesce(payload->>'recovered', '') AS recovered, count(*)::int AS count, max(ts) AS last
    FROM client_logs WHERE ${filter} AND kind='failure' GROUP BY 1, 2, 3, 4 ORDER BY count DESC`, args)).rows;
  const translations = (await pool.query(`SELECT payload->>'status' AS status, count(*)::int AS count
    FROM client_logs WHERE ${filter} AND kind='translation' GROUP BY 1 ORDER BY count DESC`, args)).rows;
  const which = query.all ? 'true'
    : query.kind ? 'kind=$3'
    : `(kind IN ('failure','error') OR (kind='translation' AND payload->>'status' <> 'success'))`;
  const entryArgs = query.kind && !query.all ? [...args, query.kind, query.limit] : [...args, query.limit];
  const entries = (await pool.query(`SELECT kind, ts, user_id, device_id, platform, version, payload
    FROM client_logs WHERE ${filter} AND ${which} ORDER BY ts DESC LIMIT $${entryArgs.length}`, entryArgs)).rows;
  return { window: `${query.hours}h`, devices, failures, translations, shown: entries.length, entries };
}
