import type { ExportBundle, ImportOutcome, LlmConfig, LlmFailure, LlmLogBundle, LlmUsage, Settings } from "../types.ts";
import { DEFAULT_LLM, DEFAULT_SETTINGS, MAX_AUTO_WORDS } from "../types.ts";
import { saveTextFile } from "../lib/download.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const fields = {
  idle: $<HTMLInputElement>("idle"),
  stall: $<HTMLInputElement>("stall"),
  maxQuiet: $<HTMLInputElement>("maxQuiet"),
  minSession: $<HTMLInputElement>("minSession"),
  dwell: $<HTMLInputElement>("dwell"),
  readFraction: $<HTMLInputElement>("readFraction"),
  episodeGap: $<HTMLInputElement>("episodeGap"),
  excluded: $<HTMLTextAreaElement>("excluded"),
  translateEnabled: $<HTMLInputElement>("translateEnabled"),
  restorePositionEnabled: $<HTMLInputElement>("restorePositionEnabled"),
  articleReviewEnabled: $<HTMLInputElement>("articleReviewEnabled"),
  minSel: $<HTMLInputElement>("minSel"),
  maxAuto: $<HTMLInputElement>("maxAuto"),
  ctxChars: $<HTMLInputElement>("ctxChars"),
  explainVocab: $<HTMLInputElement>("explainVocab"),
  finishRatio: $<HTMLInputElement>("finishRatio"),
};
const llmFields = {
  apiKey: $<HTMLInputElement>("apiKey"),
  model: $<HTMLInputElement>("model"),
  baseUrl: $<HTMLInputElement>("baseUrl"),
  maxTokens: $<HTMLInputElement>("maxTokens"),
  timeout: $<HTMLInputElement>("timeout"),
};
const status = $("status");
const dataStatus = $("data-status");

function fill(s: Settings): void {
  fields.idle.value = String(Math.round(s.idleTimeoutMs / 1000));
  fields.stall.value = String(Math.round(s.stallTimeoutMs / 1000));
  fields.maxQuiet.value = String(Math.round(s.maxQuietMs / 1000));
  fields.minSession.value = String(Math.round(s.minSessionMs / 1000));
  fields.dwell.value = String(s.paragraphDwellMs);
  fields.readFraction.value = String(Math.round(s.readFraction * 100));
  fields.episodeGap.value = String(Math.round(s.episodeGapMs / 60_000));
  fields.excluded.value = s.excludedDomains.join("\n");
  fields.translateEnabled.checked = s.translateEnabled;
  fields.restorePositionEnabled.checked = s.restorePositionEnabled;
  fields.articleReviewEnabled.checked = s.articleReviewEnabled;
  fields.minSel.value = String(s.minSelectionChars);
  fields.maxAuto.value = String(s.maxAutoSelectionWords);
  fields.ctxChars.value = String(s.contextChars);
  fields.explainVocab.checked = s.explainVocab;
  fields.finishRatio.value = String(Math.round(s.finishRatio * 100));
}

/** 读表单并夹到合法区间；非法输入退回默认值而不是写入 NaN。 */
function collect(): Settings {
  const num = (input: HTMLInputElement, fallback: number, min: number, max: number): number => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  };
  return {
    idleTimeoutMs: num(fields.idle, 30, 5, 600) * 1000,
    stallTimeoutMs: num(fields.stall, 90, 10, 1800) * 1000,
    maxQuietMs: num(fields.maxQuiet, 300, 0, 1800) * 1000,
    minSessionMs: num(fields.minSession, 3, 0, 120) * 1000,
    paragraphDwellMs: num(fields.dwell, 1000, 100, 10_000),
    readFraction: num(fields.readFraction, 50, 10, 100) / 100,
    episodeGapMs: num(fields.episodeGap, 5, 0, 120) * 60_000,
    excludedDomains: fields.excluded.value
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
    translateEnabled: fields.translateEnabled.checked,
    restorePositionEnabled: fields.restorePositionEnabled.checked,
    articleReviewEnabled: fields.articleReviewEnabled.checked,
    minSelectionChars: num(fields.minSel, 2, 1, 20),
    maxAutoSelectionWords: num(fields.maxAuto, DEFAULT_SETTINGS.maxAutoSelectionWords, 3, MAX_AUTO_WORDS),
    contextChars: num(fields.ctxChars, 600, 0, 2000),
    explainVocab: fields.explainVocab.checked,
    finishRatio: num(fields.finishRatio, 80, 10, 100) / 100,
  };
}

let statusTimer: ReturnType<typeof setTimeout> | null = null;
function flash(msg: string): void {
  status.textContent = msg;
  if (statusTimer !== null) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.textContent = ""), 2500);
}

$("save").addEventListener("click", async () => {
  const next = collect();
  if (next.stallTimeoutMs <= next.idleTimeoutMs) {
    flash("stallTimeout 需要大于 idleTimeout，否则永远轮不到发呆判定");
    return;
  }
  await chrome.runtime.sendMessage({ type: "settings:set", settings: next });
  fill(next);
  flash("已保存，对已打开的页面立即生效");
});

$("reset").addEventListener("click", () => {
  fill(DEFAULT_SETTINGS);
  flash("已填回默认值，记得点保存");
});

$("export").addEventListener("click", async () => {
  const bundle = (await chrome.runtime.sendMessage({ type: "data:export" })) as ExportBundle;
  // 用 <a download> 而不是 downloads API，省掉一个权限声明；安卓里由宿主接管，见 lib/download.ts
  const note = saveTextFile(
    `focus-session-${new Date().toISOString().slice(0, 10)}.json`,
    "application/json",
    JSON.stringify(bundle, null, 2),
    $<HTMLAnchorElement>("download"),
  );
  dataStatus.textContent = `已导出 ${bundle.sessions.length} 个 session / ${bundle.articles.length} 篇文章${note ? "，" + note : ""}`;
});

