/** App 正文的点词 / 双击整句；扩展仍使用原生划词。 */
const DOUBLE_TAP_MS = 150;
const MOVE_PX = 12;
const DOUBLE_TAP_PX = 32;
const BLOCKS = "p, li, blockquote, td, th, dd, dt, h1, h2, h3, h4, h5, h6, figcaption, pre, article, section, div";
const INTERACTIVE = "a, button, input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=button]";

export type TapKind = "word" | "sentence";

/** 将点中的文字扩展成 DOM Range，保留跨 em / strong 等内联节点的单词和句子。 */
export function textRangeAtPoint(root: HTMLElement, x: number, y: number, kind: TapKind): Range | null {
  const doc = root.ownerDocument;
  const caretDoc = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = caretDoc.caretPositionFromPoint?.(x, y);
  const caret = position ? null : caretDoc.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? caret?.startContainer;
  const offset = position?.offset ?? caret?.startOffset ?? 0;
  if (!node || node.nodeType !== 3 || !root.contains(node) || node.parentElement?.closest(INTERACTIVE)) return null;

  // caret API 会把段落旁的空白吸附到文字末尾，必须确认实际点中了一个字形。
  let hit = -1;
  for (const index of [offset, offset - 1]) {
    if (index < 0 || index >= (node.textContent?.length ?? 0)) continue;
    if (/\s/.test(node.textContent![index]!)) continue;
    const char = doc.createRange();
    char.setStart(node, index);
    char.setEnd(node, index + 1);
    if (Array.from(char.getClientRects()).some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) {
      hit = index;
      break;
    }
  }
  if (hit < 0) return null;

  const closest = node.parentElement?.closest(BLOCKS);
  const block = closest && root.contains(closest) ? closest : root;
  const walker = doc.createTreeWalker(block, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
  const pieces: Array<{ node: Node; start: number; end: number }> = [];
  let text = "";
  let at = -1;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (current.nodeType === 1) {
      if ((current as Element).matches("br") || (current as Element).matches(BLOCKS)) text += "\n";
      continue;
    }
    // 子块不应和外层文字拼成同一句。
    if (current.parentElement?.closest(BLOCKS) !== block) continue;
    const start = text.length;
    text += current.textContent ?? "";
    pieces.push({ node: current, start, end: text.length });
    if (current === node) at = start + hit;
  }
  if (at < 0) return null;
  let start = -1;
  let end = -1;
  if (kind === "word") {
    for (const match of text.matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)) {
      if (match.index <= at && at < match.index + match[0].length) {
        start = match.index;
        end = start + match[0].length;
        break;
      }
    }
  } else {
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    const nextLine = text.indexOf("\n", at);
    const line = text.slice(lineStart, nextLine < 0 ? text.length : nextLine);
    for (const segment of new Intl.Segmenter("en", { granularity: "sentence" }).segment(line)) {
      if (lineStart + segment.index <= at && at < lineStart + segment.index + segment.segment.length) {
        start = lineStart + segment.index;
        end = start + segment.segment.length;
        break;
      }
    }
  }
  if (start < 0) return null;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  const first = pieces.find(p => p.start <= start && start < p.end);
  const last = pieces.find(p => p.start < end && end <= p.end);
  if (!first || !last) return null;
  const range = doc.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

export function bindTapTranslation(root: HTMLElement, translate: (range: Range, kind: TapKind) => void) {
  let down: { id: number; x: number; y: number; time: number } | null = null;
  let pending: { x: number; y: number; time: number; range: Range; timer: ReturnType<typeof setTimeout> } | null = null;
  const cancel = (): void => {
    down = null;
    if (pending) clearTimeout(pending.timer);
    pending = null;
  };
  const onDown = (e: PointerEvent): void => {
    if (!e.isPrimary || e.button !== 0 || (e.target as Element).closest(INTERACTIVE)) { cancel(); return; }
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, time: Date.now() };
    // 第二次已落指时暂缓单击，避免在这次抬指前发出单词请求。
    if (pending && down.time - pending.time <= DOUBLE_TAP_MS &&
        Math.hypot(e.clientX - pending.x, e.clientY - pending.y) <= DOUBLE_TAP_PX) clearTimeout(pending.timer);
  };
  const onMove = (e: PointerEvent): void => {
    if (down && e.pointerId === down.id && Math.hypot(e.clientX - down.x, e.clientY - down.y) > MOVE_PX) cancel();
  };
  const onUp = (e: PointerEvent): void => {
    const gesture = down;
    down = null;
    if (!gesture || gesture.id !== e.pointerId) return;
    if (Date.now() - gesture.time > 500 || Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > MOVE_PX) { cancel(); return; }
    const range = textRangeAtPoint(root, e.clientX, e.clientY, "word");
    if (!range) { cancel(); return; }
    const previous = pending;
    cancel();
    if (previous && gesture.time - previous.time <= DOUBLE_TAP_MS &&
        Math.hypot(e.clientX - previous.x, e.clientY - previous.y) <= DOUBLE_TAP_PX) {
      const sentence = textRangeAtPoint(root, e.clientX, e.clientY, "sentence");
      if (sentence) translate(sentence, "sentence");
      return;
    }
    pending = { x: e.clientX, y: e.clientY, time: Date.now(), range,
      timer: setTimeout(() => {
        pending = null;
        if (root.isConnected && root.contains(range.startContainer)) translate(range, "word");
      }, DOUBLE_TAP_MS),
    };
  };
  const onDoubleClick = (e: MouseEvent): void => {
    if (!(e.target as Element).closest(INTERACTIVE)) e.preventDefault();
  };
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointermove", onMove, { passive: true });
  root.addEventListener("pointerup", onUp);
  root.addEventListener("pointercancel", cancel);
  root.addEventListener("dblclick", onDoubleClick);
  return {
    cancel,
    stop: () => {
      cancel();
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", cancel);
      root.removeEventListener("dblclick", onDoubleClick);
    },
  };
}
