/**
 * 页面顶上那条细细的阅读情况条：这篇文章每一段读过没有，一眼看完。
 *
 * 每段按**字数**占宽度，不按它在页面上的高度——配图、代码块占一屏却没几个字，按高度排会把条撑歪；
 * 按字数排，实心的部分加起来正好就是弹出面板里的「已读比例」。也因此它不看页面布局：
 * 正文放在内层滚动容器里的站点、图片懒加载把页面撑高，条都不会错位。
 *
 * 四档：这次读的（停够了已读阈值）、以前读的、扫过（露过面没停够）、没看过。
 * 屏幕上正显示着的那一截，条下面贴一道深色短线——就是滚动条的滑块，搬到了条上。
 * 不用「这一截亮、其余调暗」：调暗之后的「读过」和「扫过」是同一种浅色，分不出来（真浏览器里截图看过）。
 *
 * 只看不点：鼠标和手指都穿过去，不挡页面自己的导航栏。
 * 没考虑放在滚动条旁边：扩展画不到原生滚动条上，贴着它另画一条又得跟页面布局对齐，上面那两种站点都对不准。
 */

export type FocusState = "read" | "earlier" | "glanced" | "unseen";
export interface FocusMark { words: number; state: FocusState }
/** 条上的一截，0–1。 */
export interface FocusSpan { from: number; to: number }
export interface FocusRun extends FocusSpan { state: FocusState }

const HOST_ID = "focus-session-focusbar";

const CSS = `
:host { all: initial; }
.bar {
  position: fixed;
  /* App 里状态栏那一截让开（见 app/native.ts 的 --inset-top） */
  top: max(env(safe-area-inset-top), var(--inset-top, 0px));
  left: 0;
  right: 0;
  height: 3px;
  z-index: 2147483644; /* 压在读完角标、位置提示之下 */
  pointer-events: none;
  --read: #9c4d14;
  --earlier: #7d8896;
  --glanced: rgba(156, 77, 20, 0.32);
  --unseen: rgba(128, 128, 128, 0.2);
}
.track { position: absolute; inset: 0; }
.here {
  position: absolute;
  top: 100%;
  height: 2px;
  background: rgba(40, 34, 28, 0.6);
}
.here[hidden] { display: none; }
@media (prefers-color-scheme: dark) {
  .bar { --read: #e18d5a; --earlier: #93a0af; --glanced: rgba(225, 141, 90, 0.35); --unseen: rgba(160, 160, 160, 0.22); }
  .here { background: rgba(236, 229, 219, 0.65); }
}
@media print { .bar { display: none; } }
`;

/** 按字数把段落排成一截一截，相邻同一档的并成一截。没有字的段落不占地方。 */
export function focusRuns(marks: readonly FocusMark[]): FocusRun[] {
  const total = marks.reduce((n, m) => n + Math.max(0, m.words), 0);
  if (total <= 0) return [];
  const runs: FocusRun[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.words <= 0) continue;
    const to = (at += m.words) / total;
    const last = runs[runs.length - 1];
    if (last?.state === m.state) last.to = to;
    else runs.push({ state: m.state, from: last?.to ?? 0, to });
  }
  return runs;
}

const pct = (x: number): string => `${+(x * 100).toFixed(3)}%`;

/** 一截一截拼成硬边的横向渐变：一个元素画完，不用每段一个节点。 */
export function focusGradient(runs: readonly FocusRun[]): string {
  if (runs.length === 0) return "none";
  return `linear-gradient(to right, ${runs.map((r) => `var(--${r.state}) ${pct(r.from)} ${pct(r.to)}`).join(", ")})`;
}

export class FocusBar {
  private host: HTMLElement | null = null;
  private track: HTMLElement | null = null;
  private here: HTMLElement | null = null;
  private drawn = "";

  /** 宿主元素——测试断言用。 */
  get hostElement(): HTMLElement | null {
    return this.host;
  }

  /** 画上去或者更新。每一帧都可能调（跟着滚动），只有段落的档位变了才重新拼渐变。 */
  show(marks: readonly FocusMark[], span: FocusSpan | null): void {
    if (!this.host) this.mount();
    const gradient = focusGradient(focusRuns(marks));
    if (gradient !== this.drawn) {
      this.drawn = gradient;
      this.track!.style.background = gradient;
    }
    // 视口里没有正文（滚到了评论区）时不标
    this.here!.hidden = span === null;
    if (span) {
      this.here!.style.left = pct(span.from);
      this.here!.style.width = pct(Math.max(0, span.to - span.from));
    }
  }

  hide(): void {
    this.host?.remove();
    this.host = this.track = this.here = null;
    this.drawn = "";
  }

  private mount(): void {
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:static;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.setAttribute("aria-hidden", "true");
    this.track = document.createElement("div");
    this.track.className = "track";
    this.here = document.createElement("div");
    this.here.className = "here";
    bar.append(this.track, this.here);
    root.append(style, bar);
    document.documentElement.appendChild(host);
    this.host = host;
  }
}
