/**
 * 浮层里流式内容的打字机：字一个一个出来，而不是一截一截地蹦。
 *
 * 模型的增量是成块到的——译文几个字一闭合、语境解释整段一起到、生词一条一条来——直接写进去，
 * 浮层就一顿一顿地往外跳。这里把「该显示什么」和「已经显示到哪」分开：写进来的只是目标，
 * 每一动画帧按 DOM 顺序往后多露几个字，像一台打字机从上往下打。
 *
 * 速度自适应：平时 BASE_CPS 字每秒；一次积压得多（整段讲解一起到）就在 CATCHUP_MS 内追平，
 * 所以永远不会越打越落后于模型——最多比直接显示晚这么一小会儿。
 *
 * 只往文本节点上 appendData，不换节点：人在浮层里正选着的字不会因为下一帧丢掉。
 * 没有动画帧（测试环境）、或者系统要求减少动画时，写进来就直接显示，和没有打字机时一模一样。
 */

/** 平时的速度：60Hz 下一帧一个字。 */
export const BASE_CPS = 60;
/** 新到的字连同还没打完的，最多用这么久打完。 */
export const CATCHUP_MS = 700;
/** 两帧之间最多按这么久算：标签页切到后台再回来，别一帧把积压全倒出来——也别因此卡住。 */
const MAX_FRAME_MS = 100;

export interface TypewriterDeps {
  /** 缺省是 requestAnimationFrame；没有就直接显示。 */
  frame?: ((cb: (t: number) => void) => unknown) | null;
  cancel?: (handle: unknown) => void;
  /** 系统要求减少动画时为真。缺省看 prefers-reduced-motion。 */
  reducedMotion?: () => boolean;
}

export interface TypewriterHooks {
  /** 每一帧把字露出来的那一下，由调用方包一层（比如追问答案要贴底滚动）。 */
  apply: (reveal: () => void) => void;
  /** 露完一帧之后：浮层据此重新贴位。 */
  afterFrame?: () => void;
  /** 目标全部露完、打字机停下来的时候。 */
  idle?: () => void;
}

interface Slot { node: Text; full: string }

const defaultFrame = (): TypewriterDeps["frame"] =>
  typeof requestAnimationFrame === "function" ? (cb) => requestAnimationFrame(cb) : null;
const defaultReduced = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 从 from 往后数 n 个码点，返回新的下标。按码点走，emoji 这类代理对不会被劈成两半露出来。 */
function advance(text: string, from: number, n: number): number {
  let i = from;
  for (let k = 0; k < n && i < text.length; k++) i += (text.codePointAt(i)! > 0xffff ? 2 : 1);
  return i;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  // 别停在代理对中间
  if (i > 0 && i < a.length && /[\uD800-\uDBFF]/.test(a[i - 1]!)) i--;
  return i;
}

export class Typewriter {
  private slots: Slot[] = [];
  private handle: unknown = null;
  private last: number | null = null;
  /** 攒着的零头：一帧不到一个字的那部分留到下一帧。 */
  private carry = 0;
  /**
   * 这一波的速度（字每秒）。只在有新字进来时定，之后匀速打完——每帧照剩下的重算的话，
   * 剩得越少打得越慢，尾巴拖得比 CATCHUP_MS 长得多。
   */
  private cps = BASE_CPS;
  private readonly frame: TypewriterDeps["frame"];
  private readonly cancel: (handle: unknown) => void;
  private readonly reduced: () => boolean;
  private readonly hooks: TypewriterHooks;

  constructor(hooks: TypewriterHooks, deps: TypewriterDeps = {}) {
    this.hooks = hooks;
    this.frame = deps.frame === undefined ? defaultFrame() : deps.frame;
    this.cancel = deps.cancel ?? ((h) => { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(h as number); });
    this.reduced = deps.reducedMotion ?? defaultReduced;
  }

  /** 还有字没露出来。 */
  get busy(): boolean {
    return this.slots.some((s) => s.node.data.length < s.full.length);
  }

  /** 这一刻该不该动画。没有动画帧、或者要减少动画，就直接显示。 */
  private get animated(): boolean {
    return !!this.frame && !this.reduced();
  }

