import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { selectRegion, cancelRegion } from "../src/content/screenshot.ts";
import type { CropFn } from "../src/content/screenshot.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
Object.assign(g, { window: dom.window, document: dom.window.document, DOMRect: dom.window.DOMRect });
const attach = dom.window.Element.prototype.attachShadow;
dom.window.Element.prototype.attachShadow = function(init) { return attach.call(this, { ...init, mode: "open" }); };
let closed = 0;
const frame = { width: 2048, height: 1536, close: () => { closed++; } } as ImageBitmap;
g["createImageBitmap"] = async () => frame;
dom.window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => {} })) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
let captures: number[] = [];
dom.window.Element.prototype.setPointerCapture = (id) => { captures.push(id); };
const active = new Set<EventListenerOrEventListenerObject>();
for (const target of [dom.window, dom.window.document]) {
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
    if (opts?.capture) active.add(fn);
    add(type, fn, opts);
  }) as typeof target.addEventListener;
  target.removeEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
    if (opts?.capture) active.delete(fn);
    remove(type, fn, opts);
  }) as typeof target.removeEventListener;
}
const tick = () => new Promise<void>((r) => setImmediate(r));
const host = () => document.getElementById("focus-session-screenshot");
const pointer = (type: string, x: number, y: number, id = 1) => {
  const e = new dom.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
  Object.defineProperty(e, "pointerId", { value: id });
  host()!.dispatchEvent(e);
};
let calls: Parameters<CropFn>[] = [];
const crop: CropFn = async (...args) => { calls.push(args); return "cG5n"; };
const begin = () => selectRegion("data:image/png;base64,AA==", { crop });
beforeEach(() => { calls = []; captures = []; closed = 0; });
afterEach(() => { cancelRegion(); assert.equal(host(), null); assert.equal(active.size, 0); });

test("反向拖出矩形，裁剪收到原始帧、视口和归一化选区，完成后卸载", async () => {
  const pending = begin(); await tick();
  assert.ok(host()); assert.ok(active.size > 0);
  assert.equal(host()!.shadowRoot!.querySelector("img"), null);
  pointer("pointerdown", 150, 90);
  pointer("pointermove", 20, 10);
  const region = host()!.shadowRoot!.querySelector<HTMLElement>(".region")!;
  assert.equal(region.hidden, false); assert.equal(region.style.width, "130px");
  pointer("pointerup", 20, 10);
  const result = await pending;
  assert.ok(result); assert.equal(result.png, "cG5n");
  assert.deepEqual(result.rect.toJSON(), new DOMRect(20, 10, 130, 80).toJSON());
  assert.equal(calls[0]![0], frame); assert.equal(calls[0]![1], result.rect);
  assert.deepEqual(calls[0]![2], { width: 1024, height: 768 });
  assert.deepEqual(captures, [1]); assert.equal(closed, 1);
});

for (const type of ["Escape", "contextmenu", "pointercancel"]) test(`${type} 取消且不裁剪`, async () => {
  const pending = begin(); await tick();
  document.dispatchEvent(type === "Escape" ? new dom.window.KeyboardEvent("keydown", { key: type, bubbles: true, cancelable: true })
    : new dom.window.Event(type, { bubbles: true, cancelable: true }));
  assert.equal(await pending, null); assert.equal(calls.length, 0);
});

for (const [w, h] of [[7, 20], [20, 7], [0, 0]]) test(`选区 ${w}×${h} 当误触取消`, async () => {
  const pending = begin(); await tick();
  pointer("pointerdown", 10, 10); pointer("pointerup", 10 + w!, 10 + h!);
  assert.equal(await pending, null); assert.equal(calls.length, 0);
});

test("wheel、touchmove 和滚动键被拦住", async () => {
  const pending = begin(); await tick();
  for (const type of ["wheel", "touchmove", "keydown"]) {
    const e = type === "keydown" ? new dom.window.KeyboardEvent(type, { key: "ArrowDown", bubbles: true, cancelable: true })
      : new dom.window.Event(type, { bubbles: true, cancelable: true });
    document.dispatchEvent(e); assert.equal(e.defaultPrevented, true);
  }
  cancelRegion(); assert.equal(await pending, null);
});

