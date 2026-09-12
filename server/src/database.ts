import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { mergeRecord, validateRecord } from '../../src/sync/protocol.ts';
import type { SyncRecord } from '../../src/sync/protocol.ts';
import { generateToken, hashToken } from './auth.ts';
import { HttpError, badRequest, identifier, object } from './errors.ts';
import type { StoredBlob } from './files.ts';
import { validateManifest } from './manifest.ts';
import type { ArchiveManifest } from './manifest.ts';
import { migrate } from './schema.ts';

export interface User { id: string; name: string }
export interface Operation { opId: string; record: SyncRecord }
export interface PullResult { records: SyncRecord[]; cursor: number; hasMore: boolean }
export interface PushResult { accepted: string[]; head: number }
export interface SnapshotResult extends PullResult { token: string; head: number; expiresAt: string }

function byteBoundedPage<T extends { record: SyncRecord }>(rows: T[], limit: number): T[] {
  let bytes = 0;
  const result: T[] = [];
  for (const row of rows.slice(0, limit)) {
    const size = Buffer.byteLength(JSON.stringify(row.record));
    if (result.length && bytes + size > 2 * 1024 * 1024) break;
    result.push(row);
    bytes += size;
  }
  return result;
}

// JSONB changes object key order, so payload hashes must use a canonical encoding.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const data = value as Record<string, unknown>;
  return `{${Object.keys(data).filter(key => data[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(data[key])}`).join(',')}}`;
}

export function validateOperations(input: unknown): { deviceId: string; operations: Operation[] } {
  const raw = object(input);
  const deviceId = identifier(raw.deviceId, 'deviceId');
  if (!Array.isArray(raw.operations) || raw.operations.length > 200) badRequest('At most 200 operations may be pushed at once');
  const operations = raw.operations.map(value => {
    const operation = object(value);
    const opId = identifier(operation.opId, 'opId');
    let record: SyncRecord;
    try { record = validateRecord(operation.record); }
    catch (error) { badRequest(error instanceof Error ? error.message : 'Invalid sync record'); }
    return { opId, record };
  });
  return { deviceId, operations };
}

export class Database {
  readonly pool: pg.Pool;
  serverId = '';
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
    this.pool.on('error', error => { console.error('Idle database connection failed:', error.message); });
  }

  async init(): Promise<void> {
    await migrate(this.pool);
    this.serverId = (await this.pool.query<{ value: string }>("SELECT value FROM server_settings WHERE key='server_id'")).rows[0]!.value;
  }

  async close(): Promise<void> { await this.pool.end(); }
  async healthy(): Promise<boolean> { await this.pool.query('SELECT 1'); return true; }

  async authenticate(token: string): Promise<User | undefined> {
    return (await this.pool.query<User>(
      'SELECT u.id, u.name FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.revoked_at IS NULL',
      [hashToken(token)],
    )).rows[0];
  }

  async createUser(name: string): Promise<{ user: User; tokenId: string; token: string }> {
    identifier(name, 'name', 200);
    const user = { id: randomUUID(), name };
    const tokenId = randomUUID();
    const token = generateToken();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO users(id,name) VALUES ($1,$2)', [user.id, user.name]);
      await client.query('INSERT INTO tokens(id,user_id,token_hash,label) VALUES ($1,$2,$3,$4)', [tokenId, user.id, hashToken(token), 'initial']);
      await client.query('COMMIT');
      return { user, tokenId, token };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async issueToken(userId: string, label: string): Promise<{ tokenId: string; token: string }> {
    const tokenId = randomUUID();
    const token = generateToken();
    const result = await this.pool.query(
      'INSERT INTO tokens(id,user_id,token_hash,label) SELECT $1,id,$3,$4 FROM users WHERE id=$2 RETURNING id',
      [tokenId, userId, hashToken(token), identifier(label, 'label', 200)],
    );
    if (!result.rowCount) throw new Error('User does not exist');
    return { tokenId, token };
  }

  async revokeToken(tokenId: string): Promise<boolean> {
    return (await this.pool.query('UPDATE tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 RETURNING id', [tokenId])).rowCount === 1;
  }

  async transaction<T>(userId: string, task: (client: PoolClient, head: number) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The head is allocated and committed under this user lock. A pull can never skip
      // an earlier uncommitted sequence just because a later request committed first.
      const user = (await client.query<{ head: string }>('SELECT head FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
      if (!user) throw new HttpError(401, 'UNAUTHORIZED', 'User no longer exists');
      const head = Number(user.head);
      if (!Number.isSafeInteger(head)) throw new Error('Sync sequence exceeds protocol range');
      const result = await task(client, head);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async apply(client: PoolClient, userId: string, head: number, operations: Operation[]): Promise<PushResult> {
    const accepted: string[] = [];
    for (const operation of operations) {
      const opId = identifier(operation.opId, 'opId');
      let record: SyncRecord;
      try { record = validateRecord(operation.record); }
      catch (error) { badRequest(error instanceof Error ? error.message : 'Invalid sync record'); }
      const payloadHash = createHash('sha256').update(canonical(record)).digest('hex');
      const receipt = (await client.query<{ payload_hash: string }>('SELECT payload_hash FROM operations WHERE user_id=$1 AND op_id=$2', [userId, opId])).rows[0];
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new HttpError(409, 'OPERATION_REUSED', 'Operation ID was already used with a different payload');
        accepted.push(opId);
        continue;
      }
      const current = (await client.query<{ record: SyncRecord }>('SELECT record FROM records WHERE user_id=$1 AND type=$2 AND id=$3', [userId, record.type, record.id])).rows[0]?.record;
      const merged = mergeRecord(current, record);
      if (!current || canonical(current) !== canonical(merged)) {
        if (merged.type === 'archive' && !merged.deleted) {
          const manifest = validateManifest(merged.value);
          if (manifest.articleId !== merged.id) badRequest('Archive record id must match articleId');
          await this.saveArchive(client, userId, manifest);
        }
        head++;
        if (!Number.isSafeInteger(head)) throw new Error('Sync sequence exceeds protocol range');
        await client.query(
          'INSERT INTO records(user_id,type,id,record,sequence) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(user_id,type,id) DO UPDATE SET record=EXCLUDED.record,sequence=EXCLUDED.sequence',
          [userId, merged.type, merged.id, JSON.stringify(merged), head],
        );
        await client.query('INSERT INTO changes(user_id,sequence,record) VALUES ($1,$2,$3)', [userId, head, JSON.stringify(merged)]);
      }
      await client.query('INSERT INTO operations(user_id,op_id,payload_hash,record) VALUES ($1,$2,$3,$4)', [userId, opId, payloadHash, JSON.stringify(record)]);
      accepted.push(opId);
    }
    await client.query('UPDATE users SET head=$2 WHERE id=$1', [userId, head]);
    return { accepted, head };
  }

  async push(userId: string, deviceId: string, operations: Operation[]): Promise<PushResult> {
    return this.transaction(userId, async (client, head) => {
      await client.query('INSERT INTO devices(user_id,id) VALUES ($1,$2) ON CONFLICT(user_id,id) DO UPDATE SET last_seen_at=now()', [userId, deviceId]);
      return this.apply(client, userId, head, operations);
    });
  }

  async pull(userId: string, cursor: number, limit: number): Promise<PullResult> {
    const user = (await this.pool.query<{ head: string }>('SELECT head FROM users WHERE id=$1', [userId])).rows[0];
    if (!user) throw new HttpError(401, 'UNAUTHORIZED', 'User no longer exists');
    if (cursor > Number(user.head)) throw new HttpError(409, 'CURSOR_AHEAD', 'Server state is older than this device; reset this connection cursor and merge again');
    const rows = (await this.pool.query<{ sequence: string; record: SyncRecord }>(
      'SELECT sequence,record FROM changes WHERE user_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',
      [userId, cursor, limit + 1],
    )).rows;
    const page = byteBoundedPage(rows, limit);
    return { records: page.map(row => row.record), cursor: page.length ? Number(page[page.length - 1]!.sequence) : cursor, hasMore: rows.length > page.length };
  }

  async snapshot(userId: string, token: string | undefined, cursor: number, limit: number): Promise<SnapshotResult> {
    if (!token) {
      if (cursor !== 0) badRequest('A new snapshot must start at cursor zero');
      token = randomUUID();
      const snapshotToken = token;
      await this.transaction(userId, async (client, head) => {
        await client.query('DELETE FROM sync_snapshots WHERE user_id=$1 AND expires_at<now()', [userId]);
        // Limit retained snapshots so repeated initialization cannot exhaust storage.
        const count = Number((await client.query<{ count: string }>('SELECT count(*) FROM sync_snapshots WHERE user_id=$1', [userId])).rows[0]!.count);
        if (count >= 8) throw new HttpError(429, 'SNAPSHOT_LIMIT', 'Resume an existing snapshot or wait for older snapshots to expire');
        await client.query('INSERT INTO sync_snapshots(user_id,token,head) VALUES ($1,$2,$3)', [userId, snapshotToken, head]);
        await client.query('INSERT INTO sync_snapshot_items(user_id,token,ordinal,record) SELECT user_id,$2,row_number() OVER (ORDER BY type,id),record FROM records WHERE user_id=$1', [userId, snapshotToken]);
      });
    }
    const info = (await this.pool.query<{ head: string; expires_at: Date }>('SELECT head,expires_at FROM sync_snapshots WHERE user_id=$1 AND token=$2 AND expires_at>now()', [userId, token])).rows[0];
    if (!info) throw new HttpError(410, 'SNAPSHOT_EXPIRED', 'Snapshot expired or does not belong to this user; begin a new snapshot');
    const rows = (await this.pool.query<{ ordinal: string; record: SyncRecord }>('SELECT ordinal,record FROM sync_snapshot_items WHERE user_id=$1 AND token=$2 AND ordinal>$3 ORDER BY ordinal LIMIT $4', [userId, token, cursor, limit + 1])).rows;
    const page = byteBoundedPage(rows, limit);
    return { token, head: Number(info.head), expiresAt: info.expires_at.toISOString(), records: page.map(row => row.record), cursor: page.length ? Number(page[page.length - 1]!.ordinal) : cursor, hasMore: rows.length > page.length };
  }

  async blob(userId: string, hash: string): Promise<StoredBlob | undefined> {
    const row = (await this.pool.query<{ hash: string; storage_key: string; size: string; mime: string }>(
      'SELECT hash,storage_key,size,mime FROM blobs WHERE user_id=$1 AND hash=$2', [userId, hash],
    )).rows[0];
    return row ? { hash: row.hash, storageKey: row.storage_key, size: Number(row.size), mime: row.mime } : undefined;
  }

  async saveBlob(userId: string, blob: StoredBlob, quota: number): Promise<void> {
    await this.transaction(userId, async client => {
      const existing = (await client.query<{ size: string }>('SELECT size FROM blobs WHERE user_id=$1 AND hash=$2', [userId, blob.hash])).rows[0];
      if (existing) {
        if (Number(existing.size) !== blob.size) throw new HttpError(409, 'BLOB_CONFLICT', 'Resource metadata conflicts with its content');
        return;
      }
      const used = Number((await client.query<{ used: string }>('SELECT COALESCE(sum(size),0) AS used FROM blobs WHERE user_id=$1', [userId])).rows[0]!.used);
      if (used + blob.size > quota) throw new HttpError(413, 'QUOTA_EXCEEDED', 'User resource storage quota exceeded');
      await client.query('INSERT INTO blobs(user_id,hash,storage_key,size,mime) VALUES ($1,$2,$3,$4,$5)', [userId, blob.hash, blob.storageKey, blob.size, blob.mime]);
    });
  }

  async uploadBlob(userId: string, hash: string, quota: number, write: (availableBytes: number) => Promise<StoredBlob>): Promise<StoredBlob> {
    // Serializing uploads per user also makes quota reservations reliable. The stream is
    // bounded by HTTP time/size limits; rejected uploads never become durable blob files.
    return this.transaction(userId, async client => {
      const existing = (await client.query<{ size: string }>('SELECT size FROM blobs WHERE user_id=$1 AND hash=$2', [userId, hash])).rows[0];
      const used = Number((await client.query<{ used: string }>('SELECT COALESCE(sum(size),0) AS used FROM blobs WHERE user_id=$1', [userId])).rows[0]!.used);
      const available = existing ? Number(existing.size) : Math.max(0, quota - used);
      const blob = await write(available);
      if (blob.hash !== hash || blob.size > available) throw new Error('Invalid upload result');
      if (!existing) await client.query('INSERT INTO blobs(user_id,hash,storage_key,size,mime) VALUES ($1,$2,$3,$4,$5)', [userId, blob.hash, blob.storageKey, blob.size, blob.mime]);
      return blob;
    });
  }

  private async saveArchive(client: PoolClient, userId: string, manifest: ArchiveManifest): Promise<void> {
    const hashes = [...new Set([manifest.htmlHash, ...manifest.resources.map(resource => resource.hash)])];
    const rows = (await client.query<{ hash: string; size: string }>('SELECT hash,size FROM blobs WHERE user_id=$1 AND hash=ANY($2::text[])', [userId, hashes])).rows;
    const blobs = new Map(rows.map(row => [row.hash, Number(row.size)]));
    if (hashes.some(hash => !blobs.has(hash))) throw new HttpError(409, 'MISSING_BLOBS', 'Upload every referenced resource before publishing this archive');
    if (manifest.resources.some(resource => blobs.get(resource.hash) !== resource.size)) badRequest('Manifest resource size does not match uploaded content');
    const previous = (await client.query<{ manifest: ArchiveManifest }>('SELECT manifest FROM archive_versions WHERE user_id=$1 AND article_id=$2 AND version=$3', [userId, manifest.articleId, manifest.version])).rows[0];
    if (previous) {
      if (canonical(previous.manifest) !== canonical(manifest)) throw new HttpError(409, 'ARCHIVE_VERSION_REUSED', 'An archive version is immutable; create a new version for changed content');
      return;
    }
    await client.query('INSERT INTO archive_versions(user_id,article_id,version,manifest) VALUES ($1,$2,$3,$4)', [userId, manifest.articleId, manifest.version, JSON.stringify(manifest)]);
    await client.query('INSERT INTO archive_resources(user_id,article_id,version,hash) SELECT $1,$2,$3,unnest($4::text[])', [userId, manifest.articleId, manifest.version, hashes]);
  }

  async publishArchive(userId: string, input: unknown): Promise<PushResult & { record: SyncRecord }> {
    const raw = object(input);
    const manifest = validateManifest(input);
    return this.transaction(userId, async (client, head) => {
      // Preserve explicit captured versions even if a concurrent version wins the
      // current archive pointer. Uploaded resources must remain reachable.
      await this.saveArchive(client, userId, manifest);
      const current = (await client.query<{ record: SyncRecord }>("SELECT record FROM records WHERE user_id=$1 AND type='archive' AND id=$2", [userId, manifest.articleId])).rows[0]?.record;
      // Requests without a client stamp need a receipt independent of the current
      // pointer; otherwise retrying version A after version B could republish A.
      const unstampedOpId = raw.stamp === undefined ? (raw.opId === undefined
        ? `archive:${createHash('sha256').update(canonical(manifest)).digest('hex')}`
        : identifier(raw.opId, 'opId')) : undefined;
      if (unstampedOpId) {
        const previous = (await client.query<{ record: SyncRecord | null }>('SELECT record FROM operations WHERE user_id=$1 AND op_id=$2', [userId, unstampedOpId])).rows[0]?.record;
        if (previous) {
          if (previous.type !== 'archive' || previous.id !== manifest.articleId || canonical(previous.value) !== canonical(manifest)
            || (raw.generation !== undefined && raw.generation !== previous.generation)) {
            throw new HttpError(409, 'OPERATION_REUSED', 'Operation ID was already used with a different payload');
          }
          return { accepted: [unstampedOpId], head, record: current ?? previous };
        }
      }
      let record: SyncRecord;
      // Repeated plain-manifest requests preserve the original generated stamp.
      if (raw.stamp === undefined && current && !current.deleted && canonical(current.value) === canonical(manifest)) record = current;
      else {
        try {
          record = validateRecord({
            type: 'archive', id: manifest.articleId, value: manifest,
            stamp: raw.stamp ?? { counter: (current?.stamp.counter ?? 0) + 1, deviceId: 'server' },
            generation: raw.generation ?? current?.generation ?? 'initial', deleted: false,
            articleId: manifest.articleId,
          });
        } catch (error) { badRequest(error instanceof Error ? error.message : 'Invalid archive stamp'); }
      }
      const opId = unstampedOpId ?? (raw.opId === undefined ? `archive:${createHash('sha256').update(canonical(record)).digest('hex')}` : identifier(raw.opId, 'opId'));
      const result = await this.apply(client, userId, head, [{ opId, record }]);
      const stored = (await client.query<{ record: SyncRecord }>("SELECT record FROM records WHERE user_id=$1 AND type='archive' AND id=$2", [userId, manifest.articleId])).rows[0]!.record;
      return { ...result, record: stored };
    });
  }
}
