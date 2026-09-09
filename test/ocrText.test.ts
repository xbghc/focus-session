import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanOcrLines } from "../src/lib/ocrText.ts";

test("行末连字符只在下一行以小写开头时拼回单词", () => {
  assert.equal(cleanOcrLines([{ text: "inten-" }, { text: "sity matters" }]), "intensity matters");
  assert.equal(cleanOcrLines([{ text: "Note-" }, { text: "Next" }]), "Note- Next");
});

test("空行分段，连续空行只保留一个换行，段内用空格连接", () => {
  assert.equal(cleanOcrLines(["", "First line", "continues", "", "  ", "Second", ""].map((text) => ({ text }))),
    "First line continues\nSecond");
  assert.equal(cleanOcrLines(["inten-", "", "sity"].map((text) => ({ text }))), "inten-\nsity");
});

test("无字母行与低于 30 的低置信度行丢弃，恰好 30 保留", () => {
  assert.equal(cleanOcrLines([
    { text: "Good" }, { text: "| — • 123" }, { text: "noise", confidence: 29 },
    { text: "enough", confidence: 30 },
  ]), "Good enough");
});

test("全是垃圾或没有输入时返回空串", () => {
  assert.equal(cleanOcrLines([{ text: "| —" }, { text: "abc", confidence: 0 }, { text: "" }]), "");
  assert.equal(cleanOcrLines([]), "");
});

test("压缩连续空白并裁掉两端空白", () => {
  assert.equal(cleanOcrLines([{ text: "  tacit\t  endorsement\n " }, { text: " in  hindsight  " }]),
    "tacit endorsement in hindsight");
});

test("弯引号是原文的一部分，清洗不替换", () => {
  assert.equal(cleanOcrLines([{ text: "“It’s fine,”" }, { text: "she said." }]), "“It’s fine,” she said.");
});
