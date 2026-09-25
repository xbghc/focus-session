import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { DEFAULT_SETTINGS, type PageState } from "../src/types.ts";
import { createPageHost } from "../src/core/page/host.ts";
import type { PageContext, PageFeature, PagePlugin } from "../src/core/page/plugin.ts";

/*
 * 同文档导航（SPA 路由 / history.pushState）换了文章：页内那套追踪要原地重来一轮。
 *
 * 两头各盯一段。track.ts 那头盯的是收摊收不收得干净：读完角标挂在 document.documentElement
 * 上、活动信号挂在 document 上，只有 pagehide 会走收尾路径，而页内导航根本不触发 pagehide。
 * 收不干净的话新起的那一轮会和旧的一起听着同一个 scroll，同一段阅读记两遍。
 * core/page/host.ts 那头盯的是什么时候该重来：目录锚点不算换页，抽正文那几秒里换的要认最后一次，
 * 从 bfcache 回来（后退/前进）则地址一模一样也得重来——那一轮在 pagehide 时就收摊了。
 * features/reading 那头盯的是它的异步起步：还在等的时候被收掉，等完了也不能再起来。
 */

const FIRST = "https://news.example.com/a/first";
const SECOND = "https://news.example.com/a/second";
const THIRD = "https://news.example.com/a/third";
const CARD_ID = "focus-session-finish";

/** 三段短正文：按 238 wpm 每段的读完阈值约 1 秒，跑几拍就都算读过。 */
const PARAS = [
  "The river kept its own time and never once asked us for ours.",
  "Every morning the ferry crossed before the light reached the far bank.",
  "By winter the crossing had become the only thing anyone still agreed on.",
];

const dom = new JSDOM(
  `<!doctype html><html><head><title>渡口</title></head><body><div id="art">${PARAS.map((t) => `<p>${t}</p>`).join("")}</div></body></html>`,
  { url: FIRST },
);
const doc = dom.window.document;
const g = globalThis as Record<string, unknown>;
g["document"] = doc;
g["window"] = dom.window;
g["Node"] = dom.window.Node;
g["Element"] = dom.window.Element;
g["location"] = dom.window.location; // track.ts 跳回上次位置时要看 location.hash

// jsdom 的 getBoundingClientRect 一律返回 0，段落就永远不在"阅读视野"里。
// 摆成一叠都露在视口内的矩形：三段同时在读，跑够时间就都算读过、也算触底。
const paras = Array.from(doc.querySelectorAll("#art p"));
paras.forEach((el, i) => {
  const top = i * 120;
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ top, bottom: top + 100, height: 100, left: 0, right: 600, width: 600, x: 0, y: top }),
  });
});

/**
 * 数 document 上挂着几个 scroll 监听。
 *
 * 这是"收摊收不收得干净"最直接的证据：一轮追踪挂着滚动里程表，
 * 摘不掉的话每换一篇就多一套，同一个 scroll 事件喂给两个状态机。
 */
let scrolls = 0;
const realAdd = doc.addEventListener.bind(doc);
const realRemove = doc.removeEventListener.bind(doc);
doc.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
  if (type === "scroll") scrolls++;
  realAdd(type, fn, opts);
}) as typeof doc.addEventListener;
doc.removeEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
  if (type === "scroll") scrolls--;
  realRemove(type, fn, opts);
}) as typeof doc.removeEventListener;

