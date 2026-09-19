import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  isNewer,
  parseVersion,
  pickReleaseApk,
  planAutoUpdate,
  readUpdate,
  type AutoInput,
  type ReleaseAsset,
  type Update,
} from "../src/lib/update.ts";

const asset = (name: string, size = 1024): ReleaseAsset => ({
  name,
  browser_download_url: `https://github.com/xbghc/focus-session/releases/download/v0.4.0/${name}`,
  size,
});

test("parseVersion 去掉 v、按段取整数", () => {
  assert.deepEqual(parseVersion("v0.3.4"), [0, 3, 4]);
  assert.deepEqual(parseVersion("0.3.4"), [0, 3, 4]);
  assert.deepEqual(parseVersion(" V1.2.3 "), [1, 2, 3]);
});

test("parseVersion 认不出的段按 0 算（同 build.gradle.kts 的 versionCode）", () => {
  assert.deepEqual(parseVersion("v0.x.4"), [0, 0, 4]);
  assert.deepEqual(parseVersion("nightly"), [0]);
  assert.deepEqual(parseVersion("v-1.2"), [0, 2]);
});

test("compareVersions 按数值比，不是按字典序", () => {
  // 字典序会说 0.3.10 < 0.3.9
  assert.equal(compareVersions("0.3.10", "0.3.9"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.3.4", "0.3.4"), 0);
  assert.equal(compareVersions("0.3.3", "0.3.4"), -1);
});

test("compareVersions 位数不同时短的补 0", () => {
  assert.equal(compareVersions("0.4", "0.4.0"), 0);
  assert.equal(compareVersions("v0.4", "0.4.1"), -1);
  assert.equal(compareVersions("0.4.1", "0.4"), 1);
});

test("isNewer 只在严格更新时为真", () => {
  assert.equal(isNewer("v0.3.5", "0.3.4"), true);
  assert.equal(isNewer("v0.3.4", "0.3.4"), false);
  assert.equal(isNewer("v0.3.3", "0.3.4"), false);
});

test("isNewer 认不出的远端版本不提示更新", () => {
  // 读成 0.0.0，宁可漏报也不引着用户去装一个来路不明的包
  assert.equal(isNewer("nightly", "0.3.4"), false);
  assert.equal(isNewer("", "0.3.4"), false);
});

test("pickReleaseApk 只认正式签名的那个名字", () => {
  const found = pickReleaseApk([
    asset("focus-session-extension-v0.4.0.zip"),
    asset("focus-session-v0.4.0.apk"),
  ]);
  assert.equal(found?.name, "focus-session-v0.4.0.apk");
});

test("pickReleaseApk 不拿 debug 包当升级包", () => {
  // runner 每次现生成的 debug 密钥签的，装不上任何已有的安装
  assert.equal(pickReleaseApk([asset("focus-session-v0.4.0-debug.apk")]), null);
  assert.equal(pickReleaseApk([asset("focus-session-extension-v0.4.0.zip")]), null);
  assert.equal(pickReleaseApk([]), null);
  assert.equal(pickReleaseApk(null), null);
});

test("pickReleaseApk 优先本次发布自己的那个包", () => {
  const found = pickReleaseApk(
    [asset("focus-session-v0.3.9.apk"), asset("focus-session-v0.4.0.apk")],
    "v0.4.0",
  );
  assert.equal(found?.name, "focus-session-v0.4.0.apk");
});

test("readUpdate 认出可升级的版本", () => {
  const up = readUpdate(
    {
      tag_name: "v0.4.0",
      body: "## 变更\n- 修了点东西",
      assets: [asset("focus-session-extension-v0.4.0.zip"), asset("focus-session-v0.4.0.apk", 4096)],
    },
    "0.3.4",
  );
  assert.equal(up?.tag, "v0.4.0");
  assert.equal(up?.version, "0.4.0");
  assert.equal(up?.apk.size, 4096);
  assert.match(up?.notes ?? "", /修了点东西/);
});

test("readUpdate 已经是最新时返回 null", () => {
  const latest = { tag_name: "v0.3.4", assets: [asset("focus-session-v0.3.4.apk")] };
  assert.equal(readUpdate(latest, "0.3.4"), null);
  assert.equal(readUpdate(latest, "0.4.0"), null);
});

test("readUpdate 没有正式签名的包时返回 null", () => {
  // 仓库没配签名密钥的那次发布：有新版本，但那个包装不上去
  const up = readUpdate(
    { tag_name: "v0.4.0", assets: [asset("focus-session-v0.4.0-debug.apk")] },
    "0.3.4",
  );
  assert.equal(up, null);
});

test("readUpdate 挡得住乱七八糟的响应", () => {
  assert.equal(readUpdate(null, "0.3.4"), null);
  assert.equal(readUpdate("not json", "0.3.4"), null);
  assert.equal(readUpdate({}, "0.3.4"), null);
  assert.equal(readUpdate({ tag_name: "" }, "0.3.4"), null);
  assert.equal(readUpdate({ tag_name: "v0.4.0" }, "0.3.4"), null);
  assert.equal(readUpdate({ tag_name: "v0.4.0", assets: "nope" }, "0.3.4"), null);
});

test("readUpdate 没有说明时 notes 是空串而不是 undefined", () => {
  const up = readUpdate(
    { tag_name: "v0.4.0", body: null, assets: [asset("focus-session-v0.4.0.apk")] },
    "0.3.4",
  );
  assert.equal(up?.notes, "");
});

/* ==================== 自动下载并安装 ==================== */

const found = (version: string): Update => ({ tag: `v${version}`, version, notes: "", apk: asset(`focus-session-v${version}.apk`) });
/** 一切就绪的默认处境：开着自动安装、新宿主、不计费的网络、能静默装、没失败过、没跳过。 */
const auto = (over: Partial<AutoInput> = {}): AutoInput => ({
  ready: "", found: null, skipped: () => false, autoInstall: true, canPrefetch: true, metered: false, canSilent: true, failedVersion: null, ...over,
});

test("没有躺着的包、也没问到新版本：什么都不做", () => {
  assert.deepEqual(planAutoUpdate(auto()), { do: "nothing" });
});

test("问到新版本：不计费的网络上悄悄下", () => {
  const update = found("0.4.0");
  assert.deepEqual(planAutoUpdate(auto({ found: update })), { do: "download", update });
});

test("不该悄悄下的四种处境都退回老样子——出一条横幅，下不下由人决定", () => {
  const update = found("0.4.0");
  for (const over of [{ metered: true }, { autoInstall: false }, { canPrefetch: false }, { failedVersion: "0.4.0" }]) {
    assert.deepEqual(planAutoUpdate(auto({ found: update, ...over })), { do: "offer", update }, JSON.stringify(over));
  }
  // 失败过的是别的版本：这个照下
  assert.equal(planAutoUpdate(auto({ found: update, failedVersion: "0.3.9" })).do, "download");
});

test("包已经躺着：武装它，人离开之后自己装", () => {
  assert.deepEqual(planAutoUpdate(auto({ ready: "0.4.0" })), { do: "ready", version: "0.4.0", silent: true });
  // 躺着的就是今天问到的那个：不重下
  assert.deepEqual(planAutoUpdate(auto({ ready: "0.4.0", found: found("0.4.0") })), { do: "ready", version: "0.4.0", silent: true });
});

test("包躺着但静默装不了：照样认它，只是得人点一下", () => {
  for (const over of [{ canSilent: false }, { autoInstall: false }, { failedVersion: "0.4.0" }]) {
    assert.deepEqual(planAutoUpdate(auto({ ready: "0.4.0", ...over })), { do: "ready", version: "0.4.0", silent: false }, JSON.stringify(over));
  }
  // 计费网络只管下不下；已经下好的照装
  assert.equal(planAutoUpdate(auto({ ready: "0.4.0", metered: true })).do, "ready");
});

test("用户对这个版本说过「不用了」：躺着的包不提、不装", () => {
  assert.deepEqual(planAutoUpdate(auto({ ready: "0.4.0", skipped: (v) => v === "0.4.0" })), { do: "nothing" });
});

test("躺着的包已经不是最新的：去下新的那个，不装旧的", () => {
  const update = found("0.4.1");
  assert.deepEqual(planAutoUpdate(auto({ ready: "0.4.0", found: update })), { do: "download", update });
  // 新的那个下不了（计费网络）：出横幅说有 0.4.1，也不去装躺着的 0.4.0
  assert.deepEqual(planAutoUpdate(auto({ ready: "0.4.0", found: update, metered: true })), { do: "offer", update });
  // 问到的反而更旧（发布被撤回之类）：躺着的照装
  assert.equal(planAutoUpdate(auto({ ready: "0.4.1", found: found("0.4.0") })).do, "ready");
});
