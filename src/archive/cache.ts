import { ARCHIVE_HASH, hashBytes } from "./types.ts";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("focus-session-archive-blobs", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("blobs");
    request.onerror = () => { opening = null; reject(request.error); };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function cachedBlob(hash: string): Promise<Blob | undefined> {
  if (!ARCHIVE_HASH.test(hash)) throw new Error("无效的资源哈希");
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction("blobs", "readonly").objectStore("blobs").get(hash);
    request.onsuccess = () => resolve(request.result as Blob | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** Commit before publishing any manifest referencing these bytes. */
export async function cacheBlob(hash: string, blob: Blob): Promise<void> {
  if (!ARCHIVE_HASH.test(hash) || await hashBytes(new Uint8Array(await blob.arrayBuffer())) !== hash) {
    throw new Error("文章资源校验失败");
  }
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").put(blob, hash);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("文章资源保存被中断"));
  });
}

/** Used by “clear this device”; no server deletion is generated. */
export async function clearArchiveCache(): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").clear();
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("清除文章资源失败"));
  });
}
