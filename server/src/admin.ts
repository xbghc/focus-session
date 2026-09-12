import { randomUUID } from 'node:crypto';
import { readConfig } from './config.ts';
import { Database } from './database.ts';

function uuid(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new Error('Expected a UUID');
  return value;
}

async function main(): Promise<void> {
  const [command, argument, label] = process.argv.slice(2);
  const supported = ['create-user', 'issue-token', 'revoke-token', 'list-users', 'list-tokens', 'migrate', 'rotate-server-id'];
  if (!command || !supported.includes(command)) {
    console.log('Usage: npm run admin -- create-user <name> | issue-token <userId> [label] | revoke-token <tokenId> | list-users | list-tokens <userId> | migrate | rotate-server-id');
    process.exitCode = 1;
    return;
  }
  const database = new Database(readConfig().databaseUrl);
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
    } else console.log('Database migrations applied.');
  } finally { await database.close(); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Administration command failed');
  process.exitCode = 1;
});