test("F5 保留浏览器默认行为，但不传到页面快捷键", async () => {
  const pending = begin(); await tick();
  let reached = false;
  const listener = () => { reached = true; };
  document.addEventListener("keydown", listener);
  try {
    const e = new dom.window.KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    assert.equal(e.defaultPrevented, false);
    assert.equal(reached, false);
  } finally { document.removeEventListener("keydown", listener); cancelRegion(); }
  assert.equal(await pending, null);
});

test("取消返回是否有框选在进行，供宿主返回键判断是否留在本页", async () => {
  assert.equal(cancelRegion(), false);
  const pending = begin(); await tick();
  assert.equal(cancelRegion(), true);
  assert.equal(await pending, null);
  assert.equal(cancelRegion(), false);
});

test("第二次调用取消第一次且只留下一个覆盖层", async () => {
  const first = begin(); await tick();
  const second = begin(); assert.equal(await first, null); await tick();
  assert.equal(document.querySelectorAll("#focus-session-screenshot").length, 1);
  cancelRegion(); assert.equal(await second, null);
});

test("解码尚未完成也能被第二次调用取消", async () => {
  const first = begin(); const second = begin();
  assert.equal(await first, null); await tick();
  cancelRegion(); assert.equal(await second, null); assert.equal(closed, 2);
});

test("裁剪失败仍清理所有监听和位图", async () => {
  const pending = selectRegion("data:image/png;base64,AA==", { crop: async () => { throw new Error("裁剪失败"); } });
  const check = assert.rejects(pending, /裁剪失败/);
  await tick(); pointer("pointerdown", 0, 0); pointer("pointerup", 80, 40);
  await check; assert.equal(closed, 1);
});

test("无效截图拒绝且不留覆盖层", async () => {
  await assert.rejects(selectRegion("bad"), /截图格式无效/);
});

for (const dark of [true, false]) test(`真实裁剪管线：独立横纵比例、放大、${dark ? "反色" : "保留浅底"}与 PNG 编码`, async () => {
  const savedDecode = g["createImageBitmap"];
  const savedCanvas = g["OffscreenCanvas"];
  const events: string[] = [];
  let draw: unknown[] = [];
  let size: number[] = [];
  const pixels = new Uint8ClampedArray(dark ? [10, 20, 30, 255] : [240, 240, 240, 255]);
  let bytes: number[] = [];
  g["createImageBitmap"] = async (blob: Blob) => {
    bytes = [...new Uint8Array(await blob.arrayBuffer())];
    events.push("decode");
    return { width: 1024, height: 384, close: () => { closed++; } };
  };
  class FakeCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; size = [width, height]; }
    getContext() {
      return {
        drawImage: (...args: unknown[]) => { draw = args; events.push("draw"); },
        getImageData: () => { events.push("pixels"); return { data: pixels }; },
        putImageData: () => { events.push("invert"); },
      };
    }
    async convertToBlob(options: { type: string }) {
      assert.equal(options.type, "image/png"); events.push("png");
      return new Blob([new Uint8Array([1, 2, 3])]);
    }
  }
  g["OffscreenCanvas"] = FakeCanvas;
  try {
    const pending = selectRegion("data:image/png;base64,AQID"); await tick();
    pointer("pointerdown", 10, 20); pointer("pointerup", 110, 60);
    const result = await pending;
    assert.equal(result!.png, "AQID"); assert.deepEqual(bytes, [1, 2, 3]);
    assert.deepEqual(size, [200, 40]);
    assert.deepEqual(draw.slice(1), [10, 10, 100, 20, 0, 0, 200, 40]);
    assert.deepEqual(events, dark ? ["decode", "draw", "pixels", "invert", "png"] : ["decode", "draw", "pixels", "png"]);
    assert.deepEqual([...pixels], dark ? [245, 235, 225, 255] : [240, 240, 240, 255]);
  } finally { g["createImageBitmap"] = savedDecode; g["OffscreenCanvas"] = savedCanvas; }
});

test("裁剪途中取消，迟到 PNG 不复活覆盖层", async () => {
  let finish!: (png: string) => void;
  const pending = selectRegion("data:image/png;base64,AA==", { crop: () => new Promise((r) => { finish = r; }) });
  await tick(); pointer("pointerdown", 0, 0); pointer("pointerup", 20, 20); await tick();
  cancelRegion(); assert.equal(await pending, null);
  finish("late"); await tick(); assert.equal(host(), null); assert.equal(closed, 1);
});
