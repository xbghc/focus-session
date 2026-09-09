import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceRect, outputScale, meanLuminance, shouldInvert, invertInPlace } from "../src/lib/crop.ts";

test("截图坐标按实际位图缩放，覆盖 1x、2x 与非整数比例", () => {
  const sel = { x: 10, y: 20, width: 30, height: 40 };
  const viewport = { width: 100, height: 100 };
  for (const scale of [1, 2, 1.5]) {
    assert.deepEqual(sourceRect(sel, viewport, { width: 100 * scale, height: 100 * scale }),
      { sx: 10 * scale, sy: 20 * scale, sw: 30 * scale, sh: 40 * scale });
  }
  assert.deepEqual(sourceRect({ x: 1, y: 1, width: 2, height: 2 }, viewport, { width: 125, height: 125 }),
    { sx: 1, sy: 1, sw: 3, sh: 3 });
});

test("滚动条导致横纵比例不同时分别换算", () => {
  assert.deepEqual(sourceRect({ x: 10, y: 20, width: 30, height: 40 },
    { width: 100, height: 100 }, { width: 150, height: 200 }), { sx: 15, sy: 40, sw: 45, sh: 80 });
});

test("选区越过图的四条边时夹住端点", () => {
  const size = { width: 100, height: 80 };
  assert.deepEqual(sourceRect({ x: -10, y: -20, width: 150, height: 120 }, size, size),
    { sx: 0, sy: 0, sw: 100, sh: 80 });
  assert.deepEqual(sourceRect({ x: -10, y: 20, width: 30, height: 100 }, size, size),
    { sx: 0, sy: 20, sw: 20, sh: 60 });
});

test("空选区、完全越界与无效尺寸返回 null", () => {
  const size = { width: 100, height: 100 };
  for (const sel of [
    { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 10, height: -1 },
    { x: 100, y: 0, width: 10, height: 10 }, { x: -20, y: 0, width: 10, height: 10 },
    { x: 0, y: 100, width: 10, height: 10 }, { x: NaN, y: 0, width: 10, height: 10 },
  ]) assert.equal(sourceRect(sel, size, size), null);
  assert.equal(sourceRect({ x: 0, y: 0, ...size }, { width: 0, height: 100 }, size), null);
});

test("1x 小字放到 2x，2x 不放，非整数比例向上取半档", () => {
  assert.equal(outputScale(100, 50, 1), 2);
  assert.equal(outputScale(100, 50, 2), 1);
  assert.equal(outputScale(100, 50, 1.5), 1.5);
});

test("放大后的横向或纵向长边封顶 3000，原图超限也不缩小", () => {
  assert.equal(outputScale(2000, 500, 1), 1.5);
  assert.equal(outputScale(500, 2400, 1), 1.25);
  assert.equal(outputScale(4000, 500, 1), 1);
});

test("亮度用 Rec.601，采样步长按像素而非字节", () => {
  const data = new Uint8ClampedArray([255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 70]);
  assert.ok(Math.abs(meanLuminance(data, 1) - 85) < 1e-10);
  assert.ok(Math.abs(meanLuminance(data, 2) - (255 * (0.299 + 0.114) / 2)) < 1e-10);
  assert.equal(meanLuminance(data), 255 * 0.299);
  assert.equal(meanLuminance(new Uint8ClampedArray()), 0);
});

test("深色阈值不包含 128，反色只改 RGB、保留 alpha", () => {
  assert.equal(shouldInvert(127), true);
  assert.equal(shouldInvert(128), false);
  const data = new Uint8ClampedArray([0, 120, 255, 17, 10, 20, 30, 255]);
  invertInPlace(data);
  assert.deepEqual([...data], [255, 135, 0, 17, 245, 235, 225, 255]);
});
