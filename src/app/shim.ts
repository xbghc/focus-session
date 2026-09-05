import type { PortLike, Sender } from "../background/handle.ts";

/**
 * `chrome.*` 的垫片，让扩展的代码原样跑在安卓 App 的 WebView 里。
 *
 * 扩展里四个页面和 content script 靠 chrome.storage 存数据、靠 chrome.runtime.sendMessage
 * 把请求送到 service worker。App 里没有 service worker：这里把 sendMessage 直接接到
 * background/handle.ts 的 handle() 上，把 storage 接到 IndexedDB 上——同一份代码，
 * 只是接线不同。只实现用到的那几个 API，缺的宁可没有也不造假。
 *
 * 不 import 任何 background 模块：谁来处理消息由 boot.ts 注入，
 * 这样测试里可以拿一个 Map 当存储、拿一个函数当后台。
 */

export interface KvBackend {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ShimOptions {
  storage: KvBackend;
  handle: (msg: unknown, sender: Sender) => Promise<unknown>;
  /** 有人 chrome.runtime.connect 时，把服务端那一头交给它（划词翻译的流式 port）。 */
  connect: (name: string, port: PortLike) => void;
  /** chrome.runtime.getManifest().version */
  version: string;
  /** chrome.tabs.create / openOptionsPage 的落点：App 里就是换页。 */
  navigate: (url: string) => void;
}

export interface ChromeShim {
  /**
   * 等所有在途的写入落盘。
   *
   * 离开阅读器页面时 session:end 才刚发出，IndexedDB 的事务还没提交就换页的话，
   * 这一段阅读就丢了——扩展里 service worker 活得比页面久，App 里没有这层保护，
   * 所以换页前先等一下。
   */
  flush(): Promise<void>;
}

/** 内存版存储：给 storage.session 用，也给测试用。深拷贝，和真实存储一样不共享引用。 */
export function memoryBackend(): KvBackend {
  const data = new Map<string, unknown>();
  const one = (keys: string | string[]): string[] => (Array.isArray(keys) ? keys : [keys]);
  return {
    async get(keys) {
      if (keys === null) return structuredClone(Object.fromEntries(data));
      const out: Record<string, unknown> = {};
      for (const k of one(keys)) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of one(keys)) data.delete(k);
    },
  };
}

/**
 * IndexedDB 版存储：一个库、一个 object store、key → value。
 *
 * 不用 localStorage：它有 5MB 左右的配额，而段落记录、正文、阅读器缓存加起来轻易就超了，
 * 超了之后写入抛异常。IndexedDB 的配额按设备剩余空间算，和扩展声明的 unlimitedStorage 一个量级。
 */
export function idbBackend(dbName = "focus-session", storeName = "kv"): KvBackend {
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opening ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB.open 失败"));
    });
    return opening;
  };
  const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => T): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const out = body(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务被中止"));
    });
  };
  const one = (keys: string | string[]): string[] => (Array.isArray(keys) ? keys : [keys]);
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      if (keys === null) {
        let ks: IDBValidKey[] = [];
        let vs: unknown[] = [];
        await run("readonly", (s) => {
          const kr = s.getAllKeys();
          const vr = s.getAll();
          kr.onsuccess = () => (ks = kr.result);
          vr.onsuccess = () => (vs = vr.result as unknown[]);
        });
        ks.forEach((k, i) => (out[String(k)] = vs[i]));
        return out;
      }
      await run("readonly", (s) => {
        for (const k of one(keys)) {
          const r = s.get(k);
          r.onsuccess = () => {
            if (r.result !== undefined) out[k] = r.result;
          };
        }
      });
      return out;
    },
    async set(items) {
      await run("readwrite", (s) => {
        for (const [k, v] of Object.entries(items)) s.put(v, k);
      });
    },
    async remove(keys) {
      await run("readwrite", (s) => {
        for (const k of one(keys)) s.delete(k);
      });
    },
  };
}

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type ChangeListener = (changes: Changes, areaName: string) => void;

/** 单向的消息管道：一头 post，另一头的 listener 收。 */
function pipe<T>(): { post: (m: T) => void; listeners: Set<(m: T) => void> } {
  const listeners = new Set<(m: T) => void>();
  return {
    listeners,
    post(m) {
      // 异步投递，和 chrome 一致：同步回调会让 postMessage 的调用方在自己的栈里收到应答
      queueMicrotask(() => {
        for (const fn of listeners) {
          try {
            fn(m);
          } catch (err) {
            console.warn("[focus-session] port listener 抛错", err);
          }
        }
      });
    },
  };
}

/**
 * 一对 port：客户端那头交给 chrome.runtime.connect 的调用方，服务端那头交给后台。
 * 任一头 disconnect，**另一头**的 onDisconnect 触发（自己那头不触发，chrome 就是这样）。
 */