  /**
   * 让 el 最终显示 text。el 里只该有文字：第一次写时把里面原来的东西（转圈之类）清掉。
   * 目标不是已显示部分的延续（模型改了口、最终结果和流式不一样）时，已显示的退到两者的公共前缀，从那里接着打。
   * instant：这一次直接显示，不打——命中缓存、没有经过流式的结果不该演一遍打字。
   */
  write(el: Element, text: string, instant = false): void {
    let node = el.childNodes.length === 1 && el.firstChild?.nodeType === 3 ? el.firstChild as Text : null;
    if (!node) {
      el.textContent = "";
      node = document.createTextNode("");
      el.append(node);
    }
    if (instant || !this.animated) {
      this.slots = this.slots.filter((s) => s.node !== node);
      // 字真变了才写；越写越长的只把新长出来的那截接上去——整个重写会把人正选着的字弄丢
      if (node.data === text) return;
      if (text.startsWith(node.data)) node.appendData(text.slice(node.data.length));
      else node.data = text;
      return;
    }
    const slot = this.slots.find((s) => s.node === node);
    if (slot) slot.full = text;
    else this.insert({ node, full: text });
    if (!text.startsWith(node.data)) node.data = text.slice(0, commonPrefix(node.data, text));
    this.schedule();
  }

  /**
   * 接管刚挂上去的一整块（一条生词）：里面的字先藏起来，轮到它时再打。
   * skip 挑出不打的元素（音标词性、按钮），它们照原样直接显示。
   */
  adopt(root: Element, skip: (el: Element) => boolean = () => false): void {
    if (!this.animated) return;
    const walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    const found: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      let hidden = false;
      for (let p = text.parentElement; p && p !== root.parentElement; p = p.parentElement) if (skip(p)) { hidden = true; break; }
      if (!hidden && text.data) found.push(text);
    }
    for (const text of found) {
      this.insert({ node: text, full: text.data });
      text.data = "";
    }
    if (found.length) this.schedule();
  }

  /** 全部立刻露出来。 */
  flush(): void {
    for (const s of this.slots) if (s.node.data !== s.full) s.node.data = s.full;
    this.stop();
    this.hooks.afterFrame?.();
    this.hooks.idle?.();
  }

  /** 丢掉手上的一切（整块重建、浮层关掉）。已经露出来的字留在原地，没露的就不露了。 */
  clear(): void {
    this.slots = [];
    this.stop();
  }

  private stop(): void {
    if (this.handle !== null) this.cancel(this.handle);
    this.handle = null;
    this.last = null;
    this.carry = 0;
  }

  /** 按 DOM 顺序插：打字机从上往下打，后到的字段排在它在浮层里的位置，不排在队尾。 */
  private insert(slot: Slot): void {
    const at = this.slots.findIndex((s) => (slot.node.compareDocumentPosition(s.node) & 4 /* FOLLOWING */) !== 0);
    if (at < 0) this.slots.push(slot);
    else this.slots.splice(at, 0, slot);
  }

  private schedule(): void {
    const backlog = this.slots.reduce((n, s) => n + s.full.length - s.node.data.length, 0);
    this.cps = Math.max(BASE_CPS, backlog / (CATCHUP_MS / 1000));
    if (this.handle !== null || !this.frame) return;
    // 从停着的状态起步：第一帧就露一个字，不等攒够零头
    if (this.last === null) this.carry = Math.max(this.carry, 1);
    this.handle = this.frame((t) => this.tick(t));
  }

  private tick(t: number): void {
    this.handle = null;
    // 起步那一帧只露 schedule 预支的那一个字，速度从下一帧算起
    const dt = this.last === null ? 0 : Math.min(MAX_FRAME_MS, Math.max(0, t - this.last));
    this.last = t;
    // 节点已经被整块换掉的（失败提示覆盖了答案、字段被摘掉）不再管
    this.slots = this.slots.filter((s) => s.node.isConnected);
    const backlog = this.slots.reduce((n, s) => n + s.full.length - s.node.data.length, 0);
    if (backlog <= 0) {
      this.slots = [];
      this.last = null;
      this.carry = 0;
      this.hooks.idle?.();
      return;
    }
    this.carry += (this.cps * dt) / 1000;
    // 60 字每秒乘 1/60 秒在浮点里未必正好是 1，给一点余量，免得隔帧才露一个
    let budget = Math.floor(this.carry + 1e-6);
    this.carry -= budget;
    if (budget > 0) {
      this.hooks.apply(() => {
        for (const s of this.slots) {
          if (budget <= 0) break;
          const shown = s.node.data.length;
          if (shown >= s.full.length) continue;
          const to = advance(s.full, shown, budget);
          budget -= to - shown;
          s.node.appendData(s.full.slice(shown, to));
        }
      });
      this.hooks.afterFrame?.();
    }
    this.handle = this.frame!((next) => this.tick(next));
  }
}
