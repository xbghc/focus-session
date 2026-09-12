import { localStorage } from "../sync/storage.ts";
import type { AppError, ReaderFetch } from "../types.ts";
import { serialize } from "./store.ts";

/**
 * App 侧的诊断记录：阅读器每抓一篇网页留一条现场，以及没被接住的运行时错误。
 *
 * 为什么要有——手机上没有开发者工具。扩展出了问题还能开着控制台再复现一次，
 * App 里除了界面上那一句话什么都不剩。这两份和 LLM 的失败/耗时一起进「诊断日志」
 * 那个导出文件（见 llmLog.ts 的 llmLogBundle），一次导出就能把现场发出去。
 *
 * 放在 background/ 是因为 App 的 background 就是这一份代码（见 app/boot.ts），
 * 而写入要走 store.ts 的 serialize：读改写不串起来的话，同时来两条会互相盖掉。
 *
 * 只存本机；不进数据导出（那份文件常被随手分享）；「清空全部记录」时随其他记录
 * 一起清掉——store.ts 的 clearData 是白名单，只留 settings 与 llm。
 */

export const KEY_READER_FETCH = "readerFetchLog";
export const KEY_APP_ERROR = "appErrorLog";

/**
 * 抓取记录留得比 LLM 失败多。两者要看的东西不一样：失败看的是单次现场，
 * 抓取看的是**一列**——是这个站特殊还是每次都这样，只有横着比才看得出来。
 * 一条十来个数字，30 条几 KB。
 */
export const MAX_FETCH_ENTRIES = 30;

/** 错误同理，而且同一个 bug 常连着报好几条，留少了整页都是同一条。 */
export const MAX_ERROR_ENTRIES = 30;

/** 单条里字符串字段的上限。地址和标题都可能很长，一条不该把日志撑爆。 */
export const MAX_TEXT_CHARS = 500;

/** 调用栈单独给一个更宽的上限：只留前几帧的话，往往正好切掉出错的那一帧。 */
export const MAX_STACK_CHARS = 2_000;

const local = (): chrome.storage.StorageArea => localStorage();

/** 超长的截掉尾部并留个标记。同 llmLog.ts 的 clip，那边限的是模型输出。 */
export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[已截断，原长 ${s.length}]` : s;
}

async function read<T>(key: string): Promise<T[]> {
  const got = await local().get(key);
  const v = got[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

export const getFetchLog = (): Promise<ReaderFetch[]> => read<ReaderFetch>(KEY_READER_FETCH);
export const getAppErrors = (): Promise<AppError[]> => read<AppError>(KEY_APP_ERROR);

const clipOrNull = (s: string | null, max: number): string | null => (s === null ? null : clip(s, max));

/**
 * 记一次抓取。成功的也记，理由见 types.ts 的 ReaderFetch。
 *
 * 落盘失败吞掉：日志是附属品，不能反过来把阅读器搞坏。
 */
export async function recordFetch(entry: ReaderFetch): Promise<void> {
  const safe: ReaderFetch = {
    ...entry,
    url: clip(entry.url, MAX_TEXT_CHARS),
    finalUrl: clipOrNull(entry.finalUrl, MAX_TEXT_CHARS),
    contentType: clipOrNull(entry.contentType, MAX_TEXT_CHARS),
    title: clipOrNull(entry.title, MAX_TEXT_CHARS),
    error: clipOrNull(entry.error, MAX_TEXT_CHARS),
  };
  try {
    await serialize(async () => {
      const log = await getFetchLog();
      log.push(safe);
      await local().set({ [KEY_READER_FETCH]: log.slice(-MAX_FETCH_ENTRIES) });
    });
  } catch {
    /* 见上：日志不能反过来把主流程搞坏 */
  }
}

/** 同上。装在 app/boot.ts 的 window 监听里。 */
export async function recordAppError(entry: AppError): Promise<void> {
  const safe: AppError = {
    ...entry,
    message: clip(entry.message, MAX_TEXT_CHARS),
    at: clipOrNull(entry.at, MAX_TEXT_CHARS),
    stack: clipOrNull(entry.stack, MAX_STACK_CHARS),
  };
  try {
    await serialize(async () => {
      const log = await getAppErrors();
      log.push(safe);
      await local().set({ [KEY_APP_ERROR]: log.slice(-MAX_ERROR_ENTRIES) });
    });
  } catch {
    /* 见上 */
  }
}
