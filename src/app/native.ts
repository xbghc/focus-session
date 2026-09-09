/**
 * 安卓宿主注入到 `window.Native` 上的桥（见 android/…/NativeBridge.java），
 * 以及建立在它上面的 fetch。
 *
 * 为什么 HTTP 要走宿主：MiniMax 的端点不返回 CORS 头，WebView 里的页面是
 * https://appassets.androidplatform.net 这个真实的 origin，直接 fetch 会被浏览器拦掉——
 * 扩展里是 background 靠 host permission 绕过的，App 里没有这个特权，只能让原生代码代发。
 * 抓文章的 HTML 同理。
 *
 * 宿主把响应**分块**推回来（`__fsHttp.chunk`），这里包成一个带 ReadableStream 的 Response，
 * llm.ts 的流式读取（`res.body.getReader()`）原样能用，译文照样逐字段出现。
 * 字节用 base64 传：一块的边界可能落在多字节字符中间，按文本传会出乱码。
 */

export interface NativeBridge {
  /** 发起请求；之后宿主回调 __fsHttp 的 head / chunk / end / error。 */
  httpStart(id: string, url: string, method: string, headersJson: string, body: string | null): void;
  httpAbort(id: string): void;
  /** 写进系统「下载」目录。返回给用户看的一句话。 */
  saveFile(name: string, mime: string, text: string): string;
  /** 走系统分享面板（发给电脑、存到网盘都从这里走）。 */
  shareFile(name: string, mime: string, text: string): void;
  speak(text: string, lang: string, rate: number): void;
  stopSpeaking(): void;
  /** 页面处理完返回键之后，让宿主真正回退。 */
  navigateBack(): void;
  /** 宿主的版本名。 */
  version(): string;
  /** 系统栏 / 刘海压在 WebView 上的那几条边，"上,右,下,左"，单位 CSS px。 */
  insets(): string;
  /**
   * 这个安装是不是 debug 签名的。是的话装不了正式签名的升级包（见 lib/update.ts），
   * 页面据此把「下载并安装」换成一句说明，而不是让用户去撞系统安装器那句「应用未安装」。
   */
  isDebugBuild(): boolean;
  /**
   * 下载升级包，之后宿主回调 __fsUpdate 的 progress / done / error。
   * APK 的字节不经过这座桥：宿主自己写文件，页面只收进度数字。
   */
  updateDownload(url: string, expectedBytes: number): void;
  /** 把下好的包交给系统安装器。没有「安装未知应用」的授权时先送用户去那一页。 */
  updateInstall(): void;
}

/** 宿主 → 页面的回调。宿主用 evaluateJavascript 调它们。 */
export interface HostCallbacks {
  http: {
    head(id: string, status: number, statusText: string, headersJson: string): void;
    chunk(id: string, base64: string): void;
    end(id: string): void;
    error(id: string, message: string): void;
  };
  /** App 切到后台 / 回到前台。 */
  visibility(visible: boolean): void;
  /**
   * 返回键。返回 true 表示页面自己处理（稍后调 Native.navigateBack），
   * false 表示宿主直接回退。
   */
  beforeBack(): boolean;
  /** 安全区变了（转屏、进出分屏）。参数同 NativeBridge.insets()。 */
  insets(csv: string): void;
  /** 升级包的下载进度。total 为 0 表示对方没报长度。 */
  update: {
    progress(received: number, total: number): void;
    done(): void;
    error(message: string): void;
  };
}

declare global {
  interface Window {
    Native?: Partial<NativeBridge>;
    __fsHttp?: HostCallbacks["http"];
    __fsUpdate?: HostCallbacks["update"];
    __fsHost?: Pick<HostCallbacks, "visibility" | "beforeBack" | "insets">;
  }
}

export const native = (): Partial<NativeBridge> | null => (typeof window === "undefined" ? null : (window.Native ?? null));

/** 跑在宿主里（而不是普通浏览器里调试）。 */
export const inApp = (): boolean => native() !== null;

