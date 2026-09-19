/**
 * 给人看的失败原因。
 *
 * `String(err)` 会把「Error: 」前缀带到界面上，抛出来的若是个普通对象还会变成 `[object Object]`。
 * 划词浮层、首页、阅读器里的报错都从这儿过，一处说人话。
 */
export function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "未知错误";
}