/** 接住 tracker 注册的 IO 回调，好在测试里手动把段落推进视口。 */
let ioCb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void = () => {};
g["IntersectionObserver"] = class {
  constructor(cb: typeof ioCb) {
    ioCb = cb;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

let classifyAsArticle = true;
let sent: Array<{ type?: string; articleId?: string }> = [];
/** 设置监听的收支。摘不掉的话每重来一轮就多挂一个，停掉的那轮会被设置变化重新拉起来。 */
let settingsListeners = 0;
g["chrome"] = {
  storage: {
    // 存储里什么都没有：没读过的新文章，也没有上次的位置
    local: { get: async () => ({ settings: { ...DEFAULT_SETTINGS } }) },
    onChanged: {
      addListener: () => {
        settingsListeners++;
      },
      removeListener: () => {
        settingsListeners--;
      },
    },
  },
  runtime: {
    sendMessage: async (msg: { type?: string }) => {
      if (msg.type === "article:classify") return { ok: true, isArticle: classifyAsArticle, reason: "未识别为文章页" };
      sent.push(msg);
      // 角标只在后台确认建卡之后才弹，见 track.ts 的 maybeShowFinished
      return msg?.type === "article:finished" ? { ok: true, marked: true } : undefined;
    },
    getURL: (p: string) => `chrome-extension://test/${p}`,
  },
};

const { startTracking } = await import("../src/features/reading/track.ts");
const { readingPlugin } = await import("../src/features/reading/page.ts");
const { extractFromContainer } = await import("../src/features/reading/paragraphs.ts");

/** 让所有定时器跑够 ms，再把 sendMessage 的应答（微任务）也放行。 */
async function run(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await new Promise((r) => setImmediate(r));
}

test("收摊之后原地再起一轮：角标收掉、旧那篇不再收到任何消息", async () => {
  sent = [];
  settingsListeners = 0;
  scrolls = 0;
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_700_000_000_000 });
  try {
    const container = doc.getElementById("art")!;
    const first = await startTracking({
      url: FIRST,
      focus: "assume",
      extract: () => extractFromContainer(container, "渡口"),
    });
    assert.equal(first.state().tracked, true);
    const perRound = scrolls;
    assert.equal(perRound > 0, true);

    // jsdom 的 visibilityState 是 prerender，机器认为页面没露出来、不会开始计时。
    // focus:"assume" 这条路径本来就由宿主通知可见性（App 的 WebView 就是这么接的）。
    first.setVisible(true);

    // 三段都进视口，跑够时间：读满比例 + 最后一段进过视野 = 读完
    ioCb(paras.map((target) => ({ target, isIntersecting: true })));
    await run(6_000);
    assert.equal(sent.some((m) => m.type === "article:finished"), true, "应当向后台报了读完");
    assert.notEqual(doc.getElementById(CARD_ID), null, "读完之后应当挂上角标");

    // 页内换到另一篇：宿主收掉这一轮（core/page/host.ts 的 run），走的是和离开页面同一条路径
    first.stop("unload");
    assert.equal(doc.getElementById(CARD_ID), null, "换文章之后角标必须收掉——它是**这一篇**的入口");
    const ends = sent.filter((m) => m.type === "session:end");
    assert.equal(ends.length, 1, "最后一段要结算给旧那篇");
    assert.equal(ends[0]!.articleId, FIRST);
    assert.equal(settingsListeners, 0, "设置监听要跟着摘掉");
    assert.equal(scrolls, 0, "document 上的监听要摘干净");

    // 新的一轮：从这里开始，页面上任何动静都只该记到 SECOND 名下
    sent = [];
    const second = await startTracking({
      url: SECOND,
      focus: "assume",
      extract: () => extractFromContainer(container, "第二篇"),
    });
    second.setVisible(true);
    assert.equal(scrolls, perRound, "重来一轮不该在页面上累积监听");
    ioCb(paras.map((target) => ({ target, isIntersecting: true })));

    // 上一轮的监听若没摘干净，这几个事件会同时喂给两个状态机：状态机没有终态，
    // 收摊之后随便一个 scroll 就会拿**旧**那篇的 articleId 再开一个 session。
    doc.dispatchEvent(new dom.window.Event("scroll"));
    doc.dispatchEvent(new dom.window.Event("mousemove"));
    doc.dispatchEvent(new dom.window.Event("keydown"));
    await run(12_000);

    assert.equal(sent.length > 0, true, "新的一轮应当正常开始记");
    assert.deepEqual(
      [...new Set(sent.map((m) => m.articleId).filter((id) => id !== undefined))],
      [SECOND],
      "收摊之后旧那篇不该再收到任何消息",
    );
    // 收尾时那次读完自查是异步的（要等后台确认建卡），别让它事后又把角标挂回来
    second.stop("unload");
    await run(0);
    assert.equal(doc.getElementById(CARD_ID), null, "角标不该在收摊之后又挂回来");
    assert.equal(settingsListeners, 0);
    assert.equal(scrolls, 0);
  } finally {
    mock.timers.reset();
  }
});

