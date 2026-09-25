import { configureSync, disconnectSync, materialSync, runSync, syncStatus, testSync } from "../../sync/engine.ts";
import { clearArchiveCache } from "../../archive/cache.ts";
import { clearLlmLog, llmLogBundle } from "../../background/llmLog.ts";
import { recordUiUsage } from "../../background/uiUsage.ts";
import { getLlmConfig, getUsage, setLlmConfig } from "./llm.ts";
import { clearData, exportAll, getSettings, importBundle, persistMigrations, setSettings } from "../../background/store.ts";
import type { HandlerMap } from "./router.ts";

/*
 * 不属于任何一个功能的后台消息：同步、设置、数据导入导出、模型连接、诊断日志、界面埋点，
 * 以及唤醒 service worker、打开设置页这两件杂事。
 */

/** 启动时补一次：设置迁移要真写进 storage 才算数，见 persistMigrations 的说明。 */
export function bootCore(): void {
  void persistMigrations();
}

export const coreHandlers = {
  "sync:get": () => syncStatus(),
  "sync:material": (m) => materialSync(m.articleId),
  "sync:test": async (m) => ({ ok: true, ...await testSync(m.baseUrl, m.token) }),
  "sync:configure": async (m) => ({ ok: true, status: await configureSync(m.baseUrl, m.token, m.enabled) }),
  "sync:run": async () => {
    const status = await runSync();
    return { ok: !status.error, status, ...(status.error ? { error: status.error } : {}) };
  },
  "sync:disconnect": async () => ({ ok: true, status: await disconnectSync() }),

  "data:export": () => exportAll(),
  "data:import": (m) => importBundle(m.bundle),
  "data:clear": async () => {
    await clearData();
    if (typeof indexedDB !== "undefined") await clearArchiveCache();
    return { ok: true };
  },
  "settings:get": () => getSettings(),
  "settings:set": (m) => setSettings(m.settings),

  /* ---- 模型连接：文章判别、文章回顾、划词翻译共用一份。「测试连接」在划词翻译那边，见那里的说明 ---- */
  "llm:get": async () => {
    const cfg = await getLlmConfig();
    // 密钥只回传"设没设过"，不回显——popup/options 都没有必要拿到明文
    return { ...cfg, apiKey: "", apiKeySet: cfg.apiKey.length > 0 };
  },
  "llm:set": async (m) => {
    await setLlmConfig(m.config);
    return { ok: true };
  },
  "llm:usage": () => getUsage(),

  /* ---- 诊断日志与埋点 ---- */
  "llm:log": () => llmLogBundle(chrome.runtime.getManifest().version),
  "llm:log-clear": async () => {
    await clearLlmLog();
    return { ok: true };
  },
  "ui:track": async (m) => {
    await recordUiUsage(Array.isArray(m.events) ? m.events : []);
    return { ok: true };
  },

  // 空消息，唯一作用是唤醒 service worker——MV3 里 SW 空闲 30s 就休眠，
  // 冷启动要 200–500ms。content script 在 mousedown 时打这一下，
  // 等选完、过完防抖再发翻译请求时 SW 已经醒着了。
  "sw:ping": () => ({ ok: true }),
  // content script 打不开扩展页，只能请后台代劳
  "options:open": async () => {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
} satisfies HandlerMap;
