import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { DEFAULT_SETTINGS, type PageState } from "../src/types.ts";
import type { TrackController } from "../src/content/track.ts";
import { createPageHost } from "../src/content/host.ts";

/*
 * 同文档导航（SPA 路由 / history.pushState）换了文章：页内那套追踪要原地重来一轮。
 *
 * 两头各盯一段。track.ts 那头盯的是收摊收不收得干净：读完角标挂在 document.documentElement
 * 上、活动信号挂在 document 上，只有 pagehide 会走收尾路径，而页内导航根本不触发 pagehide。
 * 收不干净的话新起的那一轮会和旧的一起听着同一个 scroll，同一段阅读记两遍。
 * host.ts 那头盯的是什么时候该重来：目录锚点不算换页，抽正文那几秒里换的要认最后一次，
 * 从 bfcache 回来（后退/前进）则地址一模一样也得重来——那一轮在 pagehide 时就收摊了。
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
 * 这是"收摊收不收得干净"最直接的证据：一轮追踪挂着滚动里程表和划词翻译两个，
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

let sent: Array<{ type?: string; articleId?: string }> = [];
/** 设置监听的收支。摘不掉的话每重来一轮就多挂一个，翻译器会被停掉的那轮重新拉起来。 */
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
      sent.push(msg);
      // 角标只在后台确认建卡之后才弹，见 track.ts 的 maybeShowFinished
      return msg?.type === "article:finished" ? { ok: true, marked: true } : undefined;
    },
    getURL: (p: string) => `chrome-extension://test/${p}`,
  },
};

const { startTracking } = await import("../src/content/track.ts");
const { extractFromContainer } = await import("../src/content/paragraphs.ts");

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
    const perRound = scrolls; // 滚动里程表一个、划词翻译一个
    assert.equal(perRound > 0, true);

    // jsdom 的 visibilityState 是 prerender，机器认为页面没露出来、不会开始计时。
    // focus:"assume" 这条路径本来就由宿主通知可见性（App 的 WebView 就是这么接的）。
    first.setVisible(true);

    // 三段都进视口，跑够时间：读满比例 + 最后一段进过视野 = 读完
    ioCb(paras.map((target) => ({ target, isIntersecting: true })));
    await run(6_000);
    assert.equal(sent.some((m) => m.type === "article:finished"), true, "应当向后台报了读完");
    assert.notEqual(doc.getElementById(CARD_ID), null, "读完之后应当挂上角标");

    // 页内换到另一篇：宿主收掉这一轮（host.ts 的 run），走的是和离开页面同一条路径
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

test("非文章页：收摊时摘掉设置监听，划词翻译跟着停", async () => {
  settingsListeners = 0;
  const ctl = await startTracking({ url: FIRST, focus: "assume", extract: () => null });
  assert.equal(settingsListeners, 1);
  ctl.translateHere();
  assert.equal(ctl.state().translateHere, "on");

  // 换页时宿主会收掉这一轮、按新地址另起一个 translateOnly：
  // 「只对本次加载有效」里的「本次加载」，在单页应用里就是这一段路由。
  ctl.stop("unload");
  assert.equal(ctl.state().translateHere, "available");
  assert.equal(settingsListeners, 0, "摘不掉的话，总开关一变它又会把翻译器拉起来");
});

/* ---- host.ts：什么时候该重来一轮 ---- */

interface Round {
  url: string;
  signal: AbortSignal;
  /** 让这一轮就绪（模拟正文抽完）。 */
  ready(): Promise<void>;
  stops: number;
  translates: number;
}

/** 把 startTracking 换成手动控制就绪时机的假货，好摆出"抽正文那几秒里又换了页"。 */
function harness(): { host: ReturnType<typeof createPageHost>; rounds: Round[] } {
  const rounds: Round[] = [];
  const host = createPageHost((url, signal) => {
    let settle!: (c: TrackController) => void;
    const p = new Promise<TrackController>((r) => {
      settle = r;
    });
    const round: Round = {
      url,
      signal,
      stops: 0,
      translates: 0,
      ready: async () => {
        settle({
          state: (): PageState => ({ tracked: true, articleId: url, title: url }),
          setVisible: () => undefined,
          stop: () => {
            round.stops++;
          },
          translateHere: () => {
            round.translates++;
          },
        });
        await new Promise((r) => setImmediate(r));
      },
    };
    rounds.push(round);
    return p;
  });
  return { host, rounds };
}

test("目录锚点不算换页", async () => {
  const { host, rounds } = harness();
  host.start(FIRST);
  await rounds[0]!.ready();

  host.urlChanged(`${FIRST}#part-2`);
  host.urlChanged(`${FIRST}?utm_source=weekly`); // 跟踪参数同样归一化掉
  assert.equal(rounds.length, 1, "还是这一篇，不该重来");
  assert.equal(rounds[0]!.stops, 0);
  assert.equal(host.state().articleId, FIRST);
});