function makePorts(name: string): { client: chrome.runtime.Port; server: PortLike } {
  const toServer = pipe<unknown>();
  const toClient = pipe<unknown>();
  const clientClosed = new Set<() => void>();
  const serverClosed = new Set<() => void>();
  let open = true;
  const close = (byClient: boolean): void => {
    if (!open) return;
    open = false;
    const fire = byClient ? serverClosed : clientClosed;
    queueMicrotask(() => {
      for (const fn of fire) {
        try {
          fn();
        } catch {
          /* 见 pipe */
        }
      }
    });
  };
  const guard = (): void => {
    if (!open) throw new Error("Attempting to use a disconnected port object");
  };
  const events = <T>(set: Set<T>) => ({
    addListener: (fn: T) => void set.add(fn),
    removeListener: (fn: T) => void set.delete(fn),
    hasListener: (fn: T) => set.has(fn),
    hasListeners: () => set.size > 0,
  });

  const client = {
    name,
    postMessage(m: unknown) {
      guard();
      toServer.post(m);
    },
    disconnect() {
      close(true);
    },
    onMessage: events(toClient.listeners),
    onDisconnect: events(clientClosed),
  } as unknown as chrome.runtime.Port;

  const server: PortLike = {
    postMessage(m) {
      guard();
      toClient.post(m);
    },
    disconnect() {
      close(false);
    },
    onMessage: { addListener: (fn) => void toServer.listeners.add(fn as (m: unknown) => void) },
    onDisconnect: { addListener: (fn) => void serverClosed.add(fn) },
  };
  return { client, server };
}

/** 扩展里 dashboard.html 是独立页面；App 里它就是首页。 */
const URL_ALIAS: Record<string, string> = { "dashboard.html": "index.html" };

/** 消息的发送方：App 里只有一个"标签页"。session:start 等消息要求有 tab id。 */
const SENDER: Sender = { tab: { id: 1 } };

export function installChromeShim(opts: ShimOptions): ChromeShim {
  const changeListeners = new Set<ChangeListener>();
  const pending = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    void p.finally(() => pending.delete(p)).catch(() => undefined);
    return p;
  };
  const emit = (areaName: string, changes: Changes): void => {
    for (const fn of changeListeners) {
      try {
        fn(changes, areaName);
      } catch (err) {
        console.warn("[focus-session] storage.onChanged listener 抛错", err);
      }
    }
  };

  const area = (areaName: string, backend: KvBackend) => ({
    get: (keys?: string | string[] | null) => backend.get(keys ?? null),
    set: (items: Record<string, unknown>) =>
      track(
        backend.set(items).then(() => {
          const changes: Changes = {};
          for (const [k, v] of Object.entries(items)) changes[k] = { newValue: v };
          emit(areaName, changes);
        }),
      ),
    remove: (keys: string | string[]) =>
      track(
        backend.remove(keys).then(() => {
          const changes: Changes = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) changes[k] = {};
          emit(areaName, changes);
        }),
      ),
    clear: async () => {
      const all = await backend.get(null);
      await track(backend.remove(Object.keys(all)));
    },
  });

  const listeners = <T>(set: Set<T>) => ({
    addListener: (fn: T) => void set.add(fn),
    removeListener: (fn: T) => void set.delete(fn),
    hasListener: (fn: T) => set.has(fn),
  });
  const noop = () => ({ addListener: () => undefined, removeListener: () => undefined, hasListener: () => false });

  // 测试跑在 Node 里，没有 location
  const baseHref = typeof location === "undefined" ? "app://focus-session/" : new URL(".", location.href).href;

  const chromeLike = {
    storage: {
      local: area("local", opts.storage),
      session: area("session", memoryBackend()),
      onChanged: listeners(changeListeners),
    },
    runtime: {
      id: "focus-session-app",
      lastError: undefined,
      sendMessage: (msg: unknown): Promise<unknown> =>
        track(
          Promise.resolve()
            .then(() => opts.handle(msg, SENDER))
            .catch((err: unknown) => {
              // 和 background/index.ts 一样：写入失败（多半是配额）不能无声无息
              console.warn("[focus-session] 消息处理失败", msg, err);
              return { ok: false, error: String(err) };
            }),
        ),
      connect: (info?: { name?: string }): chrome.runtime.Port => {
        const name = info?.name ?? "";
        const { client, server } = makePorts(name);
        opts.connect(name, server);
        return client;
      },
      getURL: (path: string): string => new URL(URL_ALIAS[path] ?? path, baseHref).href,
      getManifest: () => ({ version: opts.version, name: "Focus Session", manifest_version: 3 }),
      openOptionsPage: async (): Promise<void> => opts.navigate("options.html"),
      onMessage: noop(),
      onConnect: noop(),
      onInstalled: noop(),
    },
    tabs: {
      create: async (info: { url?: string }): Promise<{ id: number }> => {
        if (info.url) opts.navigate(info.url);
        return { id: 1 };
      },
      query: async () => [],
      sendMessage: async () => {
        throw new Error("App 里没有标签页");
      },
      onUpdated: noop(),
      onRemoved: noop(),
      onActivated: noop(),
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    sidePanel: {
      open: async () => {
        throw new Error("App 里没有侧边栏");
      },
    },
  };

  (globalThis as { chrome?: unknown }).chrome = chromeLike;

  return {
    async flush() {
      // 写入可能触发新的写入（commitSession 里的连锁），多等几轮直到没有在途的
      for (let i = 0; i < 5 && pending.size > 0; i++) await Promise.allSettled([...pending]);
    },
  };
}
