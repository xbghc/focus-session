import { localStorage, syncDriver, trackChanges, withDataLock } from "../sync/storage.ts";
import { recordKey, type SyncRecord } from "../sync/protocol.ts";
import { syncRequest, scheduleSync } from "../sync/engine.ts";
import { cacheBlob, cachedBlob } from "./cache.ts";
import {
  ARCHIVES_KEY, ARCHIVE_PENDING_KEY, hashBytes, imageMime, rewriteArchiveImages, readArchiveBytes, validateArchiveCapture,
  MAX_ARCHIVE_BYTES, MAX_RESOURCE_BYTES,
  type ArchiveCapture, type ArchiveManifest, type ArchiveResource,
} from "./types.ts";

/** All capture writes and upload acknowledgements share one queue. */
let saving: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = saving.then(fn, fn);
  saving = next.catch(() => undefined);
  return next;
}

async function resourceBlob(resource: ArchiveCapture["resources"][number]): Promise<Blob> {
  if (resource.base64) {
    if (resource.base64.length > MAX_RESOURCE_BYTES * 1.4) throw new Error("图片超过大小限制");
    const mime = imageMime(resource.mime ?? "");
    if (!mime) throw new Error("不支持的图片格式");
    const raw = atob(resource.base64);
    return new Blob([Uint8Array.from(raw, ch => ch.charCodeAt(0))], { type: mime });
  }
  const url = new URL(resource.url);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("不支持的图片地址");
  const response = await fetch(url.href, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`图片返回 HTTP ${response.status}`);
  const mime = imageMime(response.headers.get("content-type") ?? "");
  if (!mime) throw new Error("不支持的图片格式");
  if (Number(response.headers.get("content-length")) > MAX_RESOURCE_BYTES) throw new Error("图片超过大小限制");
  const bytes = await readArchiveBytes(response);
  return new Blob([new Uint8Array(bytes)], { type: mime });
}

export function saveArchive(payload: ArchiveCapture): Promise<{ ok: true; manifest: ArchiveManifest; missing: number }> {
  return serial(async () => {
    validateArchiveCapture(payload);
    const deviceId = (await syncDriver().read()).deviceId;
    const resources = new Map<string, ArchiveResource>();
    const hashes = new Map<string, string>();
    const missing = new Set((payload.missingResources ?? []).filter(value => typeof value === "string"));
    let totalBytes = new TextEncoder().encode(payload.html).length;
    const queue = [...payload.resources];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const resource = queue.shift()!;
        if (!resource || typeof resource.url !== "string") continue;
        try {
          const blob = await resourceBlob(resource);
          if (blob.size > MAX_RESOURCE_BYTES || totalBytes + blob.size > MAX_ARCHIVE_BYTES) throw new Error("文章资源超过大小限制");
          totalBytes += blob.size;
          const hash = await hashBytes(new Uint8Array(await blob.arrayBuffer()));
          await cacheBlob(hash, blob);
          resources.set(hash, { hash, mime: blob.type, size: blob.size });
          hashes.set(resource.url, hash);
        } catch { missing.add(resource.url); }
      }
    }));
    const html = rewriteArchiveImages(payload.html, hashes);
    const body = new Blob([html], { type: "text/html" });
    const htmlHash = await hashBytes(new Uint8Array(await body.arrayBuffer()));
    await cacheBlob(htmlHash, body);
    const manifest: ArchiveManifest = {
      articleId: payload.articleId, version: crypto.randomUUID(), url: payload.url,
      title: String(payload.title || payload.url).slice(0, 2000), htmlHash,
      resources: [...resources.values()], missingResources: [...missing].slice(0, 1000).map(url => url.startsWith("data:") ? "内嵌图片未保存" : url.slice(0, 8192)), createdTs: Date.now(),
    };
    await withDataLock(() => syncDriver().update(state => {
      if (state.deviceId !== deviceId) throw new Error("本机数据已清除，请重新保存文章");
      const before = structuredClone(state.data);
      state.data[ARCHIVES_KEY] = { ...state.data[ARCHIVES_KEY], [manifest.articleId]: manifest };
      state.data[ARCHIVE_PENDING_KEY] = { ...state.data[ARCHIVE_PENDING_KEY], [manifest.articleId]: manifest };
      trackChanges(state, before, state.data);
    }));
    scheduleSync();
    return { ok: true, manifest, missing: missing.size };
  });
}

let flushing: Promise<void> | null = null;

/** Called before metadata upload. A failed upload remains queued for the next sync. */
export function flushArchives(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const data = await localStorage().get(ARCHIVE_PENDING_KEY);
    const pending = (data[ARCHIVE_PENDING_KEY] ?? {}) as Record<string, ArchiveManifest>;
    for (const manifest of Object.values(pending)) {
      for (const hash of [manifest.htmlHash, ...manifest.resources.map(resource => resource.hash)]) {
        try {
          const exists = await syncRequest(`/v1/blobs/${hash}`, { method: "HEAD" });
          if (exists.ok) continue;
          if (exists.status !== 404) throw new Error(`资源检查失败：HTTP ${exists.status}`);
        } catch (err) {
          if ((err as { status?: number }).status !== 404) throw err;
        }
        const blob = await cachedBlob(hash);
        if (!blob) throw new Error("本地文章资源缺失，请重新保存文章");
        const response = await syncRequest(`/v1/blobs/${hash}`, {
          method: "PUT", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob,
        });
        if (!response.ok) throw new Error(`文章资源上传失败：HTTP ${response.status}`);
      }
      const state = await syncDriver().read();
      const record = (state.data.archivePendingRecords?.[manifest.articleId] ?? state.records[recordKey({ type: "archive", id: manifest.articleId })]) as SyncRecord | undefined;
      // A newly saved version has its own resources and must get its own turn.
      if (!record || (record.value as ArchiveManifest | undefined)?.version !== manifest.version) continue;
      const response = await syncRequest("/v1/archives", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...manifest, stamp: record.stamp, generation: record.generation, opId: `archive:${manifest.version}` }),
      });
      if (!response.ok) throw new Error(`文章发布失败：HTTP ${response.status}`);
      await serial(async () => {
        await withDataLock(() => syncDriver().update(state => {
          if (state.data[ARCHIVE_PENDING_KEY]?.[manifest.articleId]?.version === manifest.version) {
            delete state.data[ARCHIVE_PENDING_KEY][manifest.articleId];
            if (state.data.archivePendingRecords) delete state.data.archivePendingRecords[manifest.articleId];
          }
        }));
      });
    }
  })().finally(() => { flushing = null; });
  return flushing;
}
