import { fileURLToPath } from "node:url";
import { createWorker, OEM, PSM } from "tesseract.js";
import { cleanOcrLines } from "../src/lib/ocrText.ts";

/*
 * 改过预处理或清洗规则就跑一次：单元测试只能验证规则，真实截图才看得出识别是否退步。
 * 需要读取训练数据并跑 wasm，单独执行，不进 npm test。
 * Node 版支持本地目录的 langPath，内部用 fs 读取 .traineddata.gz；转成绝对文件路径，
 * 避免 Windows 盘符被当成 URL，也不依赖启动时的工作目录。不写语言缓存。
 */
const start = performance.now();
const worker = await createWorker("eng", OEM.LSTM_ONLY, {
  langPath: fileURLToPath(new URL("../vendor/tesseract/", import.meta.url)),
  gzip: true,
  cacheMethod: "none",
});
try {
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  const initialized = performance.now();
  // v7 的行数据在 blocks 内，默认关闭；与扩展使用同一份行文本与置信度。
  const { data } = await worker.recognize(fileURLToPath(new URL("fixtures/ocr-probe.png", import.meta.url)), {}, { blocks: true });
  const text = cleanOcrLines((data.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) =>
    paragraph.lines.map((line) => ({ text: line.text, confidence: line.confidence })))));
  const recognized = performance.now();
  console.log(text);
  console.log(`初始化耗时：${(initialized - start).toFixed(0)} ms`);
  console.log(`识别耗时：${(recognized - initialized).toFixed(0)} ms`);
  if (!text.includes("tacit endorsement")) process.exitCode = 1;
} finally {
  await worker.terminate();
}
