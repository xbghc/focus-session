import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { countWords, normalizeText } from "../lib/wordcount.ts";
import { expectedReadMs, readThresholdMs } from "../lib/reading.ts";
import { hashText } from "../lib/hash.ts";
import type { ParagraphSnapshot, ReadingTarget } from "../types.ts";

/** 段落级候选块。刻意不含 div —— div 太容易套住整篇文章。 */
const BLOCK_SELECTOR = "p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, td, dd, figcaption";
const STAMP = "data-fs-p";

export interface TrackedParagraph {
  index: number;
  hash: string;
  words: number;
  /** 按正常速度读完这段需要的毫秒数，见 lib/reading.ts。 */
  expectedMs: number;
  el: Element;
  /**
   * 段落原文。抽取时顺手留着，供事后的文章回顾用——
   * 到那时页面早关了，`el.textContent` 也就不在了。
   */
  text: string;
}

/** 「读到哪了」的锚点，由 content script 补上 articleId 等字段后落盘。 */
export interface PositionAnchor {
  index: number;
  hash: string;
  /** 视口顶相对段落顶的距离，正数表示已经滚进段落内部。 */
  offset: number;
}

export interface ExtractResult {
  title: string;
  /** Readability 正文全文字数，含未被段落覆盖的零散文本。 */
  totalWords: number;
  /** 可观测段落字数合计，用作"已读比例"的分母。 */
  trackedWords: number;
  paragraphs: TrackedParagraph[];
}

/**
 * 抽取正文并把段落映射回**活动 DOM** 的节点。
 *
 * Readability 会破坏传入的文档，所以必须解析副本；但副本里的节点无法用
 * IntersectionObserver 观察。做法是先在活动 DOM 上打 data-fs-p 标记再克隆——
 * 已验证 Readability 只清除 class 和表现型属性，自定义 data-* 会原样保留
 * （连 _setNodeTag 换标签时也会复制属性），于是能拿到精确的节点身份映射，
 * 比按文本匹配可靠得多。解析结束后标记会从活动 DOM 上清掉。
 */
/** 超过这个节点数就不解析：论坛、无限滚动信息流克隆一遍代价太大，而且它们也不是文章。 */
const MAX_NODES = 40_000;

export function extractArticle(doc: Document): ExtractResult | null {
  if (doc.querySelectorAll("*").length > MAX_NODES) return null;
  if (!isProbablyReaderable(doc)) return null;

  const live = Array.from(doc.querySelectorAll(BLOCK_SELECTOR));
  if (live.length === 0) return null;
  live.forEach((el, i) => el.setAttribute(STAMP, String(i)));

  let parsed: ReturnType<Readability<Node>["parse"]> = null;
  try {
    parsed = new Readability<Node>(doc.cloneNode(true) as Document, {
      serializer: (node) => node,
    }).parse();
  } catch {
    parsed = null;
  } finally {
    // 不要在别人的页面上留下痕迹
    live.forEach((el) => el.removeAttribute(STAMP));
  }

  const root = parsed?.content as Element | null | undefined;
  if (!parsed || !root || typeof root.querySelectorAll !== "function") return null;

  const paragraphs: TrackedParagraph[] = [];
  const seenHash = new Set<string>();
  let index = 0;

  for (const marked of Array.from(root.querySelectorAll(`[${STAMP}]`))) {
    // 只取最内层的块，否则 <li><p>…</p></li> 会把同一段文本数两遍
    if (marked.querySelector(`[${STAMP}]`)) continue;

    const liveIndex = Number(marked.getAttribute(STAMP));
    const el = live[liveIndex];
    if (!el || !el.isConnected) continue;

    const text = normalizeText(el.textContent ?? "");
    const words = countWords(text);
    if (words === 0) continue;

    // 同一段文本重复出现（打印版、隐藏副本）只记一次
    const hash = hashText(text);
    if (seenHash.has(hash)) continue;
    seenHash.add(hash);

    paragraphs.push({ index: index++, hash, words, expectedMs: expectedReadMs(text), el, text });
  }

  if (paragraphs.length === 0) return null;

  return {
    title: normalizeText(parsed.title || doc.title || ""),
    totalWords: countWords(normalizeText(parsed.textContent ?? "")),
    trackedWords: paragraphs.reduce((sum, p) => sum + p.words, 0),
    paragraphs,
  };
}

