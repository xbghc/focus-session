/**
 * 分区标题旁的「i」：点一下弹出这个分区「是什么」的说明，再点、点别处或按 Esc 收起。
 *
 * 按钮和说明都写在 options.html 里，靠 `aria-controls` 对上，这里只管开合——哪个分区想要，
 * 在 legend 里放一个 `button.info` 再跟一块 `.info-pop` 就行，不用改这个文件。
 * 不用浏览器自带的 popover：那个浮在顶层、默认摆在页面正中，要它贴着标题还得另算位置。
 */
export function setupInfoButtons(): void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button.info[aria-controls]")];
  const panelOf = (button: HTMLButtonElement): HTMLElement | null => document.getElementById(button.getAttribute("aria-controls") ?? "");
  const set = (button: HTMLButtonElement, open: boolean): void => {
    const panel = panelOf(button);
    if (!panel) return;
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  const closeAll = (except?: HTMLButtonElement): void => {
    for (const button of buttons) if (button !== except) set(button, false);
  };

  for (const button of buttons) {
    button.addEventListener("click", () => {
      closeAll(button);
      set(button, button.getAttribute("aria-expanded") !== "true");
    });
  }
  // 点在说明里面不算「点别处」：里面的字要能选中复制
  document.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (target?.closest("button.info, .info-pop")) return;
    closeAll();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = buttons.find((button) => button.getAttribute("aria-expanded") === "true");
    if (!open) return;
    closeAll();
    open.focus();
  });
}
