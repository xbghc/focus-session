/**
 * 宿主那边的 EPUB 解包（android/…/NativeBridge.java 的 epub* 那几个方法）。
 *
 * 为什么不在网页里解：zip 的解压要么再添一个依赖，要么自己写 inflate；
 * java.util.zip 本来就在平台里，而且 ZipFile 是随机存取的——一本书三五百个条目，
 * 页面按需要的顺序一个个取，不必先把整个文件读进内存。文件的哈希由宿主在拷贝时顺手算。
 *
 * 字节按 16KB 一块 base64 推回页面，和 HTTP 那条桥一样：一块的边界可能落在多字节字符
 * 中间，按文本传会出乱码。
 */

import { base64ToBytes, native } from "../app/native.ts";
import { MAX_EPUB_ENTRIES } from "./types.ts";

export interface EpubBridge {
  /** 弹系统文件选择器。之后回调 __fsEpub.picked。 */
  epubPick(id: string): void;
  /** 打开一个 content:// 的 EPUB。之后回调 __fsEpub.opened，句柄就是这里的 id。 */
  epubOpen(id: string, uri: string): void;
  /** 取一个条目的字节。之后回调 __fsEpub.chunk / end。 */
  epubEntry(id: string, handle: string, name: string): void;
  /** 关掉句柄，顺带删掉宿主为它留的临时文件。 */
  epubClose(handle: string): void;
}

export interface EpubCallbacks {
  picked(id: string, uri: string, name: string): void;
  opened(id: string, hash: string, namesJson: string): void;
  chunk(id: string, base64: string): void;
  end(id: string): void;
  error(id: string, message: string): void;
}

declare global {
  interface Window {
    __fsEpub?: EpubCallbacks;
  }
}

interface Pending {
  picked?(uri: string, name: string): void;
  opened?(hash: string, names: string[]): void;
  chunk?(bytes: Uint8Array): void;
  end?(): void;
  error(message: string): void;
}

const pending = new Map<string, Pending>();

const callbacks: EpubCallbacks = {
  picked(id, uri, name) {
    const request = pending.get(id);
    pending.delete(id);
    request?.picked?.(uri, name);
  },
  opened(id, hash, namesJson) {
    const request = pending.get(id);
    pending.delete(id);
    if (!request) return;
    try {
      const names: unknown = JSON.parse(namesJson);
      if (!Array.isArray(names) || names.some(name => typeof name !== "string")) throw new Error("宿主返回的条目清单无效");
      request.opened?.(hash, (names as string[]).slice(0, MAX_EPUB_ENTRIES));
    } catch (err) {
      request.error(err instanceof Error ? err.message : String(err));
    }
  },
  chunk(id, base64) {
    pending.get(id)?.chunk?.(base64ToBytes(base64));
  },
  end(id) {
    const request = pending.get(id);
    pending.delete(id);
    request?.end?.();
  },
  error(id, message) {
    const request = pending.get(id);
    pending.delete(id);
    request?.error(message || "读取 EPUB 失败");
  },
};

if (typeof window !== "undefined") window.__fsEpub = callbacks;

const bridge = (): Partial<EpubBridge> | null => native() as Partial<EpubBridge> | null;

/** 这个版本的宿主认不认书。装在旧 App 上时界面据此把入口收起来，而不是点了没反应。 */
export const canOpenBooks = (): boolean => Boolean(bridge()?.epubOpen);

function request<T>(setup: (id: string, resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    try {
      setup(id, resolve, reject);
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export interface PickedEpub { uri: string; name: string }

/** 让用户选一个文件。用户按了取消时 resolve 一个 null，不是错误。 */
export function pickEpub(): Promise<PickedEpub | null> {
  const host = bridge();
  if (!host?.epubPick) return Promise.reject(new Error("这个版本的宿主不支持导入电子书"));
  const pick = host.epubPick.bind(host);
  return request<PickedEpub | null>((id, resolve, reject) => {
    pending.set(id, { picked: (uri, name) => resolve(uri ? { uri, name } : null), error: message => reject(new Error(message)) });
    pick(id);
  });
}

export interface OpenEpub {
  /** 文件内容的 SHA-256，也就是这本书的 id。 */
  hash: string;
  names: string[];
  bytes(name: string): Promise<Uint8Array>;
  close(): void;
}

export function openEpub(uri: string): Promise<OpenEpub> {
  const host = bridge();
  if (!host?.epubOpen || !host.epubEntry || !host.epubClose) return Promise.reject(new Error("这个版本的宿主不支持导入电子书"));
  const open = host.epubOpen.bind(host);
  const entry = host.epubEntry.bind(host);
  const close = host.epubClose.bind(host);
  return request<OpenEpub>((handle, resolve, reject) => {
    pending.set(handle, {
      opened: (hash, names) => resolve({
        hash,
        names,
        bytes: (name) => request<Uint8Array>((id, ok, fail) => {
          const parts: Uint8Array[] = [];
          pending.set(id, {
            chunk: bytes => parts.push(bytes),
            end: () => {
              const total = parts.reduce((n, part) => n + part.byteLength, 0);
              const out = new Uint8Array(total);
              let at = 0;
              for (const part of parts) { out.set(part, at); at += part.byteLength; }
              ok(out);
            },
            error: message => fail(new Error(message)),
          });
          entry(id, handle, name);
        }),
        // 收尾失败不该把已经导好的书判成导入失败：临时文件最迟也会随进程退出清掉
        close: () => { try { close(handle); } catch { /* 宿主已经收摊了 */ } },
      }),
      error: message => reject(new Error(message)),
    });
    open(handle, uri);
  });
}