/**
 * 从**自己渲染的**正文容器里抽段落。
 *
 * 安卓 App 的阅读器已经用 Readability 把正文洗干净放进了一个容器，再对整页跑一遍
 * `extractArticle` 既多余，还可能把短段落当噪音洗掉。段落的取法与指纹算法和
 * extractArticle 完全一致：同一篇文章在电脑上和手机上算出同一批指纹，
 * 已读段落才能跨设备去重（Readability 洗过的文本偶尔和原网页略有出入，这是尽力而为）。
 */
export function extractFromContainer(root: Element, title: string): ExtractResult | null {
  const paragraphs: TrackedParagraph[] = [];
  const seenHash = new Set<string>();
  let index = 0;
  for (const el of Array.from(root.querySelectorAll(BLOCK_SELECTOR))) {
    // 只取最内层的块，否则 <li><p>…</p></li> 会把同一段文本数两遍
    if (el.querySelector(BLOCK_SELECTOR)) continue;
    const text = normalizeText(el.textContent ?? "");
    const words = countWords(text);
    if (words === 0) continue;
    const hash = hashText(text);
    if (seenHash.has(hash)) continue;
    seenHash.add(hash);
    paragraphs.push({ index: index++, hash, words, expectedMs: expectedReadMs(text), el, text });
  }
  if (paragraphs.length === 0) return null;
  return {
    title: normalizeText(title),
    totalWords: countWords(normalizeText(root.textContent ?? "")),
    trackedWords: paragraphs.reduce((sum, p) => sum + p.words, 0),
    paragraphs,
  };
}

interface ParagraphState {
  p: TrackedParagraph;
  read: boolean;
  /** 本次页面加载内的累计停留，已读判定看它。 */
  dwellMs: number;
  /** 已经随快照上报过的那部分停留。快照只发增量，否则后台会把同一段落反复累加。 */
  reportedMs: number;
  /** 跨过已读阈值的时刻。播种进来的（上次加载就读过的）段落没有这个值。 */
  readTs: number | null;
}

export interface TrackerOptions {
  /** 已读阈值的下限：几个字的标题也得看上一眼。 */
  dwellMs: number;
  /** 已读阈值 = max(dwellMs, 预计阅读时间 × readFraction)。 */
  readFraction: number;
  now(): number;
}

/** 每 500ms 结算一次停留时长；间隔只在 session 活跃时运行。 */
const ACCRUAL_MS = 500;

/**
 * 段落是否处在"正在阅读"的位置。
 * 短段落要露出一半；比视口还高的段落只要占住半屏就算在读——
 * 否则一个高度三屏的长段落永远达不到 50% 可见度，就永远不会被计入。
 */
export function isInReadingView(
  rect: { top: number; bottom: number; height: number },
  viewportHeight: number,
): boolean {
  if (viewportHeight <= 0 || rect.height <= 0) return false;
  const visibleH = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
  if (visibleH <= 0) return false;
  return visibleH >= Math.min(rect.height * 0.5, viewportHeight * 0.5);
}

/** 段落露在视口里的比例，0–1。 */
function visibleFraction(rect: { top: number; bottom: number; height: number }, viewportHeight: number): number {
  if (viewportHeight <= 0 || rect.height <= 0) return 0;
  const visibleH = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
  if (visibleH <= 0) return 0;
  return Math.min(1, visibleH / rect.height);
}

