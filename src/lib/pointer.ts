/** 主指针是不是手指。触屏笔记本接着鼠标时是 false，手机上是 true。 */
export function coarsePointer(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}
