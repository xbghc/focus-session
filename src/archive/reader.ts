import { localStorage } from "../sync/storage.ts";
import { syncRequest } from "../sync/engine.ts";
import { sanitizeArticle } from "../app/sanitize.ts";
import { normalizeUrl } from "../lib/url.ts";
import { cacheBlob, cachedBlob } from "./cache.ts";
import { ARCHIVES_KEY, ARCHIVE_HASH, ARCHIVE_SRC, imageMime, readArchiveBytes, MAX_RESOURCE_BYTES, type ArchiveManifest } from "./types.ts";

export interface ArchivedArticle {
  url: string;
  finalUrl: string;
  title: string;
  html: string;
  savedTs: number;
  archiveManifest: ArchiveManifest;
}

async function blobFor(hash: string): Promise<Blob> {
  if (!ARCHIVE_HASH.test(hash)) throw new Error("文章资源索引格式不正确");
  const existing = await cachedBlob(hash);
  if (existing) return existing;
  const response = await syncRequest(`/v1/blobs/${hash}`);
  if (!response.ok) throw new Error(`文章资源下载失败：HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_RESOURCE_BYTES) throw new Error("文章资源超过大小限制");
  const blob = new Blob([new Uint8Array(await readArchiveBytes(response))], { type: response.headers.get("content-type") ?? "application/octet-stream" });
  await cacheBlob(hash, blob);
  return blob;
}

/** No source-site request occurs when an archive is available. */
export async function loadArchivedArticle(url: string): Promise<ArchivedArticle | null> {
  const data = await localStorage().get(ARCHIVES_KEY);
  const archives = (data[ARCHIVES_KEY] ?? {}) as Record<string, ArchiveManifest>;
  const id = normalizeUrl(url);
  const manifest = archives[id] ?? Object.values(archives).find(item => normalizeUrl(item.url) === id);
  if (!manifest) return null;
  if (!/^https?:\/\//i.test(manifest.url) || !Array.isArray(manifest.resources)) throw new Error("文章清单格式不正确");
  const html = await (await blobFor(manifest.htmlHash)).text();
  return {
    url, finalUrl: manifest.url, title: manifest.title, savedTs: manifest.createdTs,
    html: sanitizeArticle(html, manifest.url, document, true), archiveManifest: manifest,
  };
}

/** Create transient URLs only after sanitizing; never persist those URLs. */
export async function hydrateArchiveImages(body: HTMLElement, manifest: ArchiveManifest): Promise<{ missing: number; release: () => void }> {
  const resources = new Map(manifest.resources.map(resource => [resource.hash, resource]));
  const urls = new Map<string, Promise<string>>();
  const allocated = new Set<string>();
  let missing = manifest.missingResources?.length ?? 0;
  const images = [...body.querySelectorAll("img")];
  // Strip URLs synchronously, before this element enters the live document.
  const pending = images.map(img => {
    const hash = ARCHIVE_SRC.exec(img.getAttribute("src") ?? "")?.[1];
    img.removeAttribute("src");
    return { img, hash };
  });
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (pending.length) {
      const { img, hash } = pending.shift()!;
      try {
        const resource = hash ? resources.get(hash) : undefined;
        if (!hash || !resource || !imageMime(resource.mime)) throw new Error("未知图片资源");
        let loaded = urls.get(hash);
        if (!loaded) {
          loaded = (async () => {
            const blob = await blobFor(hash);
            if (blob.size !== resource.size) throw new Error("图片大小校验失败");
            const url = URL.createObjectURL(new Blob([blob], { type: resource.mime }));
            allocated.add(url);
            return url;
          })();
          urls.set(hash, loaded);
        }
        img.src = await loaded;
      } catch {
        missing++;
        const placeholder = document.createElement("span");
        placeholder.textContent = img.alt ? `（图片未下载：${img.alt}）` : "（图片未下载，联网后重新打开可重试）";
        img.replaceWith(placeholder);
      }
    }
  }));
  return { missing, release: () => { for (const url of allocated) URL.revokeObjectURL(url); } };
}
