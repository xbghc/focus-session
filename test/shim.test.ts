import { test } from "node:test";
import assert from "node:assert/strict";
import type { PortLike } from "../src/background/handle.ts";
import { installChromeShim, memoryBackend } from "../src/app/shim.ts";

/*
 * chrome.* 垫片。这里不碰 IndexedDB（Node 里没有），用内存后端验证接线：
 * 消息到不到后台、port 两头通不通、storage.onChanged 响不响、flush 等不等。
 */

type Chrome = ReturnType<typeof makeChrome>;
function makeChrome(over: Partial<Parameters<typeof installChromeShim>[0]> = {}) {
  const seen: unknown[] = [];
  const ports: PortLike[] = [];
  const nav: string[] = [];
  const shim = installChromeShim({
    storage: memoryBackend(),
    handle: async (msg, sender) => {
      seen.push(msg);
      if ((msg as { type: string }).type === "boom") throw new Error("坏了");
      return { ok: true, tab: sender.tab?.id };
    },
    connect: (_name, port) => void ports.push(port),
    version: "9.9.9",
    navigate: (url) => void nav.push(url),
    ...over,
  });
  const c = (globalThis as { chrome: typeof chrome }).chrome;
  return { c, shim, seen, ports, nav };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("sendMessage 直接送到后台，带着一个 tab id", async () => {
  const { c, seen } = makeChrome();
  const res = await c.runtime.sendMessage({ type: "settings:get" });
  assert.deepEqual(res, { ok: true, tab: 1 });
  assert.deepEqual(seen, [{ type: "settings:get" }]);
});

test("后台抛错时折成 { ok: false }，和 service worker 的行为一致", async () => {
  const { c } = makeChrome();
  const res = (await c.runtime.sendMessage({ type: "boom" })) as { ok: boolean; error: string };
  assert.equal(res.ok, false);
  assert.match(res.error, /坏了/);
});

test("storage.local 读写与 onChanged", async () => {
  const { c } = makeChrome();
  const changes: unknown[] = [];
  c.storage.onChanged.addListener((ch, area) => void changes.push([area, Object.keys(ch)]));
  await c.storage.local.set({ settings: { a: 1 } });
  const got = await c.storage.local.get("settings");
  assert.deepEqual(got, { settings: { a: 1 } });
  // 深拷贝：改读出来的对象不会污染存储
  (got["settings"] as { a: number }).a = 2;
  assert.deepEqual(await c.storage.local.get("settings"), { settings: { a: 1 } });
  await c.storage.local.remove("settings");
  assert.deepEqual(await c.storage.local.get(null), {});
  assert.deepEqual(changes, [
    ["local", ["settings"]],
    ["local", ["settings"]],
  ]);
});

test("storage.session 与 local 是两套", async () => {
  const { c } = makeChrome();
  await c.storage.session.set({ open: 1 });
  assert.deepEqual(await c.storage.local.get("open"), {});
  assert.deepEqual(await c.storage.session.get("open"), { open: 1 });
});

test("connect：客户端发 start，服务端收到；服务端推 partial/done，客户端收到", async () => {
  const { c, ports } = makeChrome();
  const port = c.runtime.connect({ name: "translate" });
  assert.equal(ports.length, 1);
  const server = ports[0]!;
  const gotAtServer: unknown[] = [];
  const gotAtClient: unknown[] = [];
  server.onMessage.addListener((m) => void gotAtServer.push(m));
  port.onMessage.addListener((m) => void gotAtClient.push(m));

  port.postMessage({ type: "start" });
  await tick();
  assert.deepEqual(gotAtServer, [{ type: "start" }]);

  server.postMessage({ type: "partial", partial: { translation: "x" } } as never);
  server.postMessage({ type: "done", res: { ok: false, error: "e", needsConfig: false } });
  await tick();
  assert.equal(gotAtClient.length, 2);
});

test("一头断开，另一头的 onDisconnect 触发，自己那头不触发", async () => {
  const { c, ports } = makeChrome();
  const port = c.runtime.connect({ name: "translate" });
  const server = ports[0]!;
  let clientSaw = 0;
  let serverSaw = 0;
  port.onDisconnect.addListener(() => void clientSaw++);
  server.onDisconnect.addListener(() => void serverSaw++);

  server.disconnect();
  await tick();
  assert.equal(clientSaw, 1);
  assert.equal(serverSaw, 0);
  assert.throws(() => port.postMessage({ type: "start" }), /disconnected/);
  // 再断一次没有反应
  port.disconnect();
  await tick();
  assert.equal(clientSaw, 1);
  assert.equal(serverSaw, 0);
});

test("getURL 把扩展的 dashboard.html 指到 App 的首页；getManifest 给版本号", () => {
  const { c } = makeChrome();
  assert.match(c.runtime.getURL("dashboard.html"), /\/index\.html$/);
  assert.match(c.runtime.getURL("fonts/"), /\/fonts\/$/);
  assert.equal(c.runtime.getManifest().version, "9.9.9");
});

test("tabs.create 与 openOptionsPage 都是换页", async () => {
  const { c, nav } = makeChrome();
  await c.tabs.create({ url: "index.html#review" });
  await c.runtime.openOptionsPage();
  assert.deepEqual(nav, ["index.html#review", "options.html"]);
});

test("flush 等在途的写入落盘", async () => {
  let release: () => void = () => undefined;
  const slow = memoryBackend();
  const realSet = slow.set.bind(slow);
  slow.set = async (items) => {
    await new Promise<void>((r) => (release = r));
    await realSet(items);
  };
  const { c, shim } = makeChrome({ storage: slow });
  const write = c.storage.local.set({ k: 1 });
  let flushed = false;
  const flushing = shim.flush().then(() => (flushed = true));
  await tick();
  assert.equal(flushed, false, "写入还没落盘，flush 不该完成");
  release();
  await write;
  await flushing;
  assert.equal(flushed, true);
  assert.deepEqual(await slow.get("k"), { k: 1 });
});

test("sendMessage 引发的写入也算在途，flush 等它", async () => {
  const backend = memoryBackend();
  const { c, shim } = makeChrome({
    storage: backend,
    handle: async () => {
      await new Promise((r) => setTimeout(r, 5));
      await backend.set({ written: true });
      return { ok: true };
    },
  });
  void c.runtime.sendMessage({ type: "session:end" });
  await shim.flush();
  assert.deepEqual(await backend.get("written"), { written: true });
});
