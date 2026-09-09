import { sourceRect, outputScale, meanLuminance, shouldInvert, invertInPlace } from "../lib/crop.ts";

type Size = { width: number; height: number };
export type CropFn = (frame: ImageBitmap, rect: DOMRect, viewport: Size) => Promise<string>;

/**
 * 取帧和裁剪共用解码后的位图。不能用 img 或 fetch(dataUrl)：宿主页 CSP 能拦住它们，
 * 字节转 Blob 再交给位图解码器才不依赖宿主页允许哪些图片来源。
 */
async function screenshotFrame(dataUrl: string, crop?: CropFn) {
  const base64 = dataUrl.match(/^data:image\/[^;,]+;base64,(.*)$/s)?.[1];
  if (!base64) throw new Error("截图格式无效");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const frame = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  return {
    frame,
    crop: (rect: DOMRect, viewport: Size): Promise<string> => {
      if (crop) return crop(frame, rect, viewport);
      return (async () => {
        const src = sourceRect(rect, viewport, frame);
        if (!src) throw new Error("框选范围无效，请重新框选");
        const { sx, sy, sw, sh } = src;
        const scale = outputScale(sw, sh, frame.width / viewport.width);
        const canvas = new OffscreenCanvas(Math.ceil(sw * scale), Math.ceil(sh * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("无法处理截图");
        ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (shouldInvert(meanLuminance(pixels.data))) {
          invertInPlace(pixels.data);
          ctx.putImageData(pixels, 0, 0);
        }
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const out = new Uint8Array(await blob.arrayBuffer());
        // 分块编码，整张图展开成函数参数会超过引擎的参数数目上限。
        let binary = "";
        for (let i = 0; i < out.length; i += 8192) binary += String.fromCharCode(...out.subarray(i, i + 8192));
        return btoa(binary);
      })();
    },
  };
}

let cancelActive: (() => void) | null = null;
/** 换页或被排除时也得撤掉冻结帧，免得旧文章的选区落到新文章名下。 */
export function cancelRegion(): boolean {
  if (!cancelActive) return false;
  cancelActive();
  return true;
}

export function selectRegion(dataUrl: string, opts?: { crop?: CropFn }): Promise<{ png: string; rect: DOMRect } | null> {
  cancelRegion();
  return new Promise((resolve, reject) => {
    let done = false;
    let frame: ImageBitmap | null = null;
    let host: HTMLElement | null = null;
    const detach: Array<() => void> = [];
    const cleanup = (): void => {
      done = true;
      for (const off of detach) off();
      detach.length = 0;
      host?.remove();
      frame?.close();
      if (cancelActive === cancel) cancelActive = null;
    };
    const cancel = (): void => {
      if (done) return;
      cleanup();
      resolve(null);
    };
    cancelActive = cancel;
    const on = (type: string, fn: EventListener): void => {
      const options = { capture: true, passive: false };
      window.addEventListener(type, fn, options);
      detach.push(() => window.removeEventListener(type, fn, options));
    };
    const swallow = (e: Event): void => { e.preventDefault(); e.stopImmediatePropagation(); };
    void (async () => {
      const decoded = await screenshotFrame(dataUrl, opts?.crop);
      if (done) { decoded.frame.close(); return; }
      frame = decoded.frame;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      host = document.createElement("div");
      host.id = "focus-session-screenshot";
      host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
      const root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
        :host { all: initial; }
        .overlay { position:fixed; inset:0; overflow:hidden; cursor:crosshair; touch-action:none;
          user-select:none; background:#1f1b16; font-family:Georgia,"Songti SC","SimSun",serif; }
        canvas { position:absolute; inset:0; width:100%; height:100%; }
        .shade { position:absolute; inset:0; background:rgba(31,27,22,.55); }
        .region { position:absolute; box-sizing:border-box; border:1px solid #a4551f;
          box-shadow:0 0 0 9999px rgba(31,27,22,.55); }
        .hint { position:absolute; top:18px; left:50%; transform:translateX(-50%); max-width:calc(100% - 32px);
          width:max-content; box-sizing:border-box; padding:9px 14px; border:1px solid #e0d8cb; border-top:3px solid #a4551f;
          border-radius:3px; background:#fffdfa; color:#1f1b16; pointer-events:none;
          font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
      `;
      const overlay = document.createElement("div");
      overlay.className = "overlay";
      const canvas = document.createElement("canvas");
      canvas.width = frame.width; canvas.height = frame.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("无法显示截图");
      ctx.drawImage(frame, 0, 0);
      const shade = document.createElement("div"); shade.className = "shade";
      const region = document.createElement("div"); region.className = "region"; region.hidden = true;
      const hint = document.createElement("div"); hint.className = "hint";
      hint.textContent = "拖动框选要翻译的文字，Esc 取消";
      overlay.append(canvas, shade, region, hint);
      root.append(style, overlay);
      document.documentElement.append(host);
      let start: { x: number; y: number; id: number } | null = null;
      let cropping = false;
      const point = (e: PointerEvent) => ({ x: Math.max(0, Math.min(viewport.width, e.clientX)),
        y: Math.max(0, Math.min(viewport.height, e.clientY)) });
      const rectangle = (e: PointerEvent): DOMRect => {
        const p = point(e);
        return new DOMRect(Math.min(start!.x, p.x), Math.min(start!.y, p.y), Math.abs(p.x - start!.x), Math.abs(p.y - start!.y));
      };
      on("pointerdown", (ev) => {
        swallow(ev);
        const e = ev as PointerEvent;
        if (cropping || start || e.button !== 0) return;
        start = { ...point(e), id: e.pointerId };
        overlay.setPointerCapture(e.pointerId);
      });
      on("pointermove", (ev) => {
        swallow(ev);
        const e = ev as PointerEvent;
        if (!start || cropping || e.pointerId !== start.id) return;
        const r = rectangle(e);
        shade.hidden = true; region.hidden = false;
        region.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;`;
      });
      on("pointerup", (ev) => {
        swallow(ev);
        const e = ev as PointerEvent;
        if (!start || cropping || e.pointerId !== start.id) return;
        const rect = rectangle(e);
        if (rect.width < 8 || rect.height < 8) { cancel(); return; }
        cropping = true;
        void Promise.resolve().then(() => done ? null : decoded.crop(rect, viewport)).then((png) => {
          if (done || png === null) return;
          cleanup(); resolve({ png, rect });
        }, (err: unknown) => { if (!done) { cleanup(); reject(err); } });
      });
      on("pointercancel", (ev) => { swallow(ev); cancel(); });
      on("contextmenu", (ev) => { swallow(ev); cancel(); });
      on("keydown", (ev) => {
        ev.stopImmediatePropagation();
        const key = (ev as KeyboardEvent).key;
        if ([" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Escape"].includes(key)) ev.preventDefault();
        if (key === "Escape") cancel();
      });
      // 连兼容鼠标事件和 keyup 一起隔离，免得框选结束顺手触发旧的划词选区。
      for (const type of ["wheel", "touchmove", "mousedown", "mouseup", "click", "keyup", "selectionchange"]) on(type, swallow);
      on("resize", cancel);
      on("pagehide", cancel);
    })().catch((err: unknown) => { if (!done) { cleanup(); reject(err); } });
  });
}
