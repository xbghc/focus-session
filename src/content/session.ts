import type { EndReason } from "../types.ts";
import { quietLimitMs } from "../lib/reading.ts";

export interface SessionThresholds {
  idleTimeoutMs: number;
  stallTimeoutMs: number;
  minSessionMs: number;
  /**
   * 静默上限的自适应天花板。实际上限 = max(固定阈值, 视口文字预计阅读时间 × READ_GRACE)，
   * 再夹到这个数以下。0 关闭自适应。
   */
  maxQuietMs: number;
}

export interface SessionEndEvent {
  startTs: number;
  endTs: number;
  durationMs: number;
  reason: EndReason;
  /** 过短的 session（alt-tab 抖动）不值得入库。 */
  discard: boolean;
}

export interface SessionMachineDeps {
  now(): number;
  onStart(startTs: number): void;
  onEnd(ev: SessionEndEvent): void;
  /** 当前视口里的文字读完需要多久。不给就按固定阈值。 */
  visibleExpectedMs?: () => number;
}

/**
 * session 划分状态机。纯逻辑、不碰 DOM，时钟由外部注入，便于确定性测试。
 *
 * 活跃条件 = 页面可见 且 窗口有焦点。两个独立的走神阈值：
 *   idle  —— 完全没有活动信号
 *   stall —— 有输入但滚动位置不变（发呆）
 *
 * 两个阈值都**随视口里的文字量自适应**：阅读本身不产生输入，一屏 400 词按 238 wpm
 * 要读 100 秒，固定 30 秒的阈值落在正常阅读的静默间隔中间，每读一屏就切一刀
 * （实测近半 session 因此以 idle 结束、时长中位正好卡在阈值附近）。
 * 所以静默上限 = max(固定阈值, 视口文字预计阅读时间 × 1.5)，夹到 maxQuietMs 以下。
 * 固定阈值成了下限：视口里没什么字（图、评论区）时它照旧起作用。
 *
 * 关于 endTs：两种走神都取**当下时刻**，不回溯。
 *
 * 两个阈值触发的都只是"没有输入"，而阅读本身不产生输入——安静读完一屏和
 * 起身走开在信号上完全一样，无从区分。回溯到最后一次活动会把这一屏的阅读时间
 * 连同真正的空白一起抹掉：触屏设备没有 mousemove，滚动之间的每一屏都会被记成
 * 0 秒，一整天的阅读记录为空。桌面端同样存在，只是手不离鼠标时不易暴露。
 *
 * 代价是每次真离开最多高估一个静默上限的时长——自适应之后这个上限随文字量变化，
 * 但有 maxQuietMs 封顶，且因为 awaiting* 标志不会连锁累加，仍然有界可控。
 * 宁可有界地高估，不要无声地销毁真实数据。
 */
export class SessionMachine {
  private visible: boolean;
  private focused: boolean;
  private startTs: number | null = null;
  private lastActivityTs = 0;
  private lastScrollY = 0;
  private lastScrollChangeTs = 0;
  /** 因 idle 结束后置位：任何活动信号都可以重新开始计时。 */
  private awaitingActivity = false;
  /**
   * 因 stall 结束后置位：必须出现真实的滚动位移才重新开始计时。
   * 若这里也接受任意信号，盯着一屏不动、只是随手晃鼠标的半小时会被切成
   * 一串 stall session 并**全额计入专注时长**——那正好把这个指标的含义弄反了。
   */
  private awaitingScroll = false;

  private thresholds: SessionThresholds;
  private deps: SessionMachineDeps;

  constructor(
    thresholds: SessionThresholds,
    deps: SessionMachineDeps,
    initial: { visible: boolean; focused: boolean; scrollY?: number } = { visible: true, focused: true },
  ) {
    this.thresholds = thresholds;
    this.deps = deps;
    this.visible = initial.visible;
    this.focused = initial.focused;
    this.lastScrollY = initial.scrollY ?? 0;
  }

  get isRunning(): boolean {
    return this.startTs !== null;
  }

  get activeSince(): number | null {
    return this.startTs;
  }

  /** 阈值改动后立即生效，无需重载页面。 */
  updateThresholds(next: Partial<SessionThresholds>): void {
    this.thresholds = { ...this.thresholds, ...next };
  }

  /** 此刻生效的静默上限。popup 拿它解释"为什么还没算走神"。 */
  quietLimits(): { idleMs: number; stallMs: number } {
    const visible = this.deps.visibleExpectedMs?.() ?? 0;
    const { idleTimeoutMs, stallTimeoutMs, maxQuietMs } = this.thresholds;
    return {
      idleMs: quietLimitMs(idleTimeoutMs, visible, maxQuietMs),
      stallMs: quietLimitMs(stallTimeoutMs, visible, maxQuietMs),
    };
  }

  /** 页面加载后调用一次：若此刻已处于活跃状态就立刻开始计时。 */
  bootstrap(): void {
    this.maybeStart();
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.reconcile("hidden");
  }

  setFocused(v: boolean): void {
    if (v === this.focused) return;
    this.focused = v;
    this.reconcile("blur");
  }

  /** 任一活动信号：scroll / wheel / mousemove / keydown / touchmove。 */
  activity(scrollY: number): void {
    const now = this.deps.now();
    this.lastActivityTs = now;
    const scrolled = scrollY !== this.lastScrollY;
    if (scrolled) {
      this.lastScrollY = scrollY;
      this.lastScrollChangeTs = now;
    }
    if (!this.isActive) return;
    // 发呆之后要有真实的滚动位移才算重新投入阅读
    if (this.awaitingScroll && !scrolled) return;
    this.awaitingActivity = false;
    this.awaitingScroll = false;
    this.maybeStart();
  }

  /** 由 1s 定时器驱动，仅在有 session running 时需要调用。 */
  tick(): void {
    if (this.startTs === null) return;
    const now = this.deps.now();
    const { idleMs, stallMs } = this.quietLimits();
    if (now - this.lastActivityTs >= idleMs) {
      this.end("idle", now);
      this.awaitingActivity = true;
      return;
    }
    if (now - this.lastScrollChangeTs >= stallMs) {
      this.end("stall", now);
      this.awaitingScroll = true;
    }
  }

  /** 页面卸载等外部终止。 */
  stop(reason: EndReason): void {
    this.end(reason, this.deps.now());
  }

  private get isActive(): boolean {
    return this.visible && this.focused;
  }

  private reconcile(inactiveReason: EndReason): void {
    if (this.isActive) {
      // 重新变为活跃时立刻开始：读第一屏而不滚动也是阅读，不必等活动信号。
      this.awaitingActivity = false;
      this.awaitingScroll = false;
      this.maybeStart();
    } else {
      this.end(inactiveReason, this.deps.now());
    }
  }

  private maybeStart(): void {
    if (this.startTs !== null || !this.isActive || this.awaitingActivity || this.awaitingScroll) return;
    const now = this.deps.now();
    this.startTs = now;
    this.lastActivityTs = now;
    this.lastScrollChangeTs = now;
    this.deps.onStart(now);
  }

  private end(reason: EndReason, endTs: number): void {
    const startTs = this.startTs;
    if (startTs === null) return;
    this.startTs = null;
    const clamped = Math.max(startTs, endTs);
    const durationMs = clamped - startTs;
    this.deps.onEnd({
      startTs,
      endTs: clamped,
      durationMs,
      reason,
      discard: durationMs < this.thresholds.minSessionMs,
    });
  }
}
