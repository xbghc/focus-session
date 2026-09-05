/**
 * 读完文章后贴在右下角的回顾入口。
 *
 * 和翻译浮层同一套纸墨配色，但**另起一个 host**：浮层的 `hide()` 会把自己的
 * 宿主整个 remove 掉，共用的话读完之后随手划一个词，按钮就跟着没了。
 *
 * 也不共用它的字体：那边引 Source Serif 是为了让译文和扩展其余部分一致，
 * 这里只有一行汉字标签，系统无衬线就够，省一次 woff2 请求。
 */

const HOST_ID = "focus-session-finish";

const CSS = `
:host { all: initial; }
.card {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483646; /* 让翻译浮层压在上面：那个是当下的操作，这个只是常驻入口 */
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 10px 14px;
  border-radius: 3px;
  border: 1px solid #e0d8cb;
  border-left: 3px solid #a4551f;
  background: #fffdfa;
  color: #1f1b16;
  box-shadow: 0 1px 2px rgba(31, 27, 22, 0.06), 0 10px 28px rgba(31, 27, 22, 0.14);
  font: 13px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  animation: rise 240ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .card { animation: none; }
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
.close {
  padding: 5px 8px;
  border-color: transparent;
  background: transparent;
  color: #9a8f7f;
  font-size: 15px;
  line-height: 1;
}
.close:hover { color: #4a4238; border-color: transparent; background: transparent; }
@media (prefers-color-scheme: dark) {
  .card { background: #262220; color: #e8e0d5; border-color: #332f2a; border-left-color: #e18d5a; }
  .sub { color: #9a8f7f; }
  button { background: #1c1917; color: #bdb3a4; border-color: #3d3833; }
  button:hover { background: #332f2a; color: #e18d5a; border-color: #e18d5a; }
  .close { background: transparent; border-color: transparent; }
  .close:hover { background: transparent; border-color: transparent; color: #e8e0d5; }
}
`;

export interface FinishCardActions {
  /** 点了「回顾这篇」。 */
  onOpen: () => void;
  /** 点了 ×。本次加载内不再弹。 */
  onDismiss: () => void;
}

export class FinishCard {
  private host: HTMLElement | null = null;
  private actions: FinishCardActions;

  constructor(actions: FinishCardActions) {
    this.actions = actions;
  }

  /** 宿主元素——测试断言用，也用来判断当前是不是已经挂着。 */
  get hostElement(): HTMLElement | null {
    return this.host;
  }

  /** 重复调用是安全的：已经挂着就什么都不做，不会重播入场动画。 */
  show(): void {
    if (this.host) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:static;";
    const root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = CSS;

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="label"><span class="title">这篇读完了</span><span class="sub">已进入回顾队列</span></div>
       <button data-act="go">回顾这篇</button>
       <button class="close" data-act="x" aria-label="关闭">×</button>`;
    card.querySelector('[data-act="go"]')!.addEventListener("click", () => this.actions.onOpen());
    card.querySelector('[data-act="x"]')!.addEventListener("click", () => {
      this.hide();
      this.actions.onDismiss();
    });

    root.append(style, card);
    document.documentElement.appendChild(host);
    this.host = host;
  }

  hide(): void {
    this.host?.remove();
    this.host = null;
  }
}
