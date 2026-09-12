import { resolve } from 'node:path';

export interface Config {
  databaseUrl: string;
  dataDir: string;
  host: string;
  port: number;
  allowedOrigins: string[];
  maxJsonBytes: number;
  maxBlobBytes: number;
  maxUserBlobBytes: number;
}

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const port = positive(env.PORT, 8787, 'PORT');
  if (port > 65535) throw new Error('PORT must be at most 65535');
  const allowedOrigins = (env.CORS_ORIGINS ?? 'https://appassets.androidplatform.net').split(',').map(v => v.trim()).filter(Boolean);
  if (allowedOrigins.includes('*')) throw new Error('CORS_ORIGINS must list explicit origins; wildcard is not supported');
  return {
    databaseUrl: env.DATABASE_URL,
    dataDir: resolve(env.DATA_DIR ?? './data'),
    host: env.HOST ?? '0.0.0.0',
    port,
    allowedOrigins,
    maxJsonBytes: positive(env.MAX_JSON_BYTES, 16 * 1024 * 1024, 'MAX_JSON_BYTES'),
    maxBlobBytes: positive(env.MAX_BLOB_BYTES, 32 * 1024 * 1024, 'MAX_BLOB_BYTES'),
    maxUserBlobBytes: positive(env.MAX_USER_BLOB_BYTES, 2 * 1024 * 1024 * 1024, 'MAX_USER_BLOB_BYTES'),
  };
}
