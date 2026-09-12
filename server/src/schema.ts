import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

// Migrations are immutable once released. Future migrations append a new entry.
const migrations = [
  `CREATE TABLE server_settings (
     key text PRIMARY KEY,
     value text NOT NULL
   );
   CREATE TABLE users (
     id uuid PRIMARY KEY,
     name text NOT NULL,
     head bigint NOT NULL DEFAULT 0 CHECK (head >= 0),
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE tokens (
     id uuid PRIMARY KEY,
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_hash text UNIQUE NOT NULL,
     label text NOT NULL,
     revoked_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE devices (
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     id text NOT NULL,
     last_seen_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, id)
   );
   CREATE TABLE records (
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     type text NOT NULL,
     id text NOT NULL,
     record jsonb NOT NULL,
     sequence bigint NOT NULL,
     PRIMARY KEY (user_id, type, id)
   );
   CREATE TABLE changes (
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     sequence bigint NOT NULL,
     record jsonb NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, sequence)
   );
   CREATE TABLE operations (
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     op_id text NOT NULL,
     payload_hash text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, op_id)
   );
   CREATE TABLE blobs (
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     hash text NOT NULL,
     storage_key text NOT NULL,
     size bigint NOT NULL CHECK (size >= 0),
     mime text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, hash),
     UNIQUE (storage_key)
   );
   CREATE TABLE archive_versions (
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     article_id text NOT NULL,
     version text NOT NULL,
     manifest jsonb NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, article_id, version)
   );
   CREATE TABLE archive_resources (
     user_id uuid NOT NULL,
     article_id text NOT NULL,
     version text NOT NULL,
     hash text NOT NULL,
     PRIMARY KEY (user_id, article_id, version, hash),
     FOREIGN KEY (user_id, article_id, version) REFERENCES archive_versions(user_id, article_id, version) ON DELETE CASCADE,
     FOREIGN KEY (user_id, hash) REFERENCES blobs(user_id, hash)
   );`,
  `CREATE TABLE sync_snapshots (
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token uuid NOT NULL,
     head bigint NOT NULL,
     expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
     PRIMARY KEY (user_id, token)
   );
   CREATE TABLE sync_snapshot_items (
     user_id uuid NOT NULL,
     token uuid NOT NULL,
     ordinal bigint NOT NULL,
     record jsonb NOT NULL,
     PRIMARY KEY (user_id, token, ordinal),
     FOREIGN KEY (user_id, token) REFERENCES sync_snapshots(user_id, token) ON DELETE CASCADE
   );`,
  `ALTER TABLE operations ADD COLUMN record jsonb;`,
];

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1947248, 1)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await client.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map(row => row.version));
    if ([...applied].some(version => version > migrations.length)) throw new Error('Database schema is newer than this server');
    for (let index = 0; index < migrations.length; index++) {
      if (applied.has(index + 1)) continue;
      await client.query(migrations[index]!);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [index + 1]);
    }
    await client.query("INSERT INTO server_settings(key, value) VALUES ('server_id', $1) ON CONFLICT (key) DO NOTHING", [randomUUID()]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
