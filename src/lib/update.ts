/**
 * 版本比较与「哪个附件是能装的那个包」。纯逻辑，不碰 DOM 也不联网——
 * 联网那半在 src/app/update.ts，宿主那半在 NativeBridge.updateDownload。
 *
 * App 不走应用商店，升级包来自 GitHub Releases。这里只回答两个问题：
 * 远端那个 tag 是不是比装着的这个新、以及那次发布里哪个附件能装。
 */

/** GitHub Releases API 的响应里用得上的那几个字段。 */
export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  tag_name: string;
  body?: string | null;
  assets?: ReleaseAsset[] | null;
}

/** 一个「可以升上去」的版本。 */
export interface Update {
  /** 标签，`v0.3.5`。 */
  tag: string;
  /** 去掉 v 的版本号，`0.3.5`，和设置页显示的当前版本同一种写法。 */
  version: string;
  /** Release 的说明，`--generate-notes` 生成的 markdown 原文。 */
  notes: string;
  apk: ReleaseAsset;
}

/**
 * `v0.3.10` → `[0, 3, 10]`。
 *
 * 认不出的段按 0 算，和 build.gradle.kts 里算 versionCode 的 `toIntOrNull() ?: 0`
 * 保持一致：那边把 `0.3.5` 换算成 305，两处对版本号的读法必须是同一种，
 * 否则会出现「更新提示说有新版、装上去 versionCode 反而没涨」这种事。
 */
export function parseVersion(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    });
}

/** 负 / 零 / 正，同 Array.prototype.sort 的约定。位数不同时短的那个补 0：`0.4` == `0.4.0`。 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * 远端严格新于本地才算有更新。
 *
 * 认不出的版本号会被读成 0.0.0，于是「远端是一串乱码」的结果是不提示更新——
 * 宁可漏报也不能误报：误报的下一步是让用户去装一个来路不明的包。
 */
export function isNewer(remote: string, local: string): boolean {
  return compareVersions(remote, local) > 0;
}

/**
 * 正式签名的 APK 叫 `focus-session-vX.Y.Z.apk`，Release 工作流里配了签名密钥时才有。
 *
 * 只认这一个名字。同一次发布里可能还躺着 `-debug.apk`（仓库没配密钥时的产物），
 * 那个包是 runner 每次现生成的 debug 密钥签的，装不上任何已有的安装——
 * 拿它当升级包只会让用户在系统安装器那里撞一句没头没尾的「应用未安装」。
 */
const RELEASE_APK = /^focus-session-v\d+(?:\.\d+)*\.apk$/;

export function pickReleaseApk(assets: readonly ReleaseAsset[] | null | undefined, tag?: string): ReleaseAsset | null {
  // 响应来自网络：assets 是不是个数组都得先问一句
  if (!Array.isArray(assets) || !assets.length) return null;
  const usable = assets.filter(
    (a) => typeof a?.name === "string" && RELEASE_APK.test(a.name) && typeof a.browser_download_url === "string",
  );
  if (!usable.length) return null;
  // 这次发布自己的那个包优先；名字对不上时退回同名规则里的第一个
  const exact = tag ? usable.find((a) => a.name === `focus-session-${tag}.apk`) : undefined;
  return exact ?? usable[0] ?? null;
}

/**
 * GitHub 的响应 → 一个可升级的版本，够不上就是 null（已经是最新、没有正式签名的包、
 * 或者响应根本不是那么回事）。响应来自网络，字段一个都不能想当然。
 */
export function readUpdate(release: unknown, current: string): Update | null {
  if (typeof release !== "object" || release === null) return null;
  const r = release as Partial<Release>;
  const tag = typeof r.tag_name === "string" ? r.tag_name.trim() : "";
  if (!tag) return null;
  const version = tag.replace(/^v/i, "");
  if (!isNewer(version, current)) return null;
  const apk = pickReleaseApk(r.assets, tag);
  if (!apk) return null;
  return { tag, version, notes: typeof r.body === "string" ? r.body : "", apk };
}
