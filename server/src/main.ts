import { mkdir } from 'node:fs/promises';
import { readConfig } from './config.ts';
import { Database } from './database.ts';
import { FileStore } from './files.ts';
import { createHttpServer } from './http.ts';

async function main(): Promise<void> {
  const config = readConfig();
  const database = new Database(config.databaseUrl);
  try {
    await database.init();
    await mkdir(config.dataDir, { recursive: true });
  } catch (error) { await database.close(); throw error; }
  const files = new FileStore(config.dataDir, config.maxBlobBytes);
  const server = createHttpServer(config, database, files);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
  } catch (error) { await database.close(); throw error; }
  console.log(`Focus Session sync server listening on ${config.host}:${config.port}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => { server.closeAllConnections(); }, 10_000);
    timeout.unref();
    server.close(() => {
      clearTimeout(timeout);
      void database.close().then(() => { process.exitCode = 0; });
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch(error => {
  console.error('Server startup failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});
