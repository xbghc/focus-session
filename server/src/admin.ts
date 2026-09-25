import { randomUUID } from 'node:crypto';
import { RECORD_TYPES } from '../../src/sync/protocol.ts';
import { readConfig } from './config.ts';
import { Database } from './database.ts';
import { checkIntegrity, collectStats, showRecord } from './diagnostics.ts';
import { FileStore } from './files.ts';
import { usageReport } from './usage.ts';
import { LOG_KINDS, logsReport, type LogKind } from './clientLogs.ts';

function uuid(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new Error('Expected a UUID');
  return value;
}

async function main(): Promise<void> {
  const [command, argument, label, recordId] = process.argv.slice(2);
  const supported = ['create-user', 'issue-token', 'revoke-token', 'list-users', 'list-tokens', 'migrate', 'rotate-server-id', 'stats', 'check', 'show-record', 'usage', 'logs'];
  if (!command || !supported.includes(command)) {
    console.log('Usage: npm run admin -- create-user <name> | issue-token <userId> [label] | revoke-token <tokenId> | list-users | list-tokens <userId> | migrate | rotate-server-id'
      + ' | stats | check [userId] | show-record <userId> <type> <id> | usage [userId]'
      + ` | logs [userId] [--hours=24] [--kind=${LOG_KINDS.join('|')}] [--all] [--limit=100]`);
    process.exitCode = 1;
    return;
  }
  const config = readConfig();
  const database = new Database(config.databaseUrl);
  try {
    await database.init();
    if (command === 'create-user') {
      if (!argument) throw new Error('User name is required');
      console.log(JSON.stringify(await database.createUser(argument), null, 2));
      console.log('Store the token securely; the server only retains its hash.');
    } else if (command === 'issue-token') {
      console.log(JSON.stringify(await database.issueToken(uuid(argument), label ?? 'device'), null, 2));
      console.log('Store the token securely; the server only retains its hash.');
    } else if (command === 'revoke-token') {
      if (!await database.revokeToken(uuid(argument))) throw new Error('Token does not exist');
      console.log('Token revoked.');
    } else if (command === 'list-users') {
      console.log(JSON.stringify((await database.pool.query('SELECT id,name,created_at FROM users ORDER BY created_at')).rows, null, 2));
    } else if (command === 'list-tokens') {
      console.log(JSON.stringify((await database.pool.query('SELECT id,label,created_at,revoked_at FROM tokens WHERE user_id=$1 ORDER BY created_at', [uuid(argument)])).rows, null, 2));
    } else if (command === 'rotate-server-id') {
      const serverId = randomUUID();
      await database.pool.query("UPDATE server_settings SET value=$1 WHERE key='server_id'", [serverId]);
      console.log(JSON.stringify({ serverId, message: 'Restart all backend instances before accepting connections. Devices must explicitly bind to the restored server identity.' }, null, 2));
    } else if (command === 'stats') {
      console.log(JSON.stringify(await collectStats(database.pool), null, 2));
    } else if (command === 'check') {
      const report = await checkIntegrity(database.pool, new FileStore(config.dataDir, config.maxBlobBytes), argument === undefined ? undefined : uuid(argument));
      console.log(JSON.stringify(report, null, 2));
      // Warnings are leftovers a healthy server may carry; only errors fail a scheduled check.
      if (!report.ok) process.exitCode = 1;
    } else if (command === 'usage') {
      console.log(JSON.stringify(await usageReport(database.pool, argument === undefined ? undefined : uuid(argument)), null, 2));
    } else if (command === 'logs') {
      const args = process.argv.slice(3);
      const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
      const positional = args.find(a => !a.startsWith('--'));
      const hours = Number(flag('hours') ?? 24);
      const limit = Number(flag('limit') ?? 100);
      const kind = flag('kind');
      if (!Number.isSafeInteger(hours) || hours < 1 || hours > 24 * 90) throw new Error('--hours must be 1..2160');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error('--limit must be 1..5000');
      if (kind !== undefined && !(LOG_KINDS as readonly string[]).includes(kind)) throw new Error(`--kind must be one of ${LOG_KINDS.join(', ')}`);
      console.log(JSON.stringify(await logsReport(database.pool, {
        userId: positional === undefined ? undefined : uuid(positional), hours, limit, kind: kind as LogKind | undefined, all: args.includes('--all'),
      }), null, 2));
    } else if (command === 'show-record') {
      if (!(RECORD_TYPES as readonly string[]).includes(label ?? '') || !recordId) throw new Error(`Expected a record type (${RECORD_TYPES.join(', ')}) and a record id`);
      console.log(JSON.stringify(await showRecord(database.pool, uuid(argument), label!, recordId), null, 2));
    } else console.log('Database migrations applied.');
  } finally { await database.close(); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Administration command failed');
  process.exitCode = 1;
});