test("非文章页：不留设置监听，也不挂任何页面监听", async () => {
  classifyAsArticle = false;
  settingsListeners = 0;
  scrolls = 0;
  const ctl = await startTracking({ url: FIRST, focus: "assume", extract: () => null });
  assert.deepEqual(ctl.state(), { tracked: false, reason: "未识别为文章页" });
  assert.equal(settingsListeners, 0);
  assert.equal(scrolls, 0);
  classifyAsArticle = true;
});

/* ---- features/reading：异步起步 ---- */

const ctxOf = (url: string, signal = new AbortController().signal): PageContext => ({
  url,
  signal,
  info: { title: () => "", setTitle: () => undefined },
  changed: () => undefined,
});

test("还在等 LLM 判断时 popup 看得到在等什么；等到之前就被收掉的，等到之后也不再起来", async () => {
  const chromeMock = g["chrome"] as { runtime: { sendMessage: (msg: { type?: string }) => Promise<unknown> } };
  const realSend = chromeMock.runtime.sendMessage;
  let respond!: (v: unknown) => void;
  chromeMock.runtime.sendMessage = (msg) => msg.type === "article:classify"
    ? new Promise((r) => { respond = r; })
    : realSend(msg);
  sent = [];
  settingsListeners = 0;
  scrolls = 0;
  try {
    const container = doc.getElementById("art")!;
    const f = readingPlugin({ focus: "assume", extract: () => extractFromContainer(container, "渡口") }).start(ctxOf(FIRST));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(f.state(), { tracked: false, reason: "LLM 正在判断是否为文章…" });

    f.stop("unload");
    respond({ ok: true, isArticle: true, reason: "是文章" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(scrolls, 0, "收摊之后判成文章也不该再挂监听");
    assert.equal(settingsListeners, 0);
    assert.equal(sent.some((m) => m.type === "session:start"), false);
  } finally {
    chromeMock.runtime.sendMessage = realSend;
  }
});

test("起不来：popup 要说得出原因", async () => {
  const chromeMock = g["chrome"] as { storage: { local: { get: () => Promise<unknown> } } };
  const realGet = chromeMock.storage.local.get;
  chromeMock.storage.local.get = async () => {
    throw new Error("存储读不出来");
  };
  try {
    const f = readingPlugin({ focus: "assume" }).start(ctxOf(FIRST));
    await new Promise((r) => setImmediate(r));
    assert.match(f.state().reason ?? "", /初始化失败/);
  } finally {
    chromeMock.storage.local.get = realGet;
  }
});

/* ---- core/page/host.ts：什么时候该重来一轮 ---- */

interface Round {
  url: string;
  signal: AbortSignal;
  stops: number;
  carried: unknown;
  on: boolean;
}
interface FakeFeature extends PageFeature {
  translateHere(): void;
}

/** 一个假插件：记下每一轮的地址、作废信号、收摊次数，以及 bfcache 回来时带过来的东西。 */
function fakePlugin(rounds: Round[], tracked = true): PagePlugin<FakeFeature, boolean> {
  return {
    start: (ctx, carried) => {
      const round: Round = { url: ctx.url, signal: ctx.signal, stops: 0, carried, on: carried === true };
      rounds.push(round);
      return {
        state: (): Partial<PageState> => tracked
          ? { tracked: true, articleId: ctx.url }
          : { translateHere: round.on ? "on" : "available" },
        stop: () => {
          round.stops++;
        },
        translateHere: () => {
          round.on = true;
        },
      };
    },
    carry: (f) => f.state().translateHere === "on",
  };
}

test("开张之前 popup 看到的是「初始化中」", () => {
  const host = createPageHost({ a: fakePlugin([]) });
  assert.deepEqual(host.state(), { tracked: false, reason: "初始化中" });
  assert.equal(host.get("a"), null);
});

test("目录锚点不算换页", () => {
  const rounds: Round[] = [];
  const host = createPageHost({ a: fakePlugin(rounds) });
  host.start(FIRST);

  host.urlChanged(`${FIRST}#part-2`);
  host.urlChanged(`${FIRST}?utm_source=weekly`); // 跟踪参数同样归一化掉
  assert.equal(rounds.length, 1, "还是这一篇，不该重来");
  assert.equal(rounds[0]!.stops, 0);
  assert.equal(host.state().articleId, FIRST);
});

test("真换了一篇：每个插件都收掉旧的一轮、按新地址起新的一轮，旧一轮的作废信号拉响", () => {
  const a: Round[] = [];
  const b: Round[] = [];
  const host = createPageHost({ a: fakePlugin(a), b: fakePlugin(b, false) });
  host.start(FIRST);
  host.urlChanged(SECOND);
  host.urlChanged(THIRD);

  for (const rounds of [a, b]) {
    assert.deepEqual(rounds.map((r) => r.url), [FIRST, SECOND, THIRD]);
    assert.deepEqual(rounds.map((r) => r.stops), [1, 1, 0]);
    // 起步要花几秒的插件靠它就地收手，不然被顶掉的那轮会替旧那篇发一遍 article:meta
    assert.deepEqual(rounds.map((r) => r.signal.aborted), [true, true, false]);
  }
  host.get("b")?.translateHere();
  assert.equal(b[2]!.on, true, "操作要转给新的一轮");
  assert.deepEqual(host.state(), { tracked: true, articleId: THIRD, translateHere: "on" }, "各插件的状态拼成一份");
});

test("从 bfcache 回来：地址一模一样也要重起一轮，用户在本页的选择跟着回来", () => {
  const rounds: Round[] = [];
  const host = createPageHost({ t: fakePlugin(rounds, false) });
  host.start(FIRST);
  host.get("t")?.translateHere();

  // 后台的 page:url-changed 救不了：后退回来地址压根没变，这条路认成「还是这一篇」
  host.urlChanged(FIRST);
  assert.equal(rounds.length, 1);

  host.restored(FIRST);
  assert.equal(rounds.length, 2, "同一个地址也要重起——离开时那一轮已经收摊了");
  assert.equal(rounds[0]!.stops, 1);
  assert.equal(rounds[1]!.carried, true);
  assert.equal(host.state().translateHere, "on", "bfcache 回来还是同一次加载：用户点过的「本页启用」不该被悄悄关掉");

  // 换一篇就不带了：「只对本次加载有效」里的「本次加载」，在单页应用里就是这一段路由
  host.urlChanged(SECOND);
  assert.equal(rounds[2]!.carried, undefined);
  assert.equal(host.state().translateHere, "available");
});

test("插件之间经 PageInfo 共享标题：没人写就用宿主给的缺省", () => {
  let info!: PageContext["info"];
  const host = createPageHost({
    probe: { start: (ctx: PageContext) => { info = ctx.info; return { state: () => ({}), stop: () => undefined }; } },
  }, { title: () => "缺省标题" });
  host.start(FIRST);
  assert.equal(info.title(), "缺省标题");
  info.setTitle("正文标题");
  assert.equal(info.title(), "正文标题");
});

test("stop 收掉全部插件，重复调用无害", () => {
  const rounds: Round[] = [];
  const host = createPageHost({ a: fakePlugin(rounds) });
  host.start(FIRST);
  host.stop();
  host.stop();
  assert.equal(rounds[0]!.stops, 1);
  assert.equal(rounds[0]!.signal.aborted, true);
  assert.equal(host.get("a"), null);
});

test("插件说「状态变了」时宿主转给界面；被顶掉的那几轮说的不转", () => {
  const changes: string[] = [];
  const said: Array<() => void> = [];
  const host = createPageHost({
    probe: { start: (ctx: PageContext) => { said.push(ctx.changed); return { state: () => ({}), stop: () => undefined }; } },
  }, { onChange: () => changes.push("changed") });
  host.start(FIRST);
  host.urlChanged(SECOND);
  said[0]!(); // 旧那轮迟到的起步完成
  assert.deepEqual(changes, []);
  said[1]!();
  assert.deepEqual(changes, ["changed"]);
});