/**
 * 段落停留追踪。
 *
 * IntersectionObserver 只用来维护"与视口有交集"的小候选集（避免每帧扫描
 * 几百个段落），精确的可见性判定放在结算循环里用 getBoundingClientRect 做——
 * 因为 IO 的 threshold 回调对超长段落不可靠：一个高度 3 屏的段落
 * intersectionRatio 可能永远到不了 0.5，回调根本不会再触发。
 *
 * 「已读」的阈值按段落长度缩放（见 lib/reading.ts）：固定 1 秒会让一屏文字
 * 露出来的那一秒就全部记成已读，之后在同一屏上读多久都记为"没有新进展"。
 */
export class ParagraphTracker {
  private states: ParagraphState[];
  private byEl = new Map<Element, ParagraphState>();
  private candidates = new Set<Element>();
  private observer: IntersectionObserver | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAccrualTs = 0;
  private active = false;
  private opts: TrackerOptions;
  /** 本 session 内新读到的字数，由 takeNewWords 取走并清零。 */
  private pendingWords = 0;
  /** 正文最后一段是否进过视口。一旦为 true 不再回退。 */
  private bottomSeen = false;

  constructor(paragraphs: TrackedParagraph[], opts: TrackerOptions) {
    this.opts = opts;
    this.states = paragraphs.map((p) => ({ p, read: false, dwellMs: 0, reportedMs: 0, readTs: null }));
    for (const s of this.states) this.byEl.set(s.p.el, s);
  }

  /** 用存储中的已读指纹播种，实现跨刷新去重。 */
  seedRead(hashes: Iterable<string>): void {
    const set = new Set(hashes);
    for (const s of this.states) {
      if (set.has(s.p.hash)) s.read = true;
    }
  }

