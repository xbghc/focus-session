import type pg from 'pg';
import { validateRecord } from '../../src/sync/protocol.ts';
import type { SyncRecord } from '../../src/sync/protocol.ts';
import type { FileStore, StoredBlob } from './files.ts';

// Operator diagnostics behind the admin command. `collectStats` and `checkIntegrity` report
// counts, sizes and identifiers only; `showRecord` is the one call that returns stored content.

const count = (value: unknown): number => Number(value ?? 0);
const STORAGE_KEY = /^users\/([a-f0-9-]{36})\/blobs\/[a-f0-9]{2}\/[a-f0-9]{64}$/i;

async function userStats(pool: pg.Pool, user: { id: string; name: string; head: string }) {
  const rows = async (text: string) => (await pool.query(text, [user.id])).rows;
  const records = await rows(`SELECT type, count(*) FILTER (WHERE record->>'deleted'='false') AS live, count(*) FILTER (WHERE record->>'deleted'='true') AS deleted,
    sum(octet_length(record::text)) AS bytes, max(octet_length(record::text)) AS largest FROM records WHERE user_id=$1 GROUP BY type ORDER BY type`);
  const changes = await rows(`SELECT record->>'type' AS type, count(*) AS count, sum(octet_length(record::text)) AS bytes FROM changes WHERE user_id=$1 GROUP BY 1 ORDER BY 1`);
  const span = (await rows('SELECT min(created_at) AS first, max(created_at) AS last FROM changes WHERE user_id=$1'))[0]!;
  const operations = (await rows('SELECT count(*) AS count, COALESCE(sum(octet_length(record::text)),0) AS bytes FROM operations WHERE user_id=$1'))[0]!;
  const snapshots = (await rows(`SELECT count(*) FILTER (WHERE expires_at>now()) AS active, count(*) FILTER (WHERE expires_at<=now()) AS expired,
    (SELECT count(*) FROM sync_snapshot_items WHERE user_id=$1) AS items FROM sync_snapshots WHERE user_id=$1`))[0]!;
  const blobs = (await rows('SELECT count(*) AS count, COALESCE(sum(size),0) AS bytes FROM blobs WHERE user_id=$1'))[0]!;
  const archives = (await rows('SELECT count(DISTINCT article_id) AS articles, count(*) AS versions FROM archive_versions WHERE user_id=$1'))[0]!;
  const tokens = (await rows('SELECT count(*) FILTER (WHERE revoked_at IS NULL) AS active, count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked FROM tokens WHERE user_id=$1'))[0]!;
  const devices = await rows('SELECT id, last_seen_at FROM devices WHERE user_id=$1 ORDER BY last_seen_at DESC');
  const largest = await rows('SELECT type, id, octet_length(record::text) AS bytes FROM records WHERE user_id=$1 ORDER BY bytes DESC LIMIT 10');
  // Records rewritten most often dominate the change log every device has to replay.
  const rewritten = await rows(`SELECT record->>'type' AS type, record->>'id' AS id, count(*) AS changes FROM changes WHERE user_id=$1 GROUP BY 1,2 HAVING count(*)>1 ORDER BY changes DESC LIMIT 10`);
  return {
    id: user.id, name: user.name, head: count(user.head),
    records: records.map(row => ({ type: row.type as string, live: count(row.live), deleted: count(row.deleted), bytes: count(row.bytes), largestBytes: count(row.largest) })),
    changes: { first: span.first as Date | null, last: span.last as Date | null, byType: changes.map(row => ({ type: row.type as string, count: count(row.count), bytes: count(row.bytes) })) },
    operations: { count: count(operations.count), bytes: count(operations.bytes) },
    snapshots: { active: count(snapshots.active), expired: count(snapshots.expired), items: count(snapshots.items) },
    blobs: { count: count(blobs.count), bytes: count(blobs.bytes) },
    archives: { articles: count(archives.articles), versions: count(archives.versions) },
    tokens: { active: count(tokens.active), revoked: count(tokens.revoked) },
    devices: devices.map(row => ({ id: row.id as string, lastSeenAt: row.last_seen_at as Date })),
    largestRecords: largest.map(row => ({ type: row.type as string, id: row.id as string, bytes: count(row.bytes) })),
    mostRewritten: rewritten.map(row => ({ type: row.type as string, id: row.id as string, changes: count(row.changes) })),
  };
}

