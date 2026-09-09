import { createWorker, OEM, PSM } from "tesseract.js";
import { cleanOcrLines } from "../lib/ocrText.ts";
import type { OcrReply } from "../types.ts";

// 文档一出现就预热；保留 worker，避免每次框选都重读训练数据、重编译 wasm。
// v7 加载语言失败时不一定拒绝 createWorker 的 promise，需把 errorHandler 也接到就绪结果。
let rejectInitialization!: (error: unknown) => void;
const initializationError = new Promise<never>((_resolve, reject) => { rejectInitialization = reject; });
const ready = Promise.race([createWorker("eng", OEM.LSTM_ONLY, {
  workerPath: chrome.runtime.getURL("tesseract/worker.min.js"),
  corePath: chrome.runtime.getURL("tesseract/"),
  langPath: chrome.runtime.getURL("tesseract/"),
  gzip: true,
  cacheMethod: "none",
  workerBlobURL: false,
  // 库默认会另抛未捕获异常；错误由消息应答统一交给调用方。
  errorHandler: rejectInitialization,
}).then(async (worker) => {
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  return worker;
}), initializationError]);
// 初始化可能在第一条消息到来前失败；保留拒绝结果给后续消息，但不制造未处理拒绝。
void ready.catch(() => undefined);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 与 service worker 共用总线；无关消息不能应答，否则会抢走真正处理方的结果。
  if (msg?.target !== "offscreen" || (msg.type !== "ocr:recognize" && msg.type !== "ocr:warm")) return false;
  void (async (): Promise<OcrReply | { ok: true }> => {
    try {
      const worker = await ready;
      if (msg.type === "ocr:warm") return { ok: true };
      // v7 默认只给纯文本；行置信度要显式开启 blocks，从段落里的 lines 取。
      const { data } = await worker.recognize("data:image/png;base64," + msg.png, {}, { blocks: true });
      const lines = (data.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) =>
        paragraph.lines.map((line) => ({ text: line.text, confidence: line.confidence }))));
      const text = cleanOcrLines(lines);
      return text ? { ok: true, text } : { ok: false, error: "图里没认出英文" };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  })().then(sendResponse);
  return true;
});
