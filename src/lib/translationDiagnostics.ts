import type { SnippetKind } from "../types.ts";

/** 后台各阶段使用后台自己的单调时钟，不能与页面 performance.now() 相减。 */
export interface TranslationBackendTiming {
  cache: "hit" | "miss" | "shared";
  subscriberMs: number;
  totalMs: number;
  configMs: number | null;
  modelMs: number | null;
  firstTextMs: number | null;
  firstFieldMs: number | null;
  attempts: number;
  accountingMs: number | null;
  diagnosticWriteMs: number | null;
  snippetWriteMs: number | null;
}

export interface TranslationInputTiming {
  source: "mouse" | "keyboard" | "touch-selection" | "tap" | "double-tap" | "image";
  started: number;
  committed: number;
  resolved?: number;
  debounceEnded?: number;
}

export interface PopupPosition {
  /** 可视视口中的 CSS 像素，不是设备物理像素。 */
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface TranslationTrace {
  id: string;
  ts: number;
  source: TranslationInputTiming["source"];
  text: string;
  textChars: number;
  kind: SnippetKind;
  status: "success" | "error" | "cancelled" | "render-timeout" | "unobserved";
  reason: string | null;
  cached: boolean | null;
  /** 相对本次用户操作起点的毫秒偏移；没发生的阶段不存在。 */
  marks: Record<string, number>;
  /** 阶段耗时；缺少端点时不填，不能把未完成阶段伪装成 0ms。 */
  durations: Record<string, number>;
  partials: Array<{ atMs: number; fields: string[]; renderMs: number }>;
  backend: TranslationBackendTiming | null;
  popup: {
    measurement: "animation-frame" | "unavailable";
    positionCalls: number;
    positionChanges: number;
    samples: number;
    initial: PopupPosition | null;
    final: PopupPosition | null;
    moves: Array<{ atMs: number; from: PopupPosition; to: PopupPosition }>;
    movesTruncated: boolean;
  };
}

export const TRACE_MARKS = ["inputStart", "selectionEnd", "selectionResolved", "debounceEnd", "prepared", "confirmShown",
  "requestStart", "firstPartial", "firstTranslationDom", "firstTranslationVisible", "responseReceived", "finalDom",
  "popupShown", "typingDone", "renderComplete", "ended", "ocrStart", "ocrEnd"] as const;

export const TRACE_SPANS: Record<string, [string, string]> = {
  interactionMs: ["inputStart", "selectionEnd"],
  selectionResolutionMs: ["selectionEnd", "selectionResolved"],
  ocrMs: ["ocrStart", "ocrEnd"],
  debounceMs: ["selectionEnd", "debounceEnd"],
  preparationMs: ["debounceEnd", "prepared"],
  confirmationWaitMs: ["confirmShown", "requestStart"],
  requestMs: ["requestStart", "responseReceived"],
  firstPartialWaitMs: ["requestStart", "firstPartial"],
  translationDomMs: ["inputStart", "firstTranslationDom"],
  translationVisibleMs: ["inputStart", "firstTranslationVisible"],
  finalDomMs: ["responseReceived", "finalDom"],
  /** 最终结果写进去之后，打字机还打了多久才把它打完（见 features/translation/typewriter.ts）。命中缓存、减少动画时为 0。 */
  typingTailMs: ["finalDom", "typingDone"],
  renderSettleMs: ["finalDom", "renderComplete"],
  popupRenderMs: ["popupShown", "renderComplete"],
  totalMs: ["inputStart", "ended"],
};

export function traceDurations(marks: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(TRACE_SPANS).flatMap(([name, [start, end]]) =>
    marks[start] !== undefined && marks[end] !== undefined ? [[name, Math.max(0, marks[end]! - marks[start]!)]] : []));
}
