/**
 * 极小的 DOM 构建助手。
 * 文章标题来自任意网页，绝不能走 innerHTML —— 扩展页面拥有 chrome API 权限，
 * 把页面可控的内容当 HTML 插入就是一个真实的注入面。这里一律用 textContent。
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export function empty(text: string): HTMLElement {
  return el("p", { class: "empty" }, [text]);
}
