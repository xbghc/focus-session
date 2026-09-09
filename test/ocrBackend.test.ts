import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/background/handle.ts";
import { setOcrBackend } from "../src/background/ocr.ts";
import { installChromeShim, memoryBackend } from "../src/app/shim.ts";
import type { ShimOptions } from "../src/app/shim.ts";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

const originalChrome = globalThis.chrome;
function setup(over: Partial<ShimOptions> = {}) {
  installChromeShim({
    storage: memoryBackend(), handle: (msg, sender) => handle(msg as Parameters<typeof handle>[0], sender),
    connect: () => undefined, version: "1.0.0", navigate: () => undefined, ...over,
  });
}
beforeEach(() => { setOcrBackend(null); setup(); });
afterEach(() => { setOcrBackend(null); globalThis.chrome = originalChrome; });

test("截图使用发送方窗口并返回 data URL，窗口 0 也不走默认重载", async () => {
  const calls: unknown[][] = [];
  chrome.tabs.captureVisibleTab = (async (...args: unknown[]) => {
    calls.push(args);
    return "data:image/png;base64,abc";
  }) as typeof chrome.tabs.captureVisibleTab;
  for (const windowId of [7, 0]) {
    assert.deepEqual(await handle({ type: "page:capture" }, { tab: { windowId } }),
      { ok: true, dataUrl: "data:image/png;base64,abc" });
  }
  assert.deepEqual(calls, [[7, { format: "png" }], [0, { format: "png" }]]);
});

test("没有窗口时只传 options，不传 WINDOW_ID_CURRENT", async () => {
  const calls: unknown[][] = [];
  chrome.tabs.captureVisibleTab = (async (...args: unknown[]) => {
    calls.push(args); return "data:image/png;base64,abc";
  }) as typeof chrome.tabs.captureVisibleTab;
  await handle({ type: "page:capture" }, {});
  await handle({ type: "page:capture" }, { tab: { id: 1 } });
  assert.deepEqual(calls, [[{ format: "png" }], [{ format: "png" }]]);
});

test("截图抛错折成失败应答", async () => {
  chrome.tabs.captureVisibleTab = (async () => { throw new Error("截图失败"); }) as typeof chrome.tabs.captureVisibleTab;
  assert.deepEqual(await handle({ type: "page:capture" }, {}), { ok: false, error: "Error: 截图失败" });
});

test("预热等待注入的后端完成才应答", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let warmed = false;
  setOcrBackend({ recognize: async () => ({ ok: true, text: "" }), warm: async () => { await gate; warmed = true; } });
  let replied = false;
  const reply = handle({ type: "ocr:warm" }, {}).then((value) => { replied = true; return value; });
  await Promise.resolve();
  assert.equal(replied, false);
  release();
  assert.deepEqual(await reply, { ok: true });
  assert.equal(warmed, true);
});

test("识别原样转发 PNG 与后端成功或失败结果", async () => {
  const seen: string[] = [];
  setOcrBackend({
    warm: async () => undefined,
    recognize: async (png) => {
      seen.push(png);
      return png === "abc" ? { ok: true, text: "tacit endorsement" } : { ok: false, error: "图里没认出英文" };
    },
  });
  assert.deepEqual(await handle({ type: "ocr:recognize", png: "abc" }, {}), { ok: true, text: "tacit endorsement" });
  assert.deepEqual(await handle({ type: "ocr:recognize", png: "empty" }, {}), { ok: false, error: "图里没认出英文" });
  assert.deepEqual(seen, ["abc", "empty"]);
});

test("没有注入时识别给固定错误，预热仍可安全调用", async () => {
  assert.deepEqual(await handle({ type: "ocr:warm" }, {}), { ok: true });
  assert.deepEqual(await handle({ type: "ocr:recognize", png: "abc" }, {}), { ok: false, error: "这个宿主不支持截图翻译" });
});

