import { native, downloadUpdate } from "./native.ts";
import { planAutoUpdate, readUpdate, type AutoStep, type Update } from "../lib/update.ts";

/**
 * 「有没有新版本」这件事的 App 侧。纯逻辑（版本比较、挑附件）在 lib/update.ts，
 * 下载和调起安装器在 NativeBridge，这里是中间那层：问 GitHub、记住问过了、
 * 把「下载完再装」串成一步。
 *
 * App 不走应用商店，装出去的包只能自己管升级。检查走 GitHub 的 Releases API——
 * 这是继 MiniMax 之后 App 会主动联系的第二个地方，所以：默认每天最多问一次、
 * 设置页能关、请求里除了「最新的那次发布是什么」不带任何东西（没有 API Key，
 * 没有阅读记录，连当前版本号都不发——比较是在本机做的）。
 */

const REPO = "xbghc/focus-session";
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** 自动更新走不通时（debug 包、宿主太老）让用户自己去下的地方。 */
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

const DAY = 24 * 60 * 60 * 1000;

/*
 * 这几个开关只跟这台手机上的这个安装有关，所以放 localStorage，不进 Settings：
 * Settings 是扩展和 App 共用的那份类型，也会随数据导出走——「上次检查更新是什么时候」
 * 跟到另一台设备上没有任何意义，而多一个字段两端都得跟着改。
 */
const KEY_AUTO = "fs:update:auto";
const KEY_LAST = "fs:update:last";
const KEY_SKIP = "fs:update:skip";
const KEY_INSTALL = "fs:update:install";

/** 装着的到底是哪个版本，以宿主报的为准；在普通浏览器里调试时退回构建时注入的那个。 */
export function currentVersion(): string {
  const v = native()?.version?.();
  return v && v.trim() ? v.trim() : __APP_VERSION__;
}

/** 宿主会不会下载和安装。老版本的 App 和浏览器里调试时都不会。 */
export function canSelfUpdate(): boolean {
  const bridge = native();
  return Boolean(bridge?.updateDownload && bridge.updateInstall);
}

/**
 * 这个安装是 debug 签名的：正式签名的升级包装不上去（签名不一致，系统直接拒），
 * 得先导出数据、卸载、再装新的。老版本的宿主没有这个方法，问不到就当不是。
 */
export function isDebugBuild(): boolean {
  try {
    return native()?.isDebugBuild?.() === true;
  } catch {
    return false;
  }
}

export function autoCheckEnabled(): boolean {
  // 默认开：用户要的就是"自动"更新，关掉是明确的选择
  return localStorage.getItem(KEY_AUTO) !== "off";
}

export function setAutoCheck(on: boolean): void {
  localStorage.setItem(KEY_AUTO, on ? "on" : "off");
}

/** 用户对这个版本说过「不用了」。下一个版本照常提示。 */
export function isSkipped(version: string): boolean {
  return localStorage.getItem(KEY_SKIP) === version;
}

export function skipVersion(version: string): void {
  localStorage.setItem(KEY_SKIP, version);
}

/**
 * 问 GitHub 要最新的那次发布。返回 null = 已经是最新的，或者那次发布里没有能装的包。
 *
 * 联网失败、限流都抛出来：手按的「检查更新」要看见失败原因，
 * 自动检查那条路径（autoCheck）自己把异常咽掉。
 */
