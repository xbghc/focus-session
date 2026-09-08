/**
 * 网页字节 → 字符串。
 *
 * 扩展用不上这一套：content script 跑在浏览器已经解码好的页面上。App 的阅读器是自己
 * 把 HTML 抓回来的，编码只能自己定——国内不少站点还在用 GBK，按 UTF-8 解出来全是问号。
 *
 * 单独放在 lib 而不是留在 read.ts 里，是为了能测：那个模块一 import 就开始碰 DOM。
 * 顺带把"这次解码顺不顺"的几个信号（编码是谁给的、掉了多少字节、认不认这个编码名）
 * 一并算出来交给诊断日志——编码猜错时看这几个数比看正文快。
 */

import type { CharsetSource } from "../types.ts";

export interface CharsetPick {
  charset: string;
  from: CharsetSource;
}

/** Content-Type 里的 charset。 */
export function charsetOf(contentType: string | null): string | null {
  const m = /charset\s*=\s*"?([\w.-]+)"?/i.exec(contentType ?? "");
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * 页面自己声明的 `<meta charset>`。用 latin1 解前 4KB 再找：
 * 待定的这些编码全都 ASCII 兼容，头部一定读得出来。
 */
export function sniffCharset(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.-]+)/i.exec(head);
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * UTF-8 的 BOM。TextDecoder 自己会把它吃掉，记它是因为
 * "有 BOM 却声明了 GBK"是编码搞错的强信号。
 */
export function hasBom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/** 响应头优先，其次页面自己声明的，都没有就 UTF-8。与浏览器同一个次序。 */
export function pickCharset(contentType: string | null, bytes: Uint8Array): CharsetPick {
  const header = charsetOf(contentType);
  if (header) return { charset: header, from: "header" };
  const meta = sniffCharset(bytes);
  if (meta) return { charset: meta, from: "meta" };
  return { charset: "utf-8", from: "default" };
}

/** 替换字符只数前这么多个：编码要是错了，前 64K 就已经看得出来。 */
export const COUNT_LIMIT = 64 * 1024;

export interface Decoded {
  text: string;
  /** 解不出来的字节会变成 U+FFFD。这个数一大就说明编码挑错了。 */
  replacementChars: number;
  /** TextDecoder 不认这个编码名，退回了 UTF-8。 */
  fellBack: boolean;
}

export function decodeWith(bytes: Uint8Array, charset: string): Decoded {
  let text: string;
  let fellBack = false;
  try {
    text = new TextDecoder(charset).decode(bytes);
  } catch {
    // 认不出的编码名（RangeError）。退回 UTF-8 总比整页打不开强
    text = new TextDecoder("utf-8").decode(bytes);
    fellBack = true;
  }
  let replacementChars = 0;
  const end = Math.min(text.length, COUNT_LIMIT);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 0xfffd) replacementChars++;
  }
  return { text, replacementChars, fellBack };
}