test("垫片两个截图重载都接到 capture，消息发送方包含窗口", async () => {
  let count = 0;
  setup({ capture: async () => { count++; return "data:image/png;base64,host"; } });
  assert.equal(await chrome.tabs.captureVisibleTab({ format: "png" }), "data:image/png;base64,host");
  assert.equal(await chrome.tabs.captureVisibleTab(1, { format: "png" }), "data:image/png;base64,host");
  assert.deepEqual(await chrome.runtime.sendMessage({ type: "page:capture" }), { ok: true, dataUrl: "data:image/png;base64,host" });
  assert.equal(count, 3);
  setup({ handle: async (_msg, sender) => sender });
  assert.deepEqual(await chrome.runtime.sendMessage({ type: "page:capture" }), { tab: { id: 1, windowId: 1 } });
});

test("垫片未提供截图能力时 reject，宿主自身的错误也不吞掉", async () => {
  await assert.rejects(chrome.tabs.captureVisibleTab({ format: "png" }), /宿主不支持截图/);
  setup({ capture: async () => { throw new Error("宿主截图失败"); } });
  await assert.rejects(chrome.tabs.captureVisibleTab(1, { format: "png" }), /宿主截图失败/);
});

// 跑真实入口，只替换 wasm 引擎；不用浏览器也能盯住总线抢答与初始化失败悬挂。
const offscreenCode = build({
  entryPoints: ["src/ocr/index.ts"], bundle: true, write: false, format: "iife", platform: "browser",
  plugins: [{
    name: "ocr-test-worker",
    setup(builder) {
      builder.onResolve({ filter: /^tesseract\.js$/ }, () => ({ path: "tesseract.js", namespace: "ocr-test" }));
      builder.onLoad({ filter: /.*/, namespace: "ocr-test" }, () => ({
        contents: "export const createWorker = globalThis.makeWorker; export const OEM = { LSTM_ONLY: 1 }; export const PSM = { SINGLE_BLOCK: '6' };",
      }));
    },
  }],
}).then((result) => result.outputFiles[0]!.text);

async function offscreenListener(makeWorker: (...args: any[]) => Promise<unknown>) {
  let listener!: (msg: unknown, sender: unknown, reply: (value: any) => void) => boolean;
  runInNewContext(await offscreenCode, {
    makeWorker,
    chrome: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } } },
  });
  return listener;
}

test("offscreen 忽略无关消息，预热等就绪，识别清洗行信息并传回空图与异常", async () => {
  const listener = await offscreenListener(async (_lang, _oem, options) => {
    assert.equal(options.workerBlobURL, false);
    assert.equal(options.corePath, "chrome-extension://test/tesseract/");
    return {
      setParameters: async () => undefined,
      recognize: async (image: string, _options: unknown, output: { blocks: boolean }) => {
        assert.equal(output.blocks, true);
        if (image.endsWith("bad")) throw new Error("识别失败");
        return { data: { blocks: [{ paragraphs: [{ lines: image.endsWith("empty") ? [] : [
          { text: "inten-", confidence: 90 }, { text: "sity", confidence: 90 },
          { text: "noise", confidence: 10 },
        ] }] }] } };
      },
    };
  });
  for (const msg of [{ type: "page:capture" }, { type: "ocr:recognize" }, { target: "offscreen", type: "unknown" }]) {
    assert.equal(listener(msg, {}, () => assert.fail("无关消息不能应答")), false);
  }
  const send = (type: string, png?: string) => new Promise<any>((resolve) => {
    assert.equal(listener({ target: "offscreen", type, png }, {}, resolve), true);
  });
  assert.equal((await send("ocr:warm")).ok, true);
  assert.equal((await send("ocr:recognize", "abc")).text, "intensity");
  assert.equal((await send("ocr:recognize", "empty")).error, "图里没认出英文");
  assert.equal((await send("ocr:recognize", "bad")).error, "Error: 识别失败");
});

test("语言加载只触发 errorHandler 时也回失败，不能永远卡在预热", { timeout: 3000 }, async () => {
  const listener = await offscreenListener((_lang, _oem, options) => {
    queueMicrotask(() => options.errorHandler("训练数据损坏"));
    return new Promise(() => undefined);
  });
  for (const type of ["ocr:warm", "ocr:recognize"]) {
    const reply = await new Promise<any>((resolve) => listener({ target: "offscreen", type, png: "abc" }, {}, resolve));
    assert.equal(reply.ok, false);
    assert.equal(reply.error, "训练数据损坏");
  }
});
