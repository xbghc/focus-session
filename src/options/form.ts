import "./sync.ts";
import type { ExportBundle, ImportOutcome, LlmConfig, LlmLogBundle, LlmUsage, Settings } from "../types.ts";
import { DEFAULT_LLM, DEFAULT_SETTINGS, MAX_AUTO_WORDS } from "../types.ts";
import { saveTextFile } from "../lib/download.ts";
import { SOURCE_LABEL, appLogLine, timingLine } from "../lib/llmStats.ts";

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
  translationExcluded: $<HTMLTextAreaElement>("translationExcluded"),
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
  fields.excluded.value = s.articleExcludedUrls.join("\n");
  fields.translationExcluded.value = s.translationExcludedUrls.join("\n");
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
    excludedDomains: [],
    translationExcludedUrls: fields.translationExcluded.value.split("\n").map(line => line.trim()).filter(Boolean),
    articleExcludedUrls: fields.excluded.value
      .split("\n")
      .map((line) => line.trim())
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

/*
 * 「保存」管的是 fields 里那一批；同步和模型各有各的按钮，不归它。
 * baseline 是上次读到或存下的值，经 collect() 走一遍再记——和表单比的时候两边是同一种夹法，
 * 不会因为毫秒和秒来回取整就平白显示「有修改」。
 */
const saveBar = $("savebar");
const revertBtn = $<HTMLButtonElement>("revert");
let baseline: Settings | null = null;
let flashing: { msg: string; error: boolean } | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function changedCount(): number {
  if (!baseline) return 0;
  const now = collect();
  const base = baseline;
  return (Object.keys(now) as (keyof Settings)[]).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(base[k])).length;
}

/** App 的设置页要在离开前问一声（见 app/options.ts）：WebView 不弹 beforeunload 的框。 */
export const hasUnsavedChanges = (): boolean => changedCount() > 0;

/** 状态栏一处两用：刚发生的事（存好了、填错了）优先，没有就报还有几项没保存。 */
function renderStatus(): void {
  const changed = changedCount();
  saveBar.classList.toggle("is-dirty", changed > 0);
  revertBtn.hidden = changed === 0;
  status.classList.toggle("error", flashing?.error ?? false);
  status.textContent = flashing ? flashing.msg : changed > 0 ? `${changed} 项修改尚未保存` : "";
}

function flash(msg: string, error = false): void {
  flashing = { msg, error };
  if (statusTimer !== null) clearTimeout(statusTimer);
  // 报错多留一会儿：它往往要人滚回去改
  statusTimer = setTimeout(() => {
    flashing = null;
    renderStatus();
  }, error ? 6000 : 2500);
  renderStatus();
}

/** stall 和 idle 是一对，错也是一对的错：两个框一起标红，气泡挂在要改大的那个上。 */
function markThresholds(error: string): void {
  fields.stall.setCustomValidity(error);
  for (const input of [fields.idle, fields.stall]) {
    if (error) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }
}

function load(s: Settings): void {
  fill(s);
  baseline = collect();
  renderStatus();
}

for (const input of Object.values(fields)) {
  input.addEventListener("input", () => {
    markThresholds("");
    renderStatus();
  });
}

// 标签页一关，没保存的修改就没了，而且没有任何动静——问一声
window.addEventListener("beforeunload", (e) => {
  if (changedCount() === 0) return;
  e.preventDefault();
  // Chrome 119 之前只认 returnValue
  e.returnValue = true;
});

$("save").addEventListener("click", async () => {
  const next = collect();
  if (next.stallTimeoutMs <= next.idleTimeoutMs) {
    const msg = "stallTimeout 需要大于 idleTimeout，否则永远轮不到发呆判定";
    // 保存条可能离这两个框一千多像素：把错报在框上，浏览器会自己滚过去
    markThresholds(msg);
    fields.stall.reportValidity();
    flash(msg, true);
    return;
  }
  await chrome.runtime.sendMessage({ type: "settings:set", settings: next });
  load(next);
  flash("已保存，对已打开的页面立即生效");
});

revertBtn.addEventListener("click", () => {
  if (!baseline) return;
  markThresholds("");
  load(baseline);
  flash("已撤销，回到上次保存的值");
});

$("reset").addEventListener("click", () => {
  // 黑名单是用户自己攒的数据，不是「参数」：恢复默认只动开关和阈值，不把两份名单清空
  const kept = collect();
  fill({
    ...DEFAULT_SETTINGS,
    articleExcludedUrls: kept.articleExcludedUrls,
    translationExcludedUrls: kept.translationExcludedUrls,
  });
  markThresholds("");
  flash(changedCount() > 0 ? "已填回默认值（黑名单不动），点保存才生效" : "已经是默认值了");
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
  if (!confirm("清除此设备的阅读记录和离线文章，并断开同步？服务器和其他设备的数据不受影响，设置与模型密钥保留。清理前请导出需要保留的数据。")) return;
  await chrome.runtime.sendMessage({ type: "data:clear" });
  dataStatus.textContent = "已清空";
});

void chrome.runtime.sendMessage({ type: "settings:get" }).then((s: Settings) => load(s ?? DEFAULT_SETTINGS));

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
const logTiming = $("log-timing");
const logApp = $("log-app");

/** 提示里报的条数。五份都要数：只报失败的话，用户不知道翻译轨迹（带选中的文本）和抓取记录也一起带出去了。 */
const counts = (b: LlmLogBundle): string =>
  `${b.failures.length} 条失败 + ${b.timings.length} 条耗时 + ${b.translations.length} 条翻译轨迹 + ${b.fetches.length} 条抓取 + ${b.errors.length} 条错误`;
/** App 的设置页也要用它（分享日志），所以导出。 */
export async function fetchLog(): Promise<LlmLogBundle> {
  return (await chrome.runtime.sendMessage({ type: "llm:log" })) as LlmLogBundle;
}

async function loadLog(): Promise<void> {
  const bundle = await fetchLog();
  const last = bundle.failures.at(-1);
  logSummary.textContent = last
    ? `${bundle.failures.length} 条失败记录，最近一次 ${new Date(last.ts).toLocaleString()}，${SOURCE_LABEL[last.source]}：${last.message.slice(0, 120)}`
    : "还没有失败记录。";
  logTiming.textContent = timingLine(bundle.timings);
  logApp.textContent = appLogLine(bundle.fetches, bundle.errors);
}

$("log-copy").addEventListener("click", async () => {
  const bundle = await fetchLog();
  // 点击是用户手势，剪贴板写入不需要额外权限
  try {
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    logStatus.textContent = `已复制 ${counts(bundle)} 到剪贴板`;
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
  logStatus.textContent = `已下载 ${counts(bundle)}${note ? "，" + note : ""}`;
});

$("log-clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "llm:log-clear" });
  logStatus.textContent = "已清空";
  await loadLog();
});

void loadLog();
