export interface OcrLine { text: string; confidence?: number }

/** 两个识别器共用清洗口径，免得同一张图在两个宿主里变成不同的翻译选区。 */
export function cleanOcrLines(lines: OcrLine[]): string {
  const paragraphs: string[] = [];
  let paragraph = "";
  for (const line of lines) {
    const text = line.text.replace(/\s+/g, " ").trim();
    // 真正的空行保留段界；框线与低置信度噪声不能凭空制造段落。
    if (!text) {
      if (paragraph) paragraphs.push(paragraph);
      paragraph = "";
      continue;
    }
    if (!/[a-z]/i.test(text) || (line.confidence !== undefined && line.confidence < 30)) continue;
    if (paragraph.endsWith("-") && /^[a-z]/.test(text)) paragraph = paragraph.slice(0, -1) + text;
    else paragraph += (paragraph ? " " : "") + text;
  }
  if (paragraph) paragraphs.push(paragraph);
  return paragraphs.join("\n").trim();
}
