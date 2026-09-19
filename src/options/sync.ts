import type { SyncStatus } from "../sync/engine.ts";

type SyncReply = { ok: boolean; status?: SyncStatus; userId?: string; serverId?: string; error?: string };

/** Shared by the extension options page and Android's settings page. Secrets never come back from the background. */
export function setupSyncSettings(): void {
  const fieldset = document.getElementById("sync-settings");
  if (!fieldset) return;
  const get = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const url = get<HTMLInputElement>("sync-url");
  const token = get<HTMLInputElement>("sync-token");
  const summary = get("sync-summary");
  const identity = get("sync-identity");
  const blocked = get("sync-blocked");
  const feedback = get("sync-feedback");
  const save = get<HTMLButtonElement>("sync-save");
  const test = get<HTMLButtonElement>("sync-test");
  const run = get<HTMLButtonElement>("sync-run");
  const pause = get<HTMLButtonElement>("sync-pause");
  const disconnect = get<HTMLButtonElement>("sync-disconnect");
  let current: SyncStatus | undefined;
  let busy = false;
  let stopped = false;
  let refreshVersion = 0;

  const render = (status: SyncStatus, fill = false): void => {
    current = status;
    if (fill) { url.value = status.baseUrl; token.value = ""; }
    token.placeholder = status.tokenSet ? "已设置，留空则保持不变" : "管理员签发的 Token";
    const state = status.running ? "正在同步…" : status.enabled ? "同步已启用" : status.tokenSet ? "同步已暂停" : "未连接";
    const time = status.lastSuccess ? new Date(status.lastSuccess).toLocaleString() : "尚未成功同步";
    const held = status.blocked > 0 ? `（其中 ${status.blocked} 项无法同步）` : "";
    summary.textContent = `${state} · 待上传 ${status.pending} 项${held} · ${time}${status.error ? ` · ${status.error}` : ""}`;
    summary.style.color = status.error ? "var(--warn)" : "";
    // 其余记录照常同步，所以这不算「同步失败」；但这几条一直上不去，得让人看见是哪条、为什么
    blocked.hidden = status.blocked === 0;
    blocked.textContent = status.blocked > 0
      ? `有 ${status.blocked} 项记录没通过校验，留在本机没有上传，其余照常同步。第一条：${status.blockedReason ?? "原因未知"}`
      : "";
    identity.hidden = !status.userId;
    identity.textContent = status.userId ? `账号：${status.userId} · 服务器：${status.serverId ?? "—"}` : "";
    save.textContent = status.enabled ? "保存连接设置" : "保存并启用同步";
    pause.hidden = !status.enabled;
    disconnect.hidden = !status.tokenSet;
    for (const button of [save, test, pause, disconnect]) button.disabled = busy;
    run.disabled = busy || !status.enabled || status.running;
    url.disabled = busy;
    token.disabled = busy;
  };

  const refresh = async (fill = false): Promise<void> => {
    const version = ++refreshVersion;
    const reply = await chrome.runtime.sendMessage({ type: "sync:get" }) as SyncStatus | SyncReply | undefined;
    if (version !== refreshVersion || stopped) return;
    // 后台出错时回的是 {ok:false,error}；把原因带出来，别让所有故障都长成同一句话。
    if (!reply || !("enabled" in reply) || typeof reply.enabled !== "boolean") {
      const reason = reply && "error" in reply && reply.error ? `：${reply.error}` : "";
      throw new Error(`无法读取同步设置，请重新打开设置页${reason}`);
    }
    render(reply, fill);
  };

  const connection = (): { baseUrl: string; token?: string } => {
    const baseUrl = url.value.trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("请填写后端地址");
    // Do not silently send an existing token to a newly entered endpoint, including during a test.
    const changed = baseUrl !== current?.baseUrl.replace(/\/+$/, "");
    const value = token.value.trim();
    if (changed && !value) throw new Error("更换后端地址时，请重新填写 Token");
    if (!value && !current?.tokenSet) throw new Error("请填写管理员签发的 Token");
    return { baseUrl, ...(value ? { token: value } : {}) };
  };

  const action = async (message: Record<string, unknown>, pending: string, done: string, fill = false): Promise<void> => {
    if (busy) return;
    busy = true;
    ++refreshVersion;
    if (current) render(current);
    feedback.style.color = "";
    feedback.textContent = pending;
    try {
      const reply = await chrome.runtime.sendMessage(message) as SyncReply;
      if (!reply?.ok) throw new Error(reply?.error || "服务器未返回有效结果");
      if (message.type === "sync:run" && reply.status?.error) throw new Error(reply.status.error);
      feedback.textContent = done + (message.type === "sync:test" && reply.userId
        ? ` · 账号：${reply.userId} · 服务器：${reply.serverId ?? "—"}` : "");
      await refresh(fill);
    } catch (error) {
      feedback.style.color = "var(--warn)";
      feedback.textContent = error instanceof Error ? error.message : String(error);
      try { await refresh(); } catch { /* Keep the actionable error from this request. */ }
    } finally {
      busy = false;
      if (current) render(current);
    }
  };

  const configure = (type: "sync:test" | "sync:configure"): void => {
    try {
      const config = connection();
      void action({ type, ...config, ...(type === "sync:configure" ? { enabled: true } : {}) },
        type === "sync:test" ? "正在测试连接…" : "正在验证并保存连接…",
        type === "sync:test" ? "连接成功，尚未修改配置" : "已保存，同步已启用", type === "sync:configure");
    } catch (error) {
      feedback.style.color = "var(--warn)";
      feedback.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  test.addEventListener("click", () => configure("sync:test"));
  save.addEventListener("click", () => configure("sync:configure"));
  run.addEventListener("click", () => void action({ type: "sync:run" }, "正在同步…", "同步请求已完成"));
  pause.addEventListener("click", () => {
    if (current) void action({ type: "sync:configure", baseUrl: current.baseUrl, enabled: false }, "正在暂停…", "同步已暂停，本机记录继续保存");
  });
  disconnect.addEventListener("click", () => void action({ type: "sync:disconnect" }, "正在断开…", "已断开连接，本机记录已保留", true));

  void refresh(true).catch(error => { summary.textContent = error instanceof Error ? error.message : String(error); });
  const timer = setInterval(() => {
    if (!busy && !document.hidden) void refresh().catch(() => { /* A later refresh or an explicit operation can retry. */ });
  }, 5_000);
  window.addEventListener("pagehide", () => { stopped = true; clearInterval(timer); }, { once: true });
}

setupSyncSettings();
