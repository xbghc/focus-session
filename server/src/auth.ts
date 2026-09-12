import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './errors.ts';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): string {
  return `fs_${randomBytes(32).toString('base64url')}`;
}

export function bearerToken(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(header ?? '');
  if (!match) throw new HttpError(401, 'UNAUTHORIZED', 'A valid bearer token is required');
  return match[1]!;
}
