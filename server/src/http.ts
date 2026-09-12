import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { bearerToken } from './auth.ts';
import type { Config } from './config.ts';
import type { Database } from './database.ts';
import { validateOperations } from './database.ts';
import { HttpError, badRequest, boundedInteger } from './errors.ts';
import type { FileStore } from './files.ts';
import { contentHash, safeMime, validateManifest } from './manifest.ts';

type HttpDatabase = Pick<Database, 'serverId' | 'authenticate' | 'healthy' | 'push' | 'pull' | 'snapshot' | 'blob' | 'uploadBlob' | 'publishArchive'>;

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function enforceLength(request: IncomingMessage, limit: number): void {
  const length = request.headers['content-length'];
  if (length !== undefined && Number(length) > limit) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds the configured limit');
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
  }
  enforceLength(request, limit);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds the configured limit');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { badRequest('Invalid JSON'); }
}

function numberQuery(url: URL, name: string, fallback: number, max: number): number {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) badRequest(`Invalid ${name}`);
  return boundedInteger(Number(value), name, name === 'limit' ? 1 : 0, max);
}

export function createHttpServer(config: Config, database: HttpDatabase, files: FileStore) {
  const checkArchiveFiles = async (userId: string, value: unknown) => {
    const manifest = validateManifest(value);
    const hashes = [...new Set([manifest.htmlHash, ...manifest.resources.map(resource => resource.hash)])];
    for (const hash of hashes) {
      const blob = await database.blob(userId, hash);
      if (!blob || !await files.exists(blob)) throw new HttpError(409, 'MISSING_BLOBS', 'Upload every referenced resource before publishing this archive');
    }
  };
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void (async () => {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      const origin = request.headers.origin;
      if (origin) {
        response.setHeader('Vary', 'Origin');
        if (!config.allowedOrigins.includes(origin)) throw new HttpError(403, 'ORIGIN_DENIED', 'Origin is not allowed by CORS_ORIGINS');
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Type,ETag');
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET,HEAD,PUT,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization,Content-Type',
          'Access-Control-Max-Age': '600',
        });
        response.end();
        return;
      }
      // A fixed base prevents untrusted Host headers from affecting parsing or routing.
      const url = new URL(request.url ?? '/', 'http://server.local');
      if (url.pathname === '/health' && request.method === 'GET') {
        try { await database.healthy(); json(response, 200, { status: 'ok', protocol: 1 }); }
        catch { json(response, 503, { status: 'unavailable' }); }
        return;
      }
      const user = await database.authenticate(bearerToken(request.headers.authorization));
      if (!user) throw new HttpError(401, 'UNAUTHORIZED', 'Token is invalid or revoked');
      if (url.pathname === '/v1/info' && request.method === 'GET') {
        json(response, 200, { serverId: database.serverId, userId: user.id, userName: user.name, protocol: 1 });
        return;
      }
      if (url.pathname === '/v1/sync/push' && request.method === 'POST') {
        const { deviceId, operations } = validateOperations(await readJson(request, config.maxJsonBytes));
        for (const operation of operations) if (operation.record.type === 'archive' && !operation.record.deleted) await checkArchiveFiles(user.id, operation.record.value);
        json(response, 200, await database.push(user.id, deviceId, operations));
        return;
      }
      if (url.pathname === '/v1/sync/pull' && request.method === 'GET') {
        const cursor = numberQuery(url, 'cursor', 0, Number.MAX_SAFE_INTEGER);
        const limit = numberQuery(url, 'limit', 200, 500);
        json(response, 200, await database.pull(user.id, cursor, limit));
        return;
      }
      if (url.pathname === '/v1/sync/snapshot' && request.method === 'GET') {
        const cursor = numberQuery(url, 'cursor', 0, Number.MAX_SAFE_INTEGER);
        const limit = numberQuery(url, 'limit', 200, 500);
        const token = url.searchParams.get('token') ?? undefined;
        if (token !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(token)) badRequest('Invalid snapshot token');
        json(response, 200, await database.snapshot(user.id, token, cursor, limit));
        return;
      }
      if (url.pathname === '/v1/archives' && request.method === 'POST') {
        const body = await readJson(request, config.maxJsonBytes);
        await checkArchiveFiles(user.id, body);
        json(response, 200, await database.publishArchive(user.id, body));
        return;
      }
      const blobMatch = /^\/v1\/blobs\/([^/]+)$/.exec(url.pathname);
      if (blobMatch) {
        const hash = contentHash(blobMatch[1]);
        if (request.method === 'PUT') {
          enforceLength(request, config.maxBlobBytes);
          const mime = safeMime(request.headers['content-type']?.split(';')[0]?.trim() ?? 'application/octet-stream');
          const blob = await database.uploadBlob(user.id, hash, config.maxUserBlobBytes,
            available => files.put(user.id, hash, mime, request.iterator({ destroyOnReturn: false }), available));
          json(response, 201, { hash: blob.hash, size: blob.size });
          return;
        }
        if (request.method === 'GET' || request.method === 'HEAD') {
          const blob = await database.blob(user.id, hash);
          if (!blob || !await files.exists(blob)) throw new HttpError(404, 'BLOB_NOT_FOUND', 'Resource is missing; upload it again');
          response.writeHead(200, {
            'Content-Type': blob.mime,
            'Content-Length': blob.size,
            'Content-Disposition': `attachment; filename="${blob.hash}"`,
            'Cache-Control': 'private, no-store',
            ETag: `"${blob.hash}"`,
          });
          if (request.method === 'HEAD') response.end();
          else await pipeline(files.read(blob), response);
          return;
        }
      }
      throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      if (!request.complete) {
        // Close rejected uploads rather than consuming an unlimited body on a keep-alive connection.
        response.setHeader('Connection', 'close');
        request.resume();
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
      // Never log request headers, request bodies, tokens, or SQL connection strings.
      if (status === 500) console.error('Request failed:', error instanceof Error ? error.name : 'UnknownError');
      json(response, status, {
        error: error instanceof HttpError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof HttpError ? error.message : 'Internal server error',
      });
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
