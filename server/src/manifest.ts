import { badRequest, boundedInteger, identifier, object } from './errors.ts';

export interface ArchiveResource { hash: string; mime: string; size: number }
export interface ArchiveManifest {
  articleId: string;
  version: string;
  title: string;
  url: string;
  htmlHash: string;
  resources: ArchiveResource[];
  missingResources: string[];
  createdTs: number;
}

export function contentHash(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) badRequest('Invalid SHA-256 hash');
  return input;
}

export function safeMime(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(input) || input.length > 120) {
    badRequest('Invalid content type');
  }
  return input.toLowerCase();
}

export function validateManifest(input: unknown): ArchiveManifest {
  const raw = object(input);
  const url = identifier(raw.url, 'url', 8192);
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) badRequest('Article URL must use HTTP or HTTPS');
  } catch { badRequest('Invalid article URL'); }
  if (typeof raw.title !== 'string' || raw.title.length > 4096) badRequest('Invalid title');
  if (!Array.isArray(raw.resources) || raw.resources.length > 5000) badRequest('Invalid resources');
  if (!Array.isArray(raw.missingResources) || raw.missingResources.length > 5000) badRequest('Invalid missing resources');
  const hashes = new Map<string, number>();
  const resources = raw.resources.map(value => {
    const resource = object(value);
    const hash = contentHash(resource.hash);
    const size = boundedInteger(resource.size, 'resource size');
    if (hashes.has(hash) && hashes.get(hash) !== size) badRequest('Conflicting sizes for one resource hash');
    hashes.set(hash, size);
    return { hash, size, mime: safeMime(resource.mime) };
  });
  return {
    articleId: identifier(raw.articleId, 'articleId'),
    version: identifier(raw.version, 'version'),
    title: raw.title,
    url,
    htmlHash: contentHash(raw.htmlHash),
    resources,
    missingResources: raw.missingResources.map(value => identifier(value, 'missing resource', 8192)),
    createdTs: boundedInteger(raw.createdTs, 'createdTs'),
  };
}
