import "./boot.ts";
import { Readability } from "@mozilla/readability";
import type { Snippet } from "../types.ts";
import { navigation, readerUrl, shim } from "./boot.ts";
import { hostHooks, inApp, native } from "./native.ts";
import { sanitizeArticle } from "./sanitize.ts";
import { extractFromContainer } from "../content/paragraphs.ts";
import { startTracking, type TrackController } from "../content/track.ts";
import { formatEstimate } from "../lib/readingTime.ts";
import { fillMeta } from "../lib/speak.ts";
import { hostnameOf, normalizeUrl } from "../lib/url.ts";
import { READER_PREFIX } from "../background/store.ts";

/**
 * 阅读器：抓一篇网页的正文、洗干净、排成适合手机看的样子，然后把扩展在网页上做的
 * 那一整套（session、段落停留、划词翻译、读完角标、跳回上次位置）原样跑在这份正文上。
 *
 * 正文只抓一次，存在 `rh:<articleId>` 下：再次打开秒开、断网也能看。
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 存下来的正文。 */
interface CachedArticle {
  /** 用户给的地址（分享过来的、粘贴的），缓存按它查。 */
  url: string;
  /**
   * 跟完重定向之后的地址。文章记录按**它**归一化：分享出来的链接常带一跳
   * （短链、跳转页），电脑上的扩展看到的是落地之后的地址，两边要合到同一条记录就得用同一个。
   * `m.` 子域这类同文异址仍然合不到一起，只能认了。
   */
  finalUrl: string;
  title: string;
  /** 洗过的正文 HTML。 */
  html: string;
  savedTs: number;
}

const cacheKey = (articleId: string): string => READER_PREFIX + articleId;

/** 抓网页时报的 UA，宿主没设的话就用这个。桌面版 UA 拿到的页面往往更完整。 */
const ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Content-Type 里的 charset。 */
function charsetOf(contentType: string | null): string | null {
  const m = /charset\s*=\s*"?([\w.-]+)"?/i.exec(contentType ?? "");
  return m?.[1]?.toLowerCase() ?? null;
}