export async function checkForUpdate(): Promise<Update | null> {
  const res = await fetch(LATEST_API, {
    // 不带 token 的匿名请求，GitHub 按 IP 限流 60 次/小时
    headers: { Accept: "application/vnd.github+json" },
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error("GitHub 暂时不让问了（匿名请求每小时 60 次），过会儿再试");
  }
  if (res.status === 404) throw new Error("这个仓库还没有发布过版本");
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  const json: unknown = await res.json();
  return readUpdate(json, currentVersion());
}

/**
 * 开 App 时那一次。关掉了、今天问过了、或者这个版本用户说了不用，都直接返回 null；
 * 网络不通也返回 null——首页不该因为没联网就冒出一句红字。
 *
 * 「今天问过了」在真正发请求之前就记下：连不上时也算问过，
 * 否则离线开十次 App 就是十次必然失败的请求。
 */
export async function autoCheck(): Promise<Update | null> {
  // 整段包在 try 里：这是后台顺手做的一件事，没网、限流、localStorage 抽风，
  // 任何一样都不该在首页上留下痕迹，更不该冒成一条未捕获的 rejection 记进诊断日志
  try {
    if (!canSelfUpdate() || !autoCheckEnabled() || isDebugBuild()) return null;
    const last = Number(localStorage.getItem(KEY_LAST) ?? 0);
    if (Number.isFinite(last) && Date.now() - last < DAY) return null;
    localStorage.setItem(KEY_LAST, String(Date.now()));
    const update = await checkForUpdate();
    if (!update || isSkipped(update.version)) return null;
    return update;
  } catch {
    return null;
  }
}

/* ==================== 自动下载并安装 ==================== */

export function autoInstallEnabled(): boolean {
  // 默认开。关掉之后回到老样子：首页出一条横幅，下不下、装不装都由人点
  return localStorage.getItem(KEY_INSTALL) !== "off";
}

export function setAutoInstall(on: boolean): void {
  localStorage.setItem(KEY_INSTALL, on ? "on" : "off");
  // 关掉的那一刻就撤销：宿主是在人**离开** App 之后装的，不撤的话这次离开还是会装
  if (!on) native()?.updateArm?.("");
}

/** 宿主缓存里躺着的可装版本。老宿主问不到，当没有。 */
export function readyVersion(): string {
  try {
    return native()?.updateReady?.() ?? "";
  } catch {
    return "";
  }
}

/** 上一次自动安装是怎么失败的。 */
export function lastFailure(): { version: string; message: string } | null {
  try {
    const raw = native()?.updateFailure?.();
    if (!raw) return null;
    const v = JSON.parse(raw) as { version?: unknown; message?: unknown };
    return { version: typeof v.version === "string" ? v.version : "", message: typeof v.message === "string" ? v.message : "" };
  } catch {
    return null;
  }
}

/**
 * 首页开着时的那一趟：有躺着的包就武装它，没有就问一次 GitHub，该悄悄下就悄悄下。
 * 返回首页该出哪一种横幅；什么都不用说就是 null。和 autoCheck 一样，任何一步出错都不往外冒。
 *
 * 下载只在不计费的网络上做，也只由首页发起：阅读器里人在读东西，不拿他的带宽。
 * 首页上没下完人就走了也没关系——宿主那边照下不误，下回开首页时 `updateReady()` 会报出来。
 */
export async function autoUpdate(): Promise<Exclude<AutoStep, { do: "nothing" | "download" }> | null> {
  try {
    if (!canSelfUpdate() || isDebugBuild()) return null;
    const bridge = native();
    const canPrefetch = Boolean(bridge?.updateReady);
    const plan = (found: Update | null): AutoStep =>
      planAutoUpdate({
        ready: readyVersion(),
        found,
        skipped: isSkipped,
        autoInstall: autoInstallEnabled(),
        canPrefetch,
        metered: bridge?.isMetered?.() ?? true,
        canSilent: bridge?.canSilentUpdate?.() ?? false,
        failedVersion: lastFailure()?.version || null,
      });
    const settle = (step: AutoStep): Exclude<AutoStep, { do: "nothing" | "download" }> | null => {
      if (step.do === "ready") bridge?.updateArm?.(step.silent ? step.version : "");
      return step.do === "ready" || step.do === "offer" ? step : null;
    };

    // 先看躺着的：一天只问 GitHub 一次，但下好的包每次开首页都该认
    const first = plan(null);
    if (first.do === "ready") return settle(first);
    const found = await autoCheck();
    const step = plan(found);
    if (step.do !== "download") return settle(step);
    try {
      await downloadUpdate(step.update.apk.browser_download_url, step.update.apk.size, () => undefined);
    } catch {
      return { do: "offer", update: step.update }; // 没下成：退回老样子，让人自己决定
    }
    const after = plan(null);
    return after.do === "ready" ? settle(after) : { do: "offer", update: step.update };
  } catch {
    return null;
  }
}

/** 手按的那次检查不受「今天问过了」限制，但同样把时间戳往前推。 */
export function markChecked(): void {
  localStorage.setItem(KEY_LAST, String(Date.now()));
}

/**
 * 下载并交给系统安装器。装不装、装完什么时候重启都是系统那边的事，
 * 这个 Promise 在安装器弹出来（或者用户被送去开授权）之后就结束了。
 */
export async function downloadAndInstall(
  update: Update,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  // 自动更新可能已经把这个版本下好了：不用再下一遍
  if (readyVersion() !== update.version) {
    await downloadUpdate(update.apk.browser_download_url, update.apk.size, onProgress);
  }
  native()?.updateInstall?.();
}