  start(): void {
    if (this.observer) return;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) this.candidates.add(e.target);
          else this.candidates.delete(e.target);
        }
      },
      { threshold: 0 },
    );
    for (const s of this.states) this.observer.observe(s.p.el);
  }

  /**
   * session 开始/结束时调用。
   * 结束时先结算一次再停表，避免最后一段停留被丢掉；
   * 重新开始时重置基准时刻，否则后台标签页会把整个视口算成"已读"。
   */
  setActive(active: boolean): void {
    if (active === this.active) return;
    // 结算必须发生在 active 翻成 false **之前**：accrue() 开头就会因 !active 直接返回
    if (!active) this.accrue();
    this.active = active;
    if (active) {
      this.lastAccrualTs = this.opts.now();
      this.timer = setInterval(() => this.accrue(), ACCRUAL_MS);
    } else {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 阈值热更新。已经记为已读的段落不回退。 */
  setThresholds(next: Partial<Pick<TrackerOptions, "dwellMs" | "readFraction">>): void {
    this.opts = { ...this.opts, ...next };
  }

  private thresholdOf(p: TrackedParagraph): number {
    return readThresholdMs(p.expectedMs, this.opts.readFraction, this.opts.dwellMs);
  }

  private viewportHeight(): number {
    return window.innerHeight || document.documentElement.clientHeight || 0;
  }

  /**
   * 当前视口里的文字按正常速度读完需要多久。
   *
   * 按露出的比例加权（一段只露了三成就算三成的时间），是 Grusky 等人 (CHI 2017)
   * 里"均匀视口注意力"那一档的做法。走神判定用它决定能容忍多久的静默；
   * 不依赖 session 是否在计时，popup 随时能问。
   */
  visibleExpectedMs(): number {
    const vh = this.viewportHeight();
    if (vh === 0) return 0;
    let total = 0;
    for (const el of this.candidates) {
      const s = this.byEl.get(el);
      if (!s) continue;
      total += s.p.expectedMs * visibleFraction(el.getBoundingClientRect(), vh);
    }
    return Math.round(total);
  }

  private accrue(): void {
    if (!this.active) return;
    const now = this.opts.now();
    const delta = now - this.lastAccrualTs;
    this.lastAccrualTs = now;
    if (delta <= 0) return;
    // 定时器被节流（后台标签页）时会攒出很大的 delta，钳一下避免虚增停留
    const step = Math.min(delta, ACCRUAL_MS * 4);

    const vh = this.viewportHeight();
    if (vh === 0) return;

    const last = this.states[this.states.length - 1];
    for (const el of this.candidates) {
      const s = this.byEl.get(el);
      if (!s) continue;
      if (!isInReadingView(el.getBoundingClientRect(), vh)) continue;
      if (last && s === last) this.bottomSeen = true;

      s.dwellMs += step;
      if (!s.read && s.dwellMs >= this.thresholdOf(s.p)) {
        s.read = true;
        s.readTs = now;
        this.pendingWords += s.p.words;
      }
    }
  }

  /** 取走并清零本 session 新读的字数。 */
  takeNewWords(): number {
    this.accrue();
    const n = this.pendingWords;
    this.pendingWords = 0;
    return n;
  }

  /** 不清零地查看，供 popup 实时显示。 */
  peekNewWords(): number {
    return this.pendingWords;
  }

  /**
   * 是否读到了正文末尾。
   *
   * 判据是"**正文的最后一个被追踪段落**进入了阅读视野"，而不是
   * `scrollY + innerHeight >= scrollHeight`——带评论区、相关推荐、长页脚的页面
   * 永远滚不到文档底，用文档高度判定会让这类站点上的文章一篇都标不成读完。
   */
  get reachedBottom(): boolean {
    return this.bottomSeen;
  }

  /**
   * 当前视口里最靠上的那个段落，作为「读到哪了」的锚点。
   *
   * 只在 IO 维护的候选集里找，且按正文顺序取第一个还没被划出视口上边的段落——
   * 这正是人眼此刻停在的那一段。候选集为空（人滚到评论区、或正文整个在视口之外）
   * 时返回 null，调用方保留上一次的记录，不要用一个错的位置去覆盖对的。
   */
  anchor(): PositionAnchor | null {
    for (const s of this.states) {
      if (!this.candidates.has(s.p.el)) continue;
      const r = s.p.el.getBoundingClientRect();
      if (r.height <= 0 || r.bottom <= 0) continue;
      return { index: s.p.index, hash: s.p.hash, offset: Math.round(-r.top) };
    }
    return null;
  }

  get readCount(): number {
    return this.states.reduce((n, s) => n + (s.read ? 1 : 0), 0);
  }

  get wordsRead(): number {
    return this.states.reduce((n, s) => n + (s.read ? s.p.words : 0), 0);
  }

  /** 还没读的段落合计：多少字、按一般速度要多久。「预计还需」的估计对象。 */
  remainingTarget(): ReadingTarget {
    let words = 0;
    let expectedMs = 0;
    for (const s of this.states) {
      if (s.read) continue;
      words += s.p.words;
      expectedMs += s.p.expectedMs;
    }
    return { words, expectedMs };
  }

  /**
   * 交给后台合并的快照：有新停留或已读的段落。
   *
   * `dwellMs` 是**自上次快照以来的增量**——每次 session 结束都发累计值的话，
   * 同一次页面加载里结束 30 个 session，同一段落就会被后台加 30 遍。
   * 已读的段落即使没有新停留也带上，让后台的 firstSeenTs 不依赖某一条消息送达。
   */
  snapshot(): ParagraphSnapshot[] {
    const out: ParagraphSnapshot[] = [];
    for (const s of this.states) {
      const delta = Math.round(s.dwellMs - s.reportedMs);
      if (delta <= 0 && !s.read) continue;
      s.reportedMs = s.dwellMs;
      out.push({
        index: s.p.index,
        hash: s.p.hash,
        words: s.p.words,
        firstSeenTs: s.readTs ?? 0,
        dwellMs: Math.max(0, delta),
      });
    }
    return out;
  }

  destroy(): void {
    this.setActive(false);
    this.observer?.disconnect();
    this.observer = null;
    this.candidates.clear();
  }
}
