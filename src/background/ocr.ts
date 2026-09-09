import type { OcrReply } from "../types.ts";

/**
 * 扩展与 App 的识别器不同，不能从共用后台直接 import 某一宿主的实现。
 * 和垫片注入 handle/connect 一样，handle.ts 只认宿主能提供的能力。
 */
export interface OcrBackend {
  recognize(png: string): Promise<OcrReply>;
  warm(): Promise<void>;
}

let backend: OcrBackend | null = null;

export function setOcrBackend(b: OcrBackend | null): void { backend = b; }

export async function recognize(png: string): Promise<OcrReply> {
  return backend ? await backend.recognize(png) : { ok: false, error: "这个宿主不支持截图翻译" };
}

export async function warm(): Promise<void> { await backend?.warm(); }
