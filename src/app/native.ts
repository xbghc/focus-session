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
}

declare global {
  interface Window {
    Native?: Partial<NativeBridge>;
    __fsHttp?: HostCallbacks["http"];
    __fsHost?: Pick<HostCallbacks, "visibility" | "beforeBack">;
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
 * 装上宿主回调、接管跨域 fetch、补上朗读。
 * 不在宿主里（用普通浏览器打开 www/ 调试）时什么都不改，fetch 该被 CORS 拦还是会被拦。
 */
export function installNative(): void {
  if (typeof window === "undefined") return;
  window.__fsHttp = callbacks;
  window.__fsHost = {
    visibility: (v) => hostHooks.visibility(v),
    beforeBack: () => hostHooks.beforeBack(),
  };
  const bridge = native();
  if (!bridge) return;

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