/** 各页面登记自己对宿主事件的处理；不登记就是默认行为。 */
export const hostHooks: Pick<HostCallbacks, "visibility" | "beforeBack"> = {
  visibility: () => undefined,
  beforeBack: () => false,
};

interface Inflight {
  head(status: number, statusText: string, headers: Record<string, string>): void;
  chunk(bytes: Uint8Array): void;
  end(): void;
  error(message: string): void;
}

const inflight = new Map<string, Inflight>();

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const callbacks: HostCallbacks["http"] = {
  head(id, status, statusText, headersJson) {
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(headersJson) as Record<string, string>;
    } catch {
      /* 宿主拼坏了也别把整个请求搞挂 */
    }
    inflight.get(id)?.head(status, statusText, headers);
  },
  chunk(id, base64) {
    inflight.get(id)?.chunk(base64ToBytes(base64));
  },
  end(id) {
    inflight.get(id)?.end();
  },
  error(id, message) {
    inflight.get(id)?.error(message);
  },
};

/** 由宿主代发的 fetch。签名与 fetch 一致，只实现 llm.ts 与阅读器用到的那部分。 */
export function nativeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const bridge = native();
  if (!bridge?.httpStart || !bridge.httpAbort) return Promise.reject(new TypeError("宿主没有提供 HTTP 桥"));
  const start = bridge.httpStart.bind(bridge);
  const abort = bridge.httpAbort.bind(bridge);

  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init.headers ?? {}).forEach((v, k) => (headers[k] = v));
  const body = init.body == null ? null : typeof init.body === "string" ? init.body : String(init.body);
  const id = crypto.randomUUID();

  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(new DOMException("已取消", "AbortError"));
      return;
    }
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settled = false;
    let done = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        abort(id);
        inflight.delete(id);
      },
    });
    const fail = (err: Error): void => {
      inflight.delete(id);
      if (!settled) {
        settled = true;
        reject(err);
        return;
      }
      if (!done) {
        done = true;
        try {
          controller?.error(err);
        } catch {
          /* 流已经关了 */
        }
      }
    };
    const onAbort = (): void => {
      abort(id);
      fail(new DOMException("已取消", "AbortError"));
    };
    init.signal?.addEventListener("abort", onAbort, { once: true });

    inflight.set(id, {
      head(status, statusText, hdrs) {
        if (settled) return;
        settled = true;
        // 204/304 不能带 body；status 0 说明宿主那边连都没连上
        if (status <= 0) {
          fail(new TypeError("网络错误"));
          return;
        }
        const nobody = status === 204 || status === 304 || method === "HEAD";
        resolve(new Response(nobody ? null : stream, { status, statusText, headers: hdrs }));
      },
      chunk(bytes) {
        if (done) return;
        try {
          controller?.enqueue(bytes);
        } catch {
          /* 读的一方已经取消 */
        }
      },
      end() {
        inflight.delete(id);
        init.signal?.removeEventListener("abort", onAbort);
        if (done) return;
        done = true;
        try {
          controller?.close();
        } catch {
          /* 已关闭 */
        }
      },
      error(message) {
        init.signal?.removeEventListener("abort", onAbort);
        fail(new TypeError(message || "网络错误"));
      },
    });

    try {
      start(id, url, method, JSON.stringify(headers), body);
    } catch (err) {
      fail(new TypeError(`宿主拒绝了请求：${String(err)}`));
    }
  });
}

/* ==================== 自动更新 ==================== */

interface Downloading {
  progress(received: number, total: number): void;
  done(): void;
  error(message: string): void;
}

/** 同一时刻只会有一个下载：设置页那个按钮按下去就禁用了。 */
let downloading: Downloading | null = null;

const updateCallbacks: HostCallbacks["update"] = {
  progress: (received, total) => downloading?.progress(received, total),
  done: () => downloading?.done(),
  error: (message) => downloading?.error(message),
};