/** 头部没说编码时看 `<meta charset>`：国内不少站点还在用 GBK，按 UTF-8 解出来全是问号。 */
function sniffCharset(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.-]+)/i.exec(head);
  return m?.[1]?.toLowerCase() ?? null;
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function fetchAndExtract(url: string): Promise<CachedArticle> {
  const res = await fetch(url, { headers: { Accept: ACCEPT } });
  if (!res.ok) throw new Error(`网页返回了 HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const charset = charsetOf(res.headers.get("content-type")) ?? sniffCharset(bytes) ?? "utf-8";
  const html = decode(bytes, charset);
  // 宿主跟随重定向后把最终地址放在这个头里；相对链接要按它补全
  const finalUrl = res.headers.get("x-fs-final-url") || res.url || url;

  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = doc.createElement("base");
  base.href = finalUrl;
  doc.head.prepend(base);
  const parsed = new Readability(doc).parse();
  if (!parsed?.content) throw new Error("没能从这一页里认出正文。它可能不是文章，或者需要登录才能看。");
  return {
    url,
    finalUrl,
    title: (parsed.title || doc.title || url).replace(/\s+/g, " ").trim(),
    html: sanitizeArticle(parsed.content, finalUrl),
    savedTs: Date.now(),
  };
}

function showStatus(text: string, retry?: () => void): void {
  const box = $("article");
  box.textContent = "";
  const p = el("p", "status", text);
  box.append(p);
  if (retry) {
    const btn = el("button", "mini", "重试");
    btn.addEventListener("click", retry);
    p.append(el("br"), btn);
  }
}

let ctl: TrackController | null = null;
let leaving = false;

// 后台发起的换页（读完角标的「回顾这篇」、浮层里的「去设置」）也要先结算最后一段
navigation.beforeLeave = async () => {
  ctl?.stop("unload");
};

/** 返回键：把最后一段结算掉、等写入落盘，再让宿主回退，否则这一段阅读就丢了。 */
async function leave(): Promise<void> {
  if (leaving) return;
  leaving = true;
  ctl?.stop("unload");
  await shim.flush();
  const bridge = native();
  if (bridge?.navigateBack) bridge.navigateBack();
  else if (history.length > 1) history.back();
  else location.href = "index.html";
}

function renderMeta(url: string): void {
  const st = ctl?.state();
  const parts = [hostnameOf(url)];
  if (st?.tracked) {
    const tracked = st.trackedWords ?? 0;
    const read = st.wordsRead ?? 0;
    const pct = tracked > 0 ? Math.min(100, Math.round((read / tracked) * 100)) : 0;
    parts.push(`已读 ${pct}%`);
    const est = st.estimate;
    if (est && est.words > 0) parts.push("还需" + formatEstimate(est.ms));
    else if (tracked > 0 && read >= tracked) parts.push("已读完");
    if (st.activeSince) parts.push("计时中");
  } else if (st?.reason) {
    parts.push(st.reason);
  }
  $("rmeta").textContent = parts.join(" · ");
}

/* ==================== 本文生词 ==================== */

async function loadWords(articleId: string): Promise<Snippet[]> {
  const res = (await chrome.runtime.sendMessage({ type: "snippets:list", articleId })) as { snippets?: Snippet[] };
  return res?.snippets ?? [];
}

function renderWords(list: Snippet[]): void {
  const box = $("sheet-list");
  box.textContent = "";
  if (list.length === 0) {
    box.append(el("div", "empty", "这篇还没有划词。长按选中一段英文就会自动翻译。"));
    return;
  }
  for (const s of list) {
    const item = el("div", "item");
    item.append(el("div", "t", s.text));
    const meta = el("div", "m");
    if (fillMeta(meta, { phonetic: s.phonetic, pos: s.pos, word: s.text })) item.append(meta);
    item.append(el("div", "tr", s.translation));
    if (s.contextNote) item.append(el("div", "n", s.contextNote));
    if (s.usage) item.append(el("div", "u", s.usage));
    if (s.vocab.length > 0) {
      const vocab = el("div", "vocab");
      for (const v of s.vocab) {
        const one = el("div", "v");
        const head = el("div");
        head.append(el("span", "vw", v.word));
        const m = el("span", "vm");
        if (fillMeta(m, { phonetic: v.phonetic, pos: v.pos, word: v.word })) head.append(m);
        one.append(head, el("div", "vd", v.meaning));
        if (v.note) one.append(el("div", "vn", v.note));
        vocab.append(one);
      }
      item.append(vocab);
    }
    box.append(item);
  }
}

/* ==================== 启动 ==================== */

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const url = params.get("u")?.trim() ?? "";
  $("back").addEventListener("click", () => void leave());
  hostHooks.beforeBack = () => {
    void leave();
    return true;
  };

  if (!/^https?:\/\//i.test(url)) {
    $("rtitle").textContent = "没有文章";
    showStatus("地址不对。从首页粘贴一个网页地址，或者从浏览器把网页分享到这个 App。");
    return;
  }
  $("rmeta").textContent = hostnameOf(url);

  // 缓存按用户给的地址查：抓之前还不知道它会跳到哪
  const key = cacheKey(normalizeUrl(url));
  const refresh = params.get("refresh") === "1";
  let cached = (await chrome.storage.local.get(key))[key] as CachedArticle | undefined;
  if (!cached || refresh) {
    $("rtitle").textContent = hostnameOf(url);
    showStatus(refresh ? "正在重新抓取正文…" : "正在抓取正文…");
    try {
      cached = await fetchAndExtract(url);
      await chrome.storage.local.set({ [key]: cached });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      $("rtitle").textContent = hostnameOf(url);
      showStatus(
        inApp() ? `抓不到这一页：${msg}` : `抓不到这一页：${msg}（在普通浏览器里调试时跨域请求会被拦，得装进 App 里试）`,
        () => location.reload(),
      );
      return;
    }
  }

  // 老缓存（没有 finalUrl 的）退回用户给的地址
  const pageUrl = cached.finalUrl || url;
  const articleId = normalizeUrl(pageUrl);
  document.title = cached.title;
  $("rtitle").textContent = cached.title;
  const box = $("article");
  const heading = el("h1", "atitle", cached.title);
  const byline = el("div", "aline");
  const link = el("a", undefined, hostnameOf(pageUrl));
  link.href = pageUrl;
  byline.append(link, el("span", undefined, new Date(cached.savedTs).toLocaleDateString("zh-CN")));
  // 洗过的 HTML，见 sanitize.ts；正文来自任意网站，这一步不能省
  box.innerHTML = "";
  box.append(heading, byline);
  const body = el("div", "body");
  body.innerHTML = cached.html;
  box.append(body);

  const title = cached.title;
  ctl = await startTracking({
    url: pageUrl,
    focus: "assume",
    extract: () => extractFromContainer(body, title),
  });
  hostHooks.visibility = (v) => ctl?.setVisible(v);
  renderMeta(pageUrl);
  setInterval(() => renderMeta(pageUrl), 2_000);

  /* ---- 本文生词 ---- */
  const badge = $("words-n");
  const refreshCount = async (): Promise<Snippet[]> => {
    const list = await loadWords(articleId);
    badge.textContent = list.length > 0 ? String(list.length) : "";
    return list;
  };
  void refreshCount();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["snippets"]) void refreshCount();
  });
  const sheet = $("sheet");
  $("words").addEventListener("click", async () => {
    renderWords(await refreshCount());
    sheet.hidden = false;
  });
  $("sheet-close").addEventListener("click", () => {
    sheet.hidden = true;
  });
  $("refetch").addEventListener("click", () => {
    void (async () => {
      ctl?.stop("unload");
      await shim.flush();
      location.replace(readerUrl(url) + "&refresh=1");
    })();
  });
}

void main().catch((err: unknown) => {
  showStatus(`阅读器出错了：${err instanceof Error ? err.message : String(err)}`);
});
