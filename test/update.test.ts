import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  isNewer,
  parseVersion,
  pickReleaseApk,
  readUpdate,
  type ReleaseAsset,
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