export async function collectStats(pool: pg.Pool) {
  const size = (await pool.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0]!;
  // Row counts here are planner estimates; per-user numbers below are exact.
  const tables = (await pool.query(`SELECT relname, n_live_tup, n_dead_tup, seq_scan, idx_scan, pg_total_relation_size(relid) AS bytes,
    pg_indexes_size(relid) AS index_bytes, last_autovacuum FROM pg_stat_user_tables WHERE schemaname=current_schema() ORDER BY bytes DESC`)).rows;
  const users = (await pool.query<{ id: string; name: string; head: string }>('SELECT id,name,head FROM users ORDER BY created_at')).rows;
  const result = [];
  for (const user of users) result.push(await userStats(pool, user));
  return {
    database: {
      bytes: count(size.bytes),
      tables: tables.map(row => ({ name: row.relname as string, estimatedRows: count(row.n_live_tup), deadRows: count(row.n_dead_tup), bytes: count(row.bytes),
        indexBytes: count(row.index_bytes), sequentialScans: count(row.seq_scan), indexScans: count(row.idx_scan), lastAutovacuum: row.last_autovacuum as Date | null })),
    },
    users: result,
  };
}

export interface Problem { severity: 'error' | 'warning'; kind: string; userId?: string; type?: string; id?: string; detail: string }
export interface IntegrityReport { ok: boolean; checked: { users: number; records: number; blobs: number; files: number }; truncated: boolean; problems: Problem[] }

const PROBLEM_LIMIT = 1000;

export async function checkIntegrity(pool: pg.Pool, files: FileStore, onlyUserId?: string): Promise<IntegrityReport> {
  const problems: Problem[] = [];
  const checked = { users: 0, records: 0, blobs: 0, files: 0 };
  const full = () => problems.length >= PROBLEM_LIMIT;
  const report = (problem: Problem) => { if (!full()) problems.push(problem); };
  const users = (await pool.query<{ id: string; head: string }>('SELECT id,head FROM users WHERE $1::uuid IS NULL OR id=$1 ORDER BY created_at', [onlyUserId ?? null])).rows;
  if (onlyUserId && !users.length) throw new Error('User does not exist');
  for (const user of users) {
    checked.users++;
    const userId = user.id;
    const head = count(user.head);
    // Pull cursors are positions in this log, so it must be exactly 1..head.
    const log = (await pool.query('SELECT count(*) AS count, COALESCE(min(sequence),0) AS first, COALESCE(max(sequence),0) AS last FROM changes WHERE user_id=$1', [userId])).rows[0]!;
    if (count(log.count) !== head || count(log.last) !== head || (head > 0 && count(log.first) !== 1)) {
      report({ severity: 'error', kind: 'log-gap', userId, detail: `head is ${head} but the change log holds ${count(log.count)} entries spanning ${count(log.first)}..${count(log.last)}` });
    }
    let after = { type: '', id: '' };
    while (!full()) {
      const page = (await pool.query<{ type: string; id: string; record: SyncRecord; sequence: string }>(
        'SELECT type,id,record,sequence FROM records WHERE user_id=$1 AND (type,id)>($2,$3) ORDER BY type,id LIMIT 500', [userId, after.type, after.id])).rows;
      if (!page.length) break;
      for (const row of page) {
        checked.records++;
        // Clients validate what they pull: a stored record this fails is one every device rejects.
        try { validateRecord(row.record); }
        catch (error) { report({ severity: 'error', kind: 'invalid-record', userId, type: row.type, id: row.id, detail: error instanceof Error ? error.message : 'Invalid sync record' }); }
        if (row.record.type !== row.type || row.record.id !== row.id) report({ severity: 'error', kind: 'key-mismatch', userId, type: row.type, id: row.id, detail: 'Row key differs from the identity inside the record' });
        if (count(row.sequence) > head) report({ severity: 'error', kind: 'sequence-ahead', userId, type: row.type, id: row.id, detail: `sequence ${row.sequence} is beyond head ${head}` });
      }
      after = page[page.length - 1]!;
    }
    const stale = (await pool.query<{ type: string; id: string }>(
      'SELECT r.type,r.id FROM records r LEFT JOIN changes c ON c.user_id=r.user_id AND c.sequence=r.sequence WHERE r.user_id=$1 AND (c.sequence IS NULL OR c.record<>r.record) ORDER BY r.type,r.id LIMIT $2',
      [userId, PROBLEM_LIMIT])).rows;
    for (const row of stale) report({ severity: 'error', kind: 'log-mismatch', userId, type: row.type, id: row.id, detail: 'Current record differs from the change log entry at its sequence; incremental pulls deliver something else' });
    const unversioned = (await pool.query<{ id: string }>(
      `SELECT r.id FROM records r WHERE r.user_id=$1 AND r.type='archive' AND r.record->>'deleted'='false' AND NOT EXISTS
        (SELECT 1 FROM archive_versions v WHERE v.user_id=r.user_id AND v.article_id=r.id AND v.version=r.record->'value'->>'version') ORDER BY r.id LIMIT $2`,
      [userId, PROBLEM_LIMIT])).rows;
    for (const row of unversioned) report({ severity: 'error', kind: 'archive-version-missing', userId, type: 'archive', id: row.id, detail: 'Archive record points at a version without a stored manifest' });
    const expired = (await pool.query('SELECT count(*) AS count FROM sync_snapshots WHERE user_id=$1 AND expires_at<=now()', [userId])).rows[0]!;
    if (count(expired.count)) report({ severity: 'warning', kind: 'expired-snapshots', userId, detail: `${count(expired.count)} expired snapshots still hold a full copy of the records; they are only purged when this user starts another snapshot` });
  }
  const known = new Set<string>();
  const blobs = (await pool.query<{ user_id: string; hash: string; storage_key: string; size: string; mime: string }>(
    'SELECT user_id,hash,storage_key,size,mime FROM blobs WHERE $1::uuid IS NULL OR user_id=$1', [onlyUserId ?? null])).rows;
  for (const row of blobs) {
    checked.blobs++;
    known.add(row.storage_key);
    const blob: StoredBlob = { hash: row.hash, storageKey: row.storage_key, size: Number(row.size), mime: row.mime };
    let present = false;
    try { present = await files.exists(blob); } catch { /* an invalid storage key is reported as missing */ }
    if (!present) report({ severity: 'error', kind: 'blob-file-missing', userId: row.user_id, id: row.hash, detail: 'Indexed resource is missing on disk or has a different size' });
  }
  for (const file of await files.list()) {
    const owner = STORAGE_KEY.exec(file.key)?.[1] ?? /^users\/([a-f0-9-]{36})\//i.exec(file.key)?.[1];
    if (onlyUserId && owner !== onlyUserId) continue;
    checked.files++;
    if (known.has(file.key)) continue;
    // Both kinds are expected after an aborted upload. Content-hash files must not be removed by age alone.
    if (file.key.endsWith('.upload')) report({ severity: 'warning', kind: 'upload-leftover', userId: owner, id: file.key, detail: `${file.size} bytes from an interrupted or in-flight upload` });
    else report({ severity: 'warning', kind: 'orphan-file', userId: owner, id: file.key, detail: `${file.size} bytes on disk without a resource index entry` });
  }
  return { ok: !problems.some(problem => problem.severity === 'error'), checked, truncated: full(), problems };
}

