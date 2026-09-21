import { localStorage } from "../sync/storage.ts";
import { updateLocalOnly } from "./store.ts";
import { TRACE_MARKS, traceDurations, type PopupPosition, type TranslationBackendTiming, type TranslationTrace } from "../lib/translationDiagnostics.ts";

export const KEY_TRANSLATION_TRACE = "translationTraces";
export const MAX_TRANSLATION_TRACES = 100;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** 相对毫秒数：有限、不超过 1e12（约 31 年），挡住 Infinity 与离谱值。 */
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e12;
/**
 * 墙钟时间戳单独校验。Date.now() 早在 2001 年就过了 1e12，拿相对毫秒的上限去卡它，
 * 每条真实轨迹都会在这里被丢掉、一条也落不了盘——这个 bug 真出过。
 */
const timestamp = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e14;
const count = (v: unknown): number => finite(v) ? Math.max(0, Math.floor(v)) : 0;
const short = (v: unknown, max: number): string => typeof v === "string" ? v.slice(0, max) : "";
const milliseconds = (v: unknown): number | null => finite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;

function position(v: unknown): PopupPosition | null {
  const p = object(v);
  return [p.x, p.y, p.width, p.height, p.scale].every(finite)
    ? { x: p.x as number, y: p.y as number, width: p.width as number, height: p.height as number, scale: p.scale as number } : null;
}

/** 从内容脚本过来的日志只允许已知字段，不透传上下文、任意对象或密钥。 */
export function sanitizeTranslationTrace(raw: unknown): TranslationTrace | null {
  const r = object(raw);
  if (!r.id || typeof r.id !== "string" || !timestamp(r.ts)) return null;
  if (!["tap", "double-tap", "mouse", "keyboard", "touch-selection", "image"].includes(String(r.source)) ||
    !["success", "error", "cancelled", "render-timeout", "unobserved"].includes(String(r.status)) ||
    !["word", "phrase", "sentence"].includes(String(r.kind))) return null;
  const marks: Record<string, number> = {};
  const input = object(r.marks);
  for (const key of TRACE_MARKS) {
    const n = milliseconds(input[key]);
    if (n !== null) marks[key] = n;
  }
  const popup = object(r.popup);
  const b = object(r.backend);
  let backend: TranslationBackendTiming | null = null;
  if (["hit", "miss", "shared"].includes(String(b.cache))) backend = {
    cache: b.cache as TranslationBackendTiming["cache"], subscriberMs: milliseconds(b.subscriberMs) ?? 0,
    totalMs: milliseconds(b.totalMs) ?? 0, configMs: milliseconds(b.configMs), modelMs: milliseconds(b.modelMs),
    firstTextMs: milliseconds(b.firstTextMs), firstFieldMs: milliseconds(b.firstFieldMs), attempts: count(b.attempts),
    accountingMs: milliseconds(b.accountingMs), diagnosticWriteMs: milliseconds(b.diagnosticWriteMs), snippetWriteMs: milliseconds(b.snippetWriteMs),
  };
  return {
    id: r.id.slice(0, 80), ts: r.ts, source: r.source as TranslationTrace["source"], text: short(r.text, 160), textChars: count(r.textChars),
    kind: r.kind as TranslationTrace["kind"], status: r.status as TranslationTrace["status"], reason: r.reason === null ? null : short(r.reason, 300),
    cached: typeof r.cached === "boolean" ? r.cached : null, marks, durations: traceDurations(marks), backend,
    partials: (Array.isArray(r.partials) ? r.partials : []).slice(0, 100).map(v => {
      const p = object(v);
      return { atMs: milliseconds(p.atMs) ?? 0, renderMs: milliseconds(p.renderMs) ?? 0,
        fields: (Array.isArray(p.fields) ? p.fields : []).filter(f => ["translation", "phonetic", "pos", "contextNote", "usage", "vocab"].includes(f)).slice(0, 6) as string[] };
    }),
    popup: {
      measurement: popup.measurement === "animation-frame" ? "animation-frame" : "unavailable",
      positionCalls: count(popup.positionCalls), positionChanges: count(popup.positionChanges), samples: count(popup.samples),
      initial: position(popup.initial), final: position(popup.final),
      moves: (Array.isArray(popup.moves) ? popup.moves : []).slice(0, 100).flatMap(v => {
        const m = object(v); const from = position(m.from); const to = position(m.to);
        return from && to ? [{ atMs: milliseconds(m.atMs) ?? 0, from, to }] : [];
      }),
      movesTruncated: popup.movesTruncated === true || (Array.isArray(popup.moves) && popup.moves.length > 100),
    },
  };
}

export async function getTranslationTraces(): Promise<TranslationTrace[]> {
  const stored = (await localStorage().get(KEY_TRANSLATION_TRACE))[KEY_TRANSLATION_TRACE];
  return Array.isArray(stored) ? stored as TranslationTrace[] : [];
}

export async function recordTranslationTrace(raw: unknown): Promise<void> {
  try {
    const entry = sanitizeTranslationTrace(raw);
    if (!entry) return;
    // 每次翻译收尾都写一条；走本机专用的直写（store.ts 的 updateLocalOnly），不为一条轨迹重建投影、排一轮同步
    await updateLocalOnly([KEY_TRANSLATION_TRACE], (v) => {
      const stored = v[KEY_TRANSLATION_TRACE];
      const log = (Array.isArray(stored) ? (stored as TranslationTrace[]) : []).filter(t => t.id !== entry.id);
      log.push(entry);
      return { [KEY_TRANSLATION_TRACE]: log.slice(-MAX_TRANSLATION_TRACES) };
    });
  } catch { /* 诊断写失败不能影响翻译 */ }
}