test("真换了一篇：收掉旧的一轮，按新地址起新的一轮", async () => {
  const { host, rounds } = harness();
  host.start(FIRST);
  await rounds[0]!.ready();

  host.urlChanged(SECOND);
  assert.equal(rounds[0]!.stops, 1, "旧的一轮要走收尾路径");
  assert.equal(rounds.length, 2);
  assert.equal(rounds[1]!.url, SECOND);

  // 正文还没抽完的那几秒：popup 看到的和刚打开一个页面时一样
  assert.deepEqual(host.state(), { tracked: false, reason: "初始化中" });
  host.translateHere(); // 这时点到就是空操作，popup 那时也拿不到按钮
  await rounds[1]!.ready();

  assert.equal(host.state().articleId, SECOND);
  host.translateHere();
  assert.equal(rounds[1]!.translates, 1, "「本页启用划词翻译」要转给新的一轮");
  assert.equal(rounds[0]!.translates, 0);
});

test("抽正文那几秒里连换两页：只认最后一次，中间那些就地作废", async () => {
  const { host, rounds } = harness();
  host.start(FIRST);
  host.urlChanged(SECOND);
  host.urlChanged(THIRD);
  assert.equal(rounds.length, 3);

  // 抽正文最长要重试到 4 秒。没有这个信号，被顶掉的那两轮会一路跑到底，
  // 还会替**旧**那篇发一遍 article:meta，在后台留下没人读过的孤儿卡。
  assert.equal(rounds[0]!.signal.aborted, true);
  assert.equal(rounds[1]!.signal.aborted, true);
  assert.equal(rounds[2]!.signal.aborted, false);

  // 就地作废来不及的（已经抽完了正文），resolve 时对不上号，当场收掉
  await rounds[0]!.ready();
  await rounds[1]!.ready();
  assert.equal(rounds[0]!.stops, 1);
  assert.equal(rounds[1]!.stops, 1);
  assert.deepEqual(host.state(), { tracked: false, reason: "初始化中" });

  await rounds[2]!.ready();
  assert.equal(host.state().articleId, THIRD);
  assert.equal(rounds[2]!.stops, 0);
});

test("从 bfcache 回来：地址一模一样也要重起一轮", async () => {
  const { host, rounds } = harness();
  host.start(FIRST);
  await rounds[0]!.ready();

  // 后台的 page:url-changed 救不了：后退回来地址压根没变，这条路认成「还是这一篇」
  host.urlChanged(FIRST);
  assert.equal(rounds.length, 1);

  // 而离开这一页时 pagehide 已经把那一轮收摊了（stopped 之后它不会再醒），
  // 没有这一下，回到的这一页就再也不计时、划词也不翻译
  host.restored(FIRST);
  assert.equal(rounds.length, 2, "同一个地址也要重起——离开时那一轮已经收摊了");
  assert.equal(rounds[1]!.url, FIRST);
  await rounds[1]!.ready();
  assert.equal(host.state().articleId, FIRST);
});

test("从 bfcache 回来：非文章页上用户点开的划词翻译要跟着回来", async () => {
  /** 照着 track.ts 的 translateOnly 来：默认不挂，收摊即关，只认用户亲手点的那一下。 */
  const rounds: Array<{ on: boolean }> = [];
  const host = createPageHost(async () => {
    const r = { on: false };
    rounds.push(r);
    return {
      state: (): PageState => ({ tracked: false, reason: "未识别为文章页", translateHere: r.on ? "on" : "available" }),
      setVisible: () => undefined,
      stop: () => {
        r.on = false;
      },
      translateHere: () => {
        r.on = true;
      },
    };
  });

  host.start(FIRST);
  await new Promise((r) => setImmediate(r));
  host.translateHere();
  assert.equal(host.state().translateHere, "on");

  host.restored(FIRST);
  await new Promise((r) => setImmediate(r));
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0]!.on, false, "旧的一轮照常收摊");
  assert.equal(
    host.state().translateHere,
    "on",
    "bfcache 回来还是同一次加载：用户点过的「本页启用」不该被这次重起悄悄关掉",
  );
});

test("这一轮起不来：popup 要说得出原因，换一页还能再试", async () => {
  const rounds: string[] = [];
  let fail = true;
  const host = createPageHost(async (url) => {
    rounds.push(url);
    if (fail) throw new Error("存储读不出来");
    return {
      state: (): PageState => ({ tracked: true, articleId: url }),
      setVisible: () => undefined,
      stop: () => undefined,
      translateHere: () => undefined,
    };
  });

  host.start(FIRST);
  await new Promise((r) => setImmediate(r));
  assert.match(host.state().reason ?? "", /初始化失败/);

  fail = false;
  host.urlChanged(SECOND);
  await new Promise((r) => setImmediate(r));
  assert.equal(host.state().articleId, SECOND);
  assert.deepEqual(rounds, [FIRST, SECOND]);
});
