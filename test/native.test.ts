import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { captureVisible, recognizeNative, installNative } from "../src/app/native.ts";
import { cleanOcrLines } from "../src/lib/ocrText.ts";

const g = globalThis as Record<string, unknown>;
const savedWindow = g["window"];
beforeEach(() => { g["window"] = {}; installNative(); });
afterEach(() => { if (savedWindow === undefined) delete g["window"]; else g["window"] = savedWindow; });

test("截图回调按 id 匹配，乱序、重复和未知回调不串线", async () => {
  const ids: string[] = [];
  window.Native = { captureStart(id) { assert.equal(this, window.Native); ids.push(id); } };
  const first = captureVisible(), second = captureVisible();
  window.__fsCapture!.done("unknown", "无关");
  window.__fsCapture!.done(ids[1]!, "第二帧");
  window.__fsCapture!.error(ids[1]!, "迟到错误");
  window.__fsCapture!.done(ids[0]!, "第一帧");
  assert.deepEqual(await Promise.all([first, second]), ["第一帧", "第二帧"]);
});

test("识别传 PNG，解析段界，并把 ML Kit 置信度换算给共用清洗器", async () => {
  window.Native = { ocrStart(id, png) {
    assert.equal(this, window.Native); assert.equal(png, "cG5n");
    window.__fsOcr!.done(id, JSON.stringify([
      { text: "First", confidence: 0.95 }, { text: "noise", confidence: 0.2 }, { text: "" }, { text: "Second" },
    ]));
  } };
  const lines = await recognizeNative("cG5n");
  assert.deepEqual(lines, [{ text: "First", confidence: 95 }, { text: "noise", confidence: 20 }, { text: "" }, { text: "Second" }]);
  assert.equal(cleanOcrLines(lines), "First\nSecond");
});

test("缺宿主或老宿主缺方法时拒绝截图和识别", async () => {
  for (const bridge of [undefined, {}]) {
    window.Native = bridge;
    await assert.rejects(captureVisible(), /这个版本的宿主不支持截图翻译/);
    await assert.rejects(recognizeNative("png"), /这个版本的宿主不支持截图翻译/);
  }
});

test("宿主失败回调和同步抛错都拒绝，之后仍能重试", async () => {
  window.Native = {
    captureStart(id) { window.__fsCapture!.error(id, "截图失败"); },
    ocrStart(id) { window.__fsOcr!.error(id, "识别失败"); },
  };
  await assert.rejects(captureVisible(), /截图失败/);
  await assert.rejects(recognizeNative("png"), /识别失败/);
  window.Native = {
    captureStart() { throw new Error("截图同步失败"); },
    ocrStart() { throw new Error("识别同步失败"); },
  };
  await assert.rejects(captureVisible(), /截图同步失败/);
  await assert.rejects(recognizeNative("png"), /识别同步失败/);
  window.Native = {
    captureStart(id) { window.__fsCapture!.done(id, "新截图"); },
    ocrStart(id) { window.__fsOcr!.done(id, "[]"); },
  };
  assert.equal(await captureVisible(), "新截图");
  assert.deepEqual(await recognizeNative("png"), []);
});

test("识别坏 JSON 或错误行结构都拒绝", async () => {
  for (const json of ["{", "null", "{}", '[null]', '[{"text":3}]', '[{"text":"hello","confidence":"高"}]']) {
    window.Native = { ocrStart(id) { window.__fsOcr!.done(id, json); } };
    await assert.rejects(recognizeNative("png"));
  }
});
