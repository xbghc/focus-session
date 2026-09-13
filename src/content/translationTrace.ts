import type { PartialTranslation, SnippetKind } from "../types.ts";
import { traceDurations, type PopupPosition, type TranslationInputTiming, type TranslationTrace } from "../lib/translationDiagnostics.ts";

const MAX_MOVES = 100;
const MAX_PARTIALS = 100;
const SETTLE_TIMEOUT_MS = 2_000;
const rounded = (n: number): number => Math.round(n * 100) / 100;

/** 仅翻译浮层生命周期启用；按动画帧采样，排除 position() 里先归零的不可见中间值。 */
export class TranslationTraceRecorder {
  readonly log: TranslationTrace;
  private start: number;
  private now: () => number;
  private save: (log: TranslationTrace) => void;
  private box: HTMLElement | null = null;
  private frame: number | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private done = false;
  private finalStatus: "success" | "error" | null = null;
  private stable = 0;

  constructor(input: TranslationInputTiming, text: string, kind: SnippetKind, save: (log: TranslationTrace) => void,
    now: () => number = () => performance.now()) {
    this.start = input.started;
    this.now = now;
    this.save = save;
    this.log = {
      id: crypto.randomUUID(), ts: Date.now() - Math.max(0, now() - input.started), source: input.source,
      text: text.slice(0, 160), textChars: text.length, kind, status: "cancelled", reason: null, cached: null,
      marks: { inputStart: 0 }, durations: {}, partials: [], backend: null,
      popup: { measurement: typeof requestAnimationFrame === "function" ? "animation-frame" : "unavailable",
        positionCalls: 0, positionChanges: 0, samples: 0, initial: null, final: null, moves: [], movesTruncated: false },
    };
    this.mark("selectionEnd", input.committed);
    if (input.resolved !== undefined) this.mark("selectionResolved", input.resolved);
    if (input.debounceEnded !== undefined) this.mark("debounceEnd", input.debounceEnded);
  }

  mark(name: string, at = this.now()): void {
    if (!this.done && this.log.marks[name] === undefined) this.log.marks[name] = rounded(Math.max(0, at - this.start));
  }

  partial(p: PartialTranslation, render: () => void): void {
    this.mark("firstPartial");
    const before = this.now();
    render();
    if (p.translation) this.mark("firstTranslationDom");
    if (!this.done && this.log.partials.length < MAX_PARTIALS) this.log.partials.push({
      atMs: rounded(before - this.start), renderMs: rounded(this.now() - before),
      fields: Object.entries(p).filter(([, v]) => Array.isArray(v) ? v.length > 0 : !!v).map(([k]) => k),
    });
  }

  positioned(box: HTMLElement): void {
    if (this.done) return;
    this.box = box;
    this.log.popup.positionCalls++;
    this.queueFrame();
  }

  private queueFrame(): void {
    if (this.frame !== null || this.done || typeof requestAnimationFrame !== "function") return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.sample();
      if (!this.done) this.queueFrame();
    });
  }

  private sample(): void {
    if (this.done || !this.box?.isConnected || document.visibilityState === "hidden") return;
    const r = this.box.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const viewport = window.visualViewport;
    const pos: PopupPosition = { x: rounded(r.left - (viewport?.offsetLeft ?? 0)), y: rounded(r.top - (viewport?.offsetTop ?? 0)),
      width: rounded(r.width), height: rounded(r.height), scale: viewport?.scale ?? 1 };
    const popup = this.log.popup;
    const prev = popup.final;
    this.mark("popupShown");
    if (this.log.marks.firstTranslationDom !== undefined) this.mark("firstTranslationVisible");
    popup.samples++;
    popup.initial ??= pos;
    // 小于半个 CSS 像素的浮点抖动忽略；宽高变化本身不算位置改变。
    const moved = !!prev && (Math.abs(pos.x - prev.x) >= 0.5 || Math.abs(pos.y - prev.y) >= 0.5);
    if (moved) {
      popup.positionChanges++;
      if (popup.moves.length < MAX_MOVES) popup.moves.push({ atMs: rounded(this.now() - this.start), from: prev, to: pos });
      else popup.movesTruncated = true;
    }
    const same = prev && !moved && Math.abs(pos.width - prev.width) < 0.5 && Math.abs(pos.height - prev.height) < 0.5 && pos.scale === prev.scale;
    popup.final = pos;
    if (!this.finalStatus) return;
    this.stable = same ? this.stable + 1 : 0;
    // 字体完成后连续两帧稳定作为渲染完成边界；这是绘制机会观测，不声称测到 GPU 呈现。
    if (this.stable >= 2 && (!document.fonts || document.fonts.status === "loaded")) {
      this.mark("renderComplete");
      this.finish(this.finalStatus);
    }
  }

  complete(status: "success" | "error", reason: string | null = null): void {
    if (this.done) return;
    this.mark("finalDom");
    this.log.reason = reason;
    this.finalStatus = status;
    this.stable = 0;
    if (this.log.popup.measurement === "unavailable") {
      this.finish("unobserved", "当前环境不支持动画帧采样");
      return;
    }
    this.timeout = setTimeout(() => this.finish("render-timeout", "最终内容更新后 2000ms 内未观测到字体就绪且连续两帧稳定"), SETTLE_TIMEOUT_MS);
    this.queueFrame();
  }

  finish(status: TranslationTrace["status"], reason?: string): void {
    if (this.done) return;
    this.mark("ended");
    this.done = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.frame = null;
    this.timeout = null;
    this.log.status = status;
    if (reason !== undefined) this.log.reason = reason;
    this.log.durations = traceDurations(this.log.marks);
    // 日志失败不能反向影响翻译，也不把 DOM、原文上下文或密钥传给日志。
    try { this.save(structuredClone(this.log)); } catch { /* best effort */ }
  }
}
