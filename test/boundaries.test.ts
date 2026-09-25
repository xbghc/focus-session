import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

/*
 * 功能插件之间的边界：core 不知道有哪些功能，功能之间互不引用——要共享的东西放进 core
 * （比如页面标题走 PageInfo）。靠目录约定守不住，这里把 import 扫一遍。
 */

const SRC = resolve(import.meta.dirname, "../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** 这个文件 import 了 src 下的哪些文件（相对 src 的路径）。 */
function imports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/\bfrom\s+"(\.[^"]+)"|\bimport\s*\(\s*"(\.[^"]+)"\s*\)/g)]
    .map((m) => relative(SRC, resolve(dirname(file), m[1] ?? m[2]!)));
}

const featureOf = (path: string): string | null => /^features\/([^/]+)\//.exec(path)?.[1] ?? null;

test("core 不引用任何功能插件", () => {
  const bad = files(join(SRC, "core")).flatMap((f) =>
    imports(f).filter((to) => featureOf(to) !== null).map((to) => `${relative(SRC, f)} → ${to}`));
  assert.deepEqual(bad, []);
});

test("功能插件之间互不引用", () => {
  const bad = files(join(SRC, "features")).flatMap((f) => {
    const mine = featureOf(relative(SRC, f));
    return imports(f)
      .filter((to) => featureOf(to) !== null && featureOf(to) !== mine)
      .map((to) => `${relative(SRC, f)} → ${to}`);
  });
  assert.deepEqual(bad, []);
});