$("import").addEventListener("click", () => $<HTMLInputElement>("import-file").click());
$<HTMLInputElement>("import-file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  dataStatus.textContent = "正在合并…";
  try {
    const raw: unknown = JSON.parse(await file.text());
    const res = (await chrome.runtime.sendMessage({ type: "data:import", bundle: raw })) as ImportOutcome;
    dataStatus.textContent = res.ok ? res.message : `导入失败：${res.error}`;
  } catch (err) {
    dataStatus.textContent = `读取失败：${err instanceof Error ? err.message : String(err)}`;
  }
  // 清掉选择，同一个文件才能再选一次
  input.value = "";
});

$("clear").addEventListener("click", async () => {
  if (!confirm("清空全部阅读记录？设置会保留，此操作不可撤销。")) return;
  await chrome.runtime.sendMessage({ type: "data:clear" });
  dataStatus.textContent = "已清空";
});

void chrome.runtime.sendMessage({ type: "settings:get" }).then((s: Settings) => fill(s ?? DEFAULT_SETTINGS));

/* ==================== MiniMax 配置 ==================== */

const llmStatus = $("llm-status");

function fillLlm(cfg: LlmConfig & { apiKeySet?: boolean }): void {
  // 密钥不回显：后台只回传"设没设过"。留空提交表示保持不变。
  llmFields.apiKey.value = "";
  llmFields.apiKey.placeholder = cfg.apiKeySet ? "已设置，留空则保持不变" : "尚未设置";
  llmFields.model.value = cfg.model;
  llmFields.baseUrl.value = cfg.baseUrl;
  llmFields.maxTokens.value = String(cfg.maxTokens);
  llmFields.timeout.value = String(Math.round(cfg.timeoutMs / 1000));
}

function clamp(input: HTMLInputElement, fallback: number, min: number, max: number): number {
  const v = Number(input.value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

$("save-llm").addEventListener("click", async () => {
  const patch: Partial<LlmConfig> = {
    model: llmFields.model.value.trim() || DEFAULT_LLM.model,
    baseUrl: llmFields.baseUrl.value.trim() || DEFAULT_LLM.baseUrl,
    maxTokens: clamp(llmFields.maxTokens, DEFAULT_LLM.maxTokens, 256, 8192),
    timeoutMs: clamp(llmFields.timeout, DEFAULT_LLM.timeoutMs / 1000, 5, 120) * 1000,
  };
  const key = llmFields.apiKey.value.trim();
  if (key) patch.apiKey = key;

  await chrome.runtime.sendMessage({ type: "llm:set", config: patch });
  llmStatus.textContent = "已保存，正在测试…";
  const res = (await chrome.runtime.sendMessage({ type: "llm:test" })) as {
    ok: boolean;
    error?: string;
    model?: string;
  };
  llmStatus.textContent = res.ok ? `连接正常（${res.model}）` : `连接失败：${res.error ?? "未知错误"}`;
  await loadLlm();
});

async function loadLlm(): Promise<void> {
  const cfg = (await chrome.runtime.sendMessage({ type: "llm:get" })) as LlmConfig & { apiKeySet: boolean };
  fillLlm(cfg ?? { ...DEFAULT_LLM, apiKeySet: false });
  const u = (await chrome.runtime.sendMessage({ type: "llm:usage" })) as LlmUsage;
  $("usage").textContent = u.requests
    ? `累计 ${u.requests} 次请求（失败 ${u.errors} 次），输入 ${u.inputTokens} tokens，输出 ${u.outputTokens} tokens。`
    : "还没有调用过。";
}

void loadLlm();

/* ==================== 诊断日志 ==================== */

const logStatus = $("log-status");
const logSummary = $("log-summary");

const SOURCE_LABEL: Record<LlmFailure["source"], string> = {
  translate: "划词翻译",
  test: "测试连接",
  assist: "复习助手",
  articleReview: "文章回顾",
};

async function fetchLog(): Promise<LlmLogBundle> {
  return (await chrome.runtime.sendMessage({ type: "llm:log" })) as LlmLogBundle;
}

async function loadLog(): Promise<void> {
  const bundle = await fetchLog();
  const last = bundle.failures.at(-1);
  logSummary.textContent = last
    ? `${bundle.failures.length} 条记录，最近一次 ${new Date(last.ts).toLocaleString()}，${SOURCE_LABEL[last.source]}：${last.message.slice(0, 120)}`
    : "还没有失败记录。";
}

$("log-copy").addEventListener("click", async () => {
  const bundle = await fetchLog();
  // 点击是用户手势，剪贴板写入不需要额外权限
  try {
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    logStatus.textContent = `已复制 ${bundle.failures.length} 条记录到剪贴板`;
  } catch {
    logStatus.textContent = "复制失败，改用下载吧";
  }
});

$("log-download").addEventListener("click", async () => {
  const bundle = await fetchLog();
  // 与数据导出同一套：<a download> 而不是 downloads API，省掉一个权限声明
  const note = saveTextFile(
    `focus-session-llm-log-${new Date().toISOString().slice(0, 10)}.json`,
    "application/json",
    JSON.stringify(bundle, null, 2),
    $<HTMLAnchorElement>("log-file"),
  );
  logStatus.textContent = `已下载 ${bundle.failures.length} 条记录${note ? "，" + note : ""}`;
});

$("log-clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "llm:log-clear" });
  logStatus.textContent = "已清空";
  await loadLog();
});

void loadLog();
