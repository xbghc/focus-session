/**
 * 跳回上次位置后，左下角的一行说明。
 *
 * 有它是因为「打开一篇文章，画面却不在开头」如果没有解释，第一反应是页面坏了。
 * 所以这条提示要同时回答两个问题：为什么在这里，怎么回去。
 *
 * 和读完角标的三点不同：
 * - **会自动消失**（被看到之后 6 秒）。它说的是一件已经发生的事，读完这行字它就没用了，
 *   而正文此刻就在它旁边。读完角标那种「常驻到手动关」的做法在这里是挡路。
 * - 挂在**左**下角。右下角留给读完角标——两个都在的场景是有的（跳回文末附近、
 *   接着读完最后一段），叠在一起谁都看不清。
 * - 不共用角标的 host：那边的 `hide()` 会把自己的宿主整个 remove 掉。
 */

const HOST_ID = "focus-session-position";

/** 提示停留时长。够读完一行字，短到不会跟着人一路往下滚。 */
const AUTO_HIDE_MS = 6_000;

const CSS = `
:host { all: initial; }
.card {
  position: fixed;
  left: 20px;
  bottom: 20px;
  z-index: 2147483645; /* 压在读完角标之下：那个是入口，这个只是一句交代 */
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px 9px 13px;
  border-radius: 3px;
  border: 1px solid #e0d8cb;
  border-left: 3px solid #a4551f;
  background: #fffdfa;
  color: #1f1b16;
  box-shadow: 0 1px 2px rgba(31, 27, 22, 0.06), 0 10px 28px rgba(31, 27, 22, 0.14);
  font: 13px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  animation: rise 240ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
.card.leaving { opacity: 0; transition: opacity 200ms ease-out; }
@keyframes rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .card { animation: none; }
  .card.leaving { transition: none; }
}
.label { display: flex; flex-direction: column; gap: 1px; }
.title { font-weight: 600; letter-spacing: -0.01em; }
.sub { color: #6f6558; font-size: 11.5px; }
button {
  font: inherit;
  cursor: pointer;
  border-radius: 2px;
  border: 1px solid #e0d8cb;
  background: #f7f2e9;
  color: #4a4238;
  padding: 5px 11px;
  transition: color 120ms, border-color 120ms;
}
button:hover { color: #a4551f; border-color: #a4551f; }
@media (prefers-color-scheme: dark) {
  .card { background: #262220; color: #e8e0d5; border-color: #332f2a; border-left-color: #e18d5a; }
  .sub { color: #9a8f7f; }
  button { background: #1c1917; color: #bdb3a4; border-color: #3d3833; }
  button:hover { background: #332f2a; color: #e18d5a; border-color: #e18d5a; }
}
`;

export interface PositionCardActions {
  /** 点了「回到顶部」。 */
  onTop: () => void;
}

export class PositionCard {
  private host: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 页面当前不可见时挂着的一次性监听，等它被看到再开始倒计时。 */
  private onVisible: (() => void) | null = null;
  private actions: PositionCardActions;

  constructor(actions: PositionCardActions) {
    this.actions = actions;
  }

  /** 宿主元素——测试断言用。 */
  get hostElement(): HTMLElement | null {
    return this.host;
  }

  /**
   * `at` / `total` 是段落序号，让人一眼知道跳到了文章的什么位置；
   * `remaining` 是「还需约 12 分钟」这样的一句，由调用方按阅读历史算好传进来，没有就不显示。
   */
  show(at: number, total: number, remaining?: string): void {
    if (this.host) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:static;";
    const root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = CSS;

    const card = document.createElement("div");
    card.className = "card";
    // 三个插值都是自己算出来的数字和固定文案，没有来自网页的内容
    card.innerHTML = `<div class="label"><span class="title">已回到上次读到的位置</span><span class="sub">第 ${at} 段 / 共 ${total} 段${remaining ? " · " + remaining : ""}</span></div>
       <button data-act="top">回到顶部</button>`;
    card.querySelector('[data-act="top"]')!.addEventListener("click", () => {
      this.hide();
      this.actions.onTop();
    });

    root.append(style, card);
    document.documentElement.appendChild(host);
    this.host = host;

    this.armAutoHide(card);
  }

  /**
   * 开始倒计时——但**只在页面被看到时**。
   *
   * 从信息流里中键新开一个后台标签页是这类工具最常见的打开方式：正文抽取要几秒，
   * 跳转也就发生在没人看着的时候。此时若立刻起表，等用户切过来提示早没了，
   * 而那恰恰是最需要解释的一刻——他打开的页面直接停在文章中间。
   * 跳转本身不必等：在没人看的时候跳完，切过来就是现成的画面。
   */
  private armAutoHide(card: HTMLElement): void {
    if (document.visibilityState !== "visible") {
      const onVisible = (): void => {
        if (document.visibilityState !== "visible") return;
        this.clearVisibilityWatch();
        this.armAutoHide(card);
      };
      this.onVisible = onVisible;
      document.addEventListener("visibilitychange", onVisible);
      return;
    }
    this.timer = setTimeout(() => {
      // 淡出而不是直接消失：余光里突然少一块东西比它慢慢淡掉更扰人
      card.classList.add("leaving");
      this.timer = setTimeout(() => this.hide(), 220);
    }, AUTO_HIDE_MS);
  }

  private clearVisibilityWatch(): void {
    if (this.onVisible) document.removeEventListener("visibilitychange", this.onVisible);
    this.onVisible = null;
  }

  hide(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.clearVisibilityWatch();
    this.host?.remove();
    this.host = null;
  }
}
