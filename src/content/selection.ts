import type {
  AskReply,
  AskRequest,
  AskTurn,
  OcrReply,
  PartialTranslation,
  Settings,
  Snippet,
  TranslateReply,
  TranslateRequest,
} from "../types.ts";
import { judgeSelection } from "../lib/lang.ts";
import { Popover } from "./popover.ts";
import { bindTapTranslation, type TapKind } from "./tapTranslation.ts";

/**
 * 划词翻译的触发与编排。
 *
 * 只在被识别为文章页、且未被域名排除的页面上挂载——这就是"检测当前页面是否
 * 是文章页"这条需求的落点：非文章页根本不会有这套监听。
 */

/**
 * 选完到发请求之间的静默期。双击选词、拖选都会连发多次事件。
 *
 * 280 → 160：双击的两次 mouseup 通常隔 80–150ms，160ms 仍能把它们合成一次；
 * 而单击本身选不出任何东西（选区是折叠的），evaluate 会直接收工，
 * 所以缩短这一段并不会多发请求。
 */
const DEBOUNCE_MS = 160;

/**
 * 触屏上的静默期。
 *
 * 手机上没有 mouseup 这一说：长按选中一个词、再拖两个把手调整范围，页面收到的
 * 只是一串 selectionchange。所以在**粗指针**设备上改听它，把手一放下、选区停住
 * 这么久就当"选完了"。桌面上不能这么干——拖选中途停一下也会触发，半截选区就发出去了，
 * 所以桌面照旧只认 mouseup。
 */
const TOUCH_DEBOUNCE_MS = 600;

/**
 * 点了浮层之后这么久内的 selectionchange 不算数。
 *
 * 触屏上点浮层里的按钮会让选区塌掉，紧跟着的 selectionchange 若照常处理，
 * 就会把用户刚刚确认的那次翻译当"选区没了"给掐断。
 */
const POPOVER_TOUCH_GRACE_MS = 1_000;

/**
 * SW 预热的最短间隔。一次消息能让 service worker 再活约 30s，
 * 20s 补一发足够压住冷启动，又不至于让 SW 长期常驻。
 */
const WARM_INTERVAL_MS = 20_000;

