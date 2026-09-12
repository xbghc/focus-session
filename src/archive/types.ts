/** Article packages are immutable; only their current manifest is synchronized. */
import { normalizeUrl } from "../lib/url.ts";

export interface ArchiveResource {
  hash: string;
  mime: string;
  size: number;
}

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

export interface ArchiveCapture {
  articleId: string;
  url: string;
  title: string;
  html: string;
  resources: Array<{ url: string; mime?: string; base64?: string }>;
  missingResources: string[];
  createdTs: number;
}

export const ARCHIVES_KEY = "archives";
export const ARCHIVE_PENDING_KEY = "archivePending";
export const ARCHIVE_HASH = /^[a-f0-9]{64}$/;
export const ARCHIVE_SRC = /^fs-blob:([a-f0-9]{64})$/;
export const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 48 * 1024 * 1024;
export const MAX_ARCHIVE_IMAGES = 100;
export const IMAGE_MIME = /^image\/(?:png|jpeg|jpg|gif|webp|avif)$/i;

/** Runtime messages are untrusted, even when callers have TypeScript types. */
export function validateArchiveCapture(value: unknown): ArchiveCapture {
  const payload = value as ArchiveCapture | null;
  if (!payload || typeof payload !== "object" || typeof payload.html !== "string"
    || new TextEncoder().encode(payload.html).length > MAX_RESOURCE_BYTES
    || typeof payload.url !== "string" || payload.url.length > 4096
    || typeof payload.articleId !== "string" || payload.articleId !== normalizeUrl(payload.url)
    || typeof payload.title !== "string" || payload.title.length > 2000
    || !Array.isArray(payload.resources) || payload.resources.length > MAX_ARCHIVE_IMAGES
    || !Array.isArray(payload.missingResources) || payload.missingResources.length > 1000
    || payload.missingResources.some(url => typeof url !== "string" || !url)) {
    throw new Error("文章内容格式不正确或超过大小限制");
  }
  const url = new URL(payload.url);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("不支持的文章地址");
  let bytes = 0;
  for (const resource of payload.resources) {
    if (!resource || typeof resource.url !== "string" || !resource.url || resource.url.length > MAX_RESOURCE_BYTES * 1.4
      || (resource.base64 !== undefined && (typeof resource.base64 !== "string" || resource.base64.length > MAX_RESOURCE_BYTES * 1.4))
      || (resource.mime !== undefined && typeof resource.mime !== "string")) throw new Error("文章图片格式不正确");
    bytes += resource.base64?.length ?? 0;
    if (bytes > 36 * 1024 * 1024) throw new Error("文章图片超过传输大小限制");
  }
  return payload;
}

export function imageMime(value: string): string | null {
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return IMAGE_MIME.test(mime) ? mime.replace("image/jpg", "image/jpeg") : null;
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
}

/** Bound streaming bodies even when Content-Length is absent or dishonest. */
export async function readArchiveBytes(response: Response, limit = MAX_RESOURCE_BYTES): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) throw new Error("文章资源超过大小限制");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("文章资源超过大小限制"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Only image attributes are replaced. Missing images never retain network URLs. */
export function rewriteArchiveImages(html: string, hashes: ReadonlyMap<string, string>): string {
  return html.replace(/<img\b[^>]*>/gi, tag => {
    const src = /\bsrc="([^"]*)"/i.exec(tag);
    const url = src?.[1]?.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    const hash = url ? hashes.get(url) : undefined;
    if (!hash || !ARCHIVE_HASH.test(hash)) return "<span>（图片未保存）</span>";
    return tag.replace(/\bsrc="[^"]*"/i, `src="fs-blob:${hash}"`);
  });
}