/**
 * 让宿主把升级包下下来。resolve 表示文件已经落盘、大小对得上，可以调 Native.updateInstall()。
 *
 * 和 nativeFetch 不一样：APK 的字节不经过这座桥。一个五兆的包按 16KB 一块 base64 推回来
 * 是三百多次 evaluateJavascript，还要在页面这边再拼一遍——宿主直接写进自己的缓存目录，
 * 页面只需要知道下到哪儿了。
 */
export function downloadUpdate(
  url: string,
  expectedBytes: number,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  const bridge = native();
  if (!bridge?.updateDownload) return Promise.reject(new Error("这个版本的宿主不会自动更新"));
  if (downloading) return Promise.reject(new Error("已经在下载了"));
  const start = bridge.updateDownload.bind(bridge);
  return new Promise<void>((resolve, reject) => {
    downloading = {
      progress: onProgress,
      done: () => {
        downloading = null;
        resolve();
      },
      error: (message) => {
        downloading = null;
        reject(new Error(message || "下载失败"));
      },
    };
    try {
      start(url, expectedBytes);
    } catch (err) {
      downloading = null;
      reject(new Error(`宿主拒绝了下载：${String(err)}`));
    }
  });
}

/** 与页面自己同源的地址（资源、字体）不必绕道宿主。 */
function external(input: RequestInfo | URL): boolean {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(href, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}

/**
 * 安全区。宿主量出系统栏 / 刘海压在 WebView 上的那几条边（"上,右,下,左"，CSS px），
 * 这里写成 --inset-* 四个变量，app.css 拿它和 env(safe-area-inset-*) 取大的那个用。
 *
 * 为什么不直接信 env()：Android 15+ 强制把窗口铺满整块屏，网页画到系统栏底下，
 * 而 WebView 的 env(safe-area-inset-*) 认不认系统栏（还是只认刘海）没有定论。
 * 宿主那边是量出来的，确定。
 */
function applyInsets(csv: string): void {
  const parts = csv.split(",");
  const px = (i: number): string => `${Number(parts[i]) || 0}px`;
  const s = document.documentElement.style;
  s.setProperty("--inset-top", px(0));
  s.setProperty("--inset-right", px(1));
  s.setProperty("--inset-bottom", px(2));
  s.setProperty("--inset-left", px(3));
}

/**
 * 装上宿主回调、接管跨域 fetch、补上朗读。
 * 不在宿主里（用普通浏览器打开 www/ 调试）时什么都不改，fetch 该被 CORS 拦还是会被拦。
 */
export function installNative(): void {
  if (typeof window === "undefined") return;
  window.__fsHttp = callbacks;
  window.__fsUpdate = updateCallbacks;
  window.__fsHost = {
    visibility: (v) => hostHooks.visibility(v),
    beforeBack: () => hostHooks.beforeBack(),
    insets: applyInsets,
  };
  const bridge = native();
  if (!bridge) return;

  // 开局先同步问一次，不等宿主推：首屏排版就要知道让开多少。
  // 老版本的宿主没有这个方法，问不到就当 0——正是 Android 15 以前的情形。
  if (bridge.insets) applyInsets(bridge.insets());

  if (bridge.httpStart) {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => (external(input) ? nativeFetch(input, init) : original(input, init));
  }

  // WebView 没有 Web Speech API；lib/speak.ts 只认 speechSynthesis 这一个入口，给它垫一个
  if (!("speechSynthesis" in window) && bridge.speak) {
    const speak = bridge.speak.bind(bridge);
    const stop = bridge.stopSpeaking?.bind(bridge) ?? (() => undefined);
    class Utterance {
      text: string;
      lang = "en-US";
      rate = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    Object.assign(window, {
      SpeechSynthesisUtterance: Utterance,
      speechSynthesis: {
        speak: (u: Utterance) => speak(u.text, u.lang, u.rate),
        cancel: () => stop(),
        getVoices: () => [],
        speaking: false,
        pending: false,
        paused: false,
      },
    });
  }
}
