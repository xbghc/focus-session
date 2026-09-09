interface Size { width: number; height: number }

/** 截图可能包含滚动条，也未必按 dpr 输出；横纵比例必须分别从实际尺寸求。 */
export function sourceRect(sel: Size & { x: number; y: number }, viewport: Size, bitmap: Size) {
  if (![sel.x, sel.y, sel.width, sel.height, viewport.width, viewport.height, bitmap.width, bitmap.height].every(Number.isFinite)
    || sel.width <= 0 || sel.height <= 0 || viewport.width <= 0 || viewport.height <= 0
    || bitmap.width <= 0 || bitmap.height <= 0) return null;
  const xScale = bitmap.width / viewport.width;
  const yScale = bitmap.height / viewport.height;
  const clampX = (x: number) => Math.max(0, Math.min(Math.floor(bitmap.width), x));
  const clampY = (y: number) => Math.max(0, Math.min(Math.floor(bitmap.height), y));
  // 向外取整保住边缘笔画；夹住两个端点，避免越界选区把宽高算大。
  const sx = clampX(Math.floor(sel.x * xScale));
  const sy = clampY(Math.floor(sel.y * yScale));
  const sw = clampX(Math.ceil((sel.x + sel.width) * xScale)) - sx;
  const sh = clampY(Math.ceil((sel.y + sel.height) * yScale)) - sy;
  return sw > 0 && sh > 0 ? { sx, sy, sw, sh } : null;
}

/** 小字补到等效 2x，但大选区不继续膨胀；原图已超限时保留 1x，避免缩掉笔画。 */
export function outputScale(sw: number, sh: number, cssScale: number): number {
  const scale = cssScale > 0 && cssScale < 2 ? Math.ceil(2 / cssScale * 2) / 2 : 1;
  return Math.max(1, Math.min(scale, 3000 / Math.max(sw, sh)));
}

export function meanLuminance(data: Uint8ClampedArray, sampleEvery = 7): number {
  const step = Number.isFinite(sampleEvery) ? Math.max(1, Math.floor(sampleEvery)) : 7;
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 3 < data.length; i += step * 4) {
    sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    count++;
  }
  return count ? sum / count : 0;
}

/** 深底浅字翻成浅底深字，识别器对正文笔画的判断更稳。 */
export function shouldInvert(mean: number): boolean {
  return mean < 128;
}

export function invertInPlace(data: Uint8ClampedArray): void {
  for (let i = 0; i + 3 < data.length; i += 4) {
    data[i] = 255 - data[i]!;
    data[i + 1] = 255 - data[i + 1]!;
    data[i + 2] = 255 - data[i + 2]!;
  }
}