const HISTORY_LIMIT = 50;

export async function showRecord(pool: pg.Pool, userId: string, type: string, id: string) {
  const current = (await pool.query<{ sequence: string; record: SyncRecord }>('SELECT sequence,record FROM records WHERE user_id=$1 AND type=$2 AND id=$3', [userId, type, id])).rows[0];
  const filter = "user_id=$1 AND record->>'type'=$2 AND record->>'id'=$3";
  const total = (await pool.query(`SELECT count(*) AS count FROM changes WHERE ${filter}`, [userId, type, id])).rows[0]!;
  const history = (await pool.query<{ sequence: string; created_at: Date; record: SyncRecord }>(
    `SELECT sequence,created_at,record FROM changes WHERE ${filter} ORDER BY sequence DESC LIMIT ${HISTORY_LIMIT}`, [userId, type, id])).rows;
  // Receipts keep what each device sent, before merging.
  const operations = (await pool.query<{ op_id: string; created_at: Date; record: SyncRecord }>(
    `SELECT op_id,created_at,record FROM operations WHERE ${filter} ORDER BY created_at DESC LIMIT ${HISTORY_LIMIT}`, [userId, type, id])).rows;
  return {
    current: current ? { sequence: count(current.sequence), record: current.record } : null,
    changes: count(total.count),
    history: history.map(row => ({ sequence: count(row.sequence), createdAt: row.created_at, record: row.record })),
    operations: operations.map(row => ({ opId: row.op_id, createdAt: row.created_at, record: row.record })),
  };
}