/** 主指针是不是手指。触屏笔记本接着鼠标时是 false，手机上是 true。 */
function coarsePointer(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

export interface SelectionDeps {
  /** App 阅读器传正文容器，启用单击单词、双击句子。 */
  tapRoot?: HTMLElement;
  articleId: string;
  url: string;
  articleTitle: string;
  /** 取当前设置，用于长度阈值热更新。 */
  settings: () => Settings;
  /** 选区所在段落的文本，给 LLM 做语境判断。 */
  contextOf: (range: Range, limit: number) => string;
  /** 识别与翻译共用取消信号，换选区后不再消费旧结果。 */
  recognize: (png: string, signal: AbortSignal) => Promise<OcrReply>;
  /**
   * 发起翻译。`onPartial` 会在译文、音标、语境解释逐批到达时回调；
   * `signal` 一旦 abort 就该断开与 background 的连接，别让请求继续跑。
   */
  translate: (
    req: TranslateRequest,
    onPartial: (p: PartialTranslation) => void,
    signal: AbortSignal,
  ) => Promise<TranslateResponse>;
  /**
   * 就着刚翻完的这段追问一句。增量是**到目前为止的全部答案**（同 StreamOptions.onDelta），
   * 直接覆盖显示即可，不必自己累加。
   */
  ask: (req: AskRequest, onDelta: (text: string) => void, signal: AbortSignal) => Promise<AskReply>;
  /** 唤醒 background service worker，见 DEBOUNCE_MS 旁边的说明。 */
  warm: () => void;
  openOptions: () => void;
}

export type TranslateResponse = TranslateReply;

export class SelectionTranslator {
  private deps: SelectionDeps;
  private popover: Popover;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private taps: ReturnType<typeof bindTapTranslation> | null = null;
  private detach: Array<() => void> = [];
  private closeDetach: Array<() => void> = [];
  /** 递增的请求序号：慢响应回来时若已经不是最新一次选择，就丢弃。 */
  private seq = 0;
  private pending: { rect: DOMRect; req: TranslateRequest } | null = null;
  /** 在途请求的取消开关：换了选区、关了浮层，就该把它掐掉。 */
  private inflight: AbortController | null = null;
  private lastWarm = 0;
  /** 最近一次在浮层上落指的时刻，见 POPOVER_TOUCH_GRACE_MS。 */
  private lastPopoverTouch = 0;
  /** 翻完的这一条，追问要就着它问。没翻出来（还在流式、出错了）时是 null，那时浮层也不给追问入口。 */
  private answered: { snippet: Snippet; context: string } | null = null;
  /** 这个浮层里已经问过的几轮。换一次选区就清空——追问只跟着眼前这一段。 */
  private turns: AskTurn[] = [];

  constructor(deps: SelectionDeps) {
    this.deps = deps;
    this.popover = new Popover({
      onConfirm: () => void this.runPending(),
      onOpenOptions: () => this.deps.openOptions(),
      onAsk: (question) => void this.runAsk(question),
    });
  }

  start(): void {
    if (this.detach.length > 0) return;
    this.ensureClosing();
    const on = this.listen(this.detach);

    if (this.deps.tapRoot) {
      this.taps = bindTapTranslation(this.deps.tapRoot, (range, kind) => {
        this.dismiss();
        this.warm();
        this.evaluateRange(range, kind);
      });
      this.detach.push(() => { this.taps?.stop(); this.taps = null; });
      return;
    }

    // mouseup 而不是 selectionchange：后者在拖选过程中连发几十次。
    // keyup 补上 shift+方向键选中的情况。
    on(document, "mouseup", (e) => this.schedule(e), { capture: true });
    on(document, "keyup", (e) => {
      if ((e as KeyboardEvent).key.startsWith("Arrow")) this.schedule(e);
    });

    if (coarsePointer()) {
      on(document, "touchstart", (e) => {
        if (this.insidePopover(e)) this.lastPopoverTouch = Date.now();
      }, { capture: true, passive: true });
      on(document, "selectionchange", () => {
        if (Date.now() - this.lastPopoverTouch < POPOVER_TOUCH_GRACE_MS) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.evaluate(), TOUCH_DEBOUNCE_MS);
      });
    }
  }

  private listen(group: Array<() => void>) {
    return <K extends keyof DocumentEventMap>(target: Document | Window, type: K,
      fn: (ev: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      target.addEventListener(type, fn as EventListener, opts);
      group.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
  }

  private ensureClosing(): void {
    // OCR 在没开划词的页面也得能点外面 / Esc 关闭；只挂关闭组，不能替用户开启选区监听。
    if (this.closeDetach.length) return;
    const on = this.listen(this.closeDetach);
    on(document, "mousedown", (e) => {
      // 点在浮层里不算"点到别处"，否则按钮永远点不到
      if (this.insidePopover(e)) return;
      // App 的两次轻点由 taps 合并；触摸合成的 mousedown 也不能取消刚发起的整句翻译。
      if (this.deps.tapRoot && e.composedPath().includes(this.deps.tapRoot)) return;
      this.dismiss();
      // 按下就预热：等拖选结束、防抖走完，SW 已经醒了
      if (this.detach.length) this.warm();
    }, { capture: true });
    on(document, "scroll", () => {
      // 追问期间不关：手机上弹出键盘就是一次滚动，正打着字的问题不该被这一下收走。
      // 浮层是 fixed 的，滚动时它停在原处、和原文错开——比丢掉答案划算。
      if (!this.popover.asking) this.dismiss();
    }, { capture: true, passive: true });
    on(document, "keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") this.dismiss();
    });
  }

  showCaptureError(error: string): void {
    this.dismiss();
    this.ensureClosing();
    this.popover.showError(new DOMRect((window.innerWidth - 200) / 2, 0, 200, 0), error, false);
  }

  async translateImage(png: string, rect: DOMRect): Promise<void> {
    this.dismiss();
    this.ensureClosing();
    const mine = ++this.seq;
    const ctrl = new AbortController();
    this.inflight = ctrl;
    this.popover.showRecognizing(rect);
    let reply: OcrReply;
    try {
      reply = await this.deps.recognize(png, ctrl.signal);
    } catch (err) {
      reply = { ok: false, error: String(err) };
    }
    if (mine !== this.seq) return;
    this.inflight = null;
    if (!reply?.ok) {
      this.popover.showError(rect, reply?.error ?? "识别失败：后台未就绪", false);
      return;
    }
    this.popover.setTerm(reply.text);
    const settings = this.deps.settings();
    const verdict = judgeSelection(reply.text, settings);
    if (!verdict.ok) {
      this.popover.showError(rect, verdict.reason === "选区过长"
        ? "识别文字过长，请缩小框选范围" : "没认出英文，请重新框选清晰的英文文字", false);
      return;
    }
    const req: TranslateRequest = {
      articleId: this.deps.articleId, url: this.deps.url, articleTitle: this.deps.articleTitle,
      text: verdict.text, context: verdict.text, kind: verdict.kind, explainVocab: settings.explainVocab,
    };
    this.pending = { rect, req };
    if (verdict.needsConfirm) this.popover.showConfirm(rect, verdict.text, verdict.words, "image");
    else await this.runPending();
  }

  stop(): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.dismiss();
  }

  private insidePopover(e: Event): boolean {
    const host = this.popover.hostElement;
    return host !== null && e.composedPath().includes(host);
  }

  dismiss(): void {
    this.taps?.cancel();
    if (!this.detach.length) {
      for (const off of this.closeDetach) off();
      this.closeDetach = [];
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.answered = null;
    this.turns = [];
    this.seq += 1; // 让在途响应作废
    this.inflight?.abort();
    this.inflight = null;
    this.popover.hide();
  }

  private warm(): void {
    const now = Date.now();
    if (now - this.lastWarm < WARM_INTERVAL_MS) return;
    this.lastWarm = now;
    this.deps.warm();
  }

  private schedule(e: Event): void {
    if (this.insidePopover(e)) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.evaluate(), DEBOUNCE_MS);
  }

  private evaluate(): void {
    /*
     * 正在追问：不看选区。
     *
     * 点进输入框、乃至在里面打字，都会让页面上原来那段选区塌掉；触屏上这一下会走
     * selectionchange 进到这里，照常判下去就是「选区没了」→ 关掉浮层，用户的问题
     * 打到一半凭空消失。而追问要问的那一段早就存进 answered 了，选区此刻已无用。
     */
    if (this.popover.asking) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.dismiss();
      return;
    }
    // 在输入框里选字通常是要编辑，不是要查词
    if (isEditable(sel.anchorNode)) {
      this.dismiss();
      return;
    }

    this.evaluateRange(sel.getRangeAt(0));
  }

  private evaluateRange(range: Range, kind?: TapKind): void {
    const settings = this.deps.settings();
    // 明确点词也允许 I / a；双击的短句始终按句子记录，不生成词组复习卡。
    const verdict = judgeSelection(range.toString(), kind ? { ...settings, minSelectionChars: 1 } : settings);
    if (!verdict.ok) {
      this.popover.hide();
      return;
    }

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const req: TranslateRequest = {
      articleId: this.deps.articleId,
      url: this.deps.url,
      articleTitle: this.deps.articleTitle,
      text: verdict.text,
      context: this.deps.contextOf(range, settings.contextChars),
      kind: kind ?? verdict.kind,
      explainVocab: settings.explainVocab,
    };
    this.pending = { rect, req };

    if (verdict.needsConfirm) {
      this.popover.showConfirm(rect, verdict.text, verdict.words);
      return;
    }
    void this.runPending();
  }

  private async runPending(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    const mine = ++this.seq;
    const { rect, req } = pending;
    this.answered = null;
    this.turns = [];

    this.inflight?.abort();
    const ctrl = new AbortController();
    this.inflight = ctrl;

    this.popover.showStreaming(rect, req.text);
    let res: TranslateResponse;
    try {
      res = await this.deps.translate(
        req,
        // 迟到的增量属于上一次选择，丢掉
        (p) => {
          if (mine === this.seq) this.popover.updateStream(p);
        },
        ctrl.signal,
      );
    } catch (err) {
      res = { ok: false, error: String(err), needsConfig: false };
    }
    // 期间用户又选了别的、或者关掉了浮层——这次结果已经过期
    if (mine !== this.seq) return;
    if (this.inflight === ctrl) this.inflight = null;
    if (res.ok) {
      this.answered = { snippet: res.snippet, context: req.context };
      this.popover.showResult(rect, res.snippet);
      // 翻出来了才给追问入口：没有译文可倚，追问问的是空气
      this.popover.enableAsk();
    } else this.popover.showError(rect, res.error, res.needsConfig);
  }

  /**
   * 用户在浮层里问了一句。
   *
   * 沿用翻译那套作废机制：seq 一变（换了选区、关了浮层）就丢掉迟到的增量和结果；
   * in-flight 也共用一个 AbortController——一个浮层同一时刻只烧一次 token。
   */
  private async runAsk(question: string): Promise<void> {
    const cur = this.answered;
    if (!cur) return;
    const mine = this.seq; // 追问不换选区，不能动 seq，否则自己把自己作废了
    const s = cur.snippet;

    this.inflight?.abort();
    const ctrl = new AbortController();
    this.inflight = ctrl;

    const req: AskRequest = {
      text: s.text,
      kind: s.kind,
      translation: s.translation,
      contextNote: s.contextNote,
      context: cur.context,
      articleTitle: s.articleTitle,
      question,
      history: this.turns,
    };

    let res: AskReply;
    try {
      res = await this.deps.ask(
        req,
        (text) => {
          if (mine === this.seq) this.popover.updateAnswer(text);
        },
        ctrl.signal,
      );
    } catch (err) {
      res = { ok: false, error: String(err), needsConfig: false };
    }
    if (mine !== this.seq) return;
    if (this.inflight === ctrl) this.inflight = null;
    if (res.ok) {
      this.turns.push({ question, answer: res.text });
      this.popover.finishAnswer(res.text);
    } else this.popover.failAnswer(res.error, res.needsConfig);
  }
}

function isEditable(node: Node | null): boolean {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  if (!el) return false;
  if (el.closest("input, textarea")) return true;
  return el.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * 取选区所在段落的文本作为上下文。
 *
 * 往上找到最近的块级祖先，超长就以选区为中心裁一段——发整篇太贵，
 * 只发选中的几个词又判断不了多义词在此处的义项。
 */
export function paragraphContext(range: Range, limit: number): string {
  const start = range.startContainer;
  const el = start instanceof Element ? start : start.parentElement;
  const block = el?.closest("p, li, blockquote, td, dd, h1, h2, h3, h4, h5, h6, figcaption, article, section, div");
  const full = (block?.textContent ?? range.toString()).replace(/\s+/g, " ").trim();
  if (full.length <= limit) return full;

  const selected = range.toString().replace(/\s+/g, " ").trim();
  const at = full.indexOf(selected);
  if (at < 0) return full.slice(0, limit);
  const half = Math.floor((limit - selected.length) / 2);
  const from = Math.max(0, at - Math.max(0, half));
  return full.slice(from, from + limit);
}
