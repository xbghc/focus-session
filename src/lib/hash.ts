/**
 * FNV-1a 32 位散列，取 base36。
 * 用途是给段落文本做指纹以便跨刷新去重，不是安全用途，冲突概率可接受。
 */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
