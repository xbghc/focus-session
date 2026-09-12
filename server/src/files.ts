import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { HttpError } from './errors.ts';
import { contentHash } from './manifest.ts';

export interface StoredBlob { hash: string; storageKey: string; size: number; mime: string }

export class FileStore {
  readonly root: string;
  readonly maxBlobBytes: number;
  constructor(root: string, maxBlobBytes: number) {
    this.root = resolve(root);
    this.maxBlobBytes = maxBlobBytes;
  }

  storageKey(userId: string, hash: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(userId)) throw new Error('Invalid internal user id');
    contentHash(hash);
    return `users/${userId}/blobs/${hash.slice(0, 2)}/${hash}`;
  }

  path(storageKey: string): string {
    // Do not trust paths read back from a database restored from another host.
    if (!/^users\/[a-f0-9-]{36}\/blobs\/[a-f0-9]{2}\/[a-f0-9]{64}$/i.test(storageKey)) throw new Error('Invalid storage key');
    const absolute = resolve(this.root, storageKey);
    if (!absolute.startsWith(this.root + sep)) throw new Error('Storage path escapes data directory');
    return absolute;
  }

  async put(userId: string, hash: string, mime: string, input: AsyncIterable<Uint8Array>, availableBytes = this.maxBlobBytes): Promise<StoredBlob> {
    const storageKey = this.storageKey(userId, hash);
    const destination = this.path(storageKey);
    await mkdir(dirname(destination), { recursive: true });
    // Same directory guarantees rename never crosses filesystems.
    const temporary = join(dirname(destination), `.${hash}.${randomUUID()}.upload`);
    const handle = await open(temporary, 'wx', 0o600);
    let size = 0;
    const digest = createHash('sha256');
    let closed = false;
    try {
      for await (const chunk of input) {
        size += chunk.length;
        if (size > this.maxBlobBytes) throw new HttpError(413, 'BLOB_TOO_LARGE', 'Resource exceeds MAX_BLOB_BYTES');
        if (size > availableBytes) throw new HttpError(413, 'QUOTA_EXCEEDED', 'User resource storage quota exceeded');
        digest.update(chunk);
        // writeFile can be called repeatedly on a FileHandle; it advances the position.
        await handle.writeFile(chunk);
      }
      if (digest.digest('hex') !== hash) throw new HttpError(422, 'HASH_MISMATCH', 'Uploaded content does not match its SHA-256 hash');
      await handle.sync();
      await handle.close();
      closed = true;
      // Duplicate uploads have identical bytes. Replacement also repairs an existing corrupt file.
      await rename(temporary, destination);
      if (process.platform !== 'win32') {
        const directory = await open(dirname(destination), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return { hash, storageKey, mime, size };
    } finally {
      if (!closed) await handle.close();
      await rm(temporary, { force: true });
    }
  }

  async exists(blob: StoredBlob): Promise<boolean> {
    try { return (await stat(this.path(blob.storageKey))).size === blob.size; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  read(blob: StoredBlob): Readable { return createReadStream(this.path(blob.storageKey)); }
}
