import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouter, type HandlerMap } from "../src/core/background/router.ts";
import { coreHandlers } from "../src/core/background/handlers.ts";
import { readingHandlers } from "../src/features/reading/background.ts";
import { translationHandlers } from "../src/features/translation/background.ts";

/*
 * 后台消息分发：每种消息只归一个功能管。漏认领的由编译期挡（见 router.ts 的 missing），
 * 这里盯运行时那两条：重复登记当场报错说清是谁和谁，没人认的消息回 unknown message 而不是抛。
 */

const all = { core: coreHandlers, reading: readingHandlers, translation: translationHandlers };

test("三张表没有重复登记", () => {
  assert.doesNotThrow(() => createRouter(all));
});

test("同一种消息两家都认：当场报错，说清是谁和谁", () => {
  const dup: HandlerMap = { "sw:ping": () => ({ ok: "dup" }) };
  assert.throws(() => createRouter({ ...all, extra: dup }), /sw:ping 被 core 和 extra 重复登记/);
});

test("按类型转给认领的那一家，发消息的一方原样带过去", async () => {
  const route = createRouter(all);
  assert.deepEqual(await route({ type: "sw:ping" }, {}), { ok: true });
  const seen: unknown[] = [];
  const probe = createRouter({ ...all, core: { ...coreHandlers, "sw:ping": (_m, sender) => { seen.push(sender); return { ok: true }; } } });
  await probe({ type: "sw:ping" }, { tab: { id: 7 } });
  assert.deepEqual(seen, [{ tab: { id: 7 } }]);
});

test("没人认的消息回 unknown message，不抛", async () => {
  const route = createRouter(all);
  assert.deepEqual(await route({ type: "page:state" }, {}), { ok: false, error: "unknown message" });
  assert.deepEqual(await route({} as never, {}), { ok: false, error: "unknown message" });
});
