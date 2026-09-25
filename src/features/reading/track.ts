import { samplePage } from "../../lib/articleFilter.ts";
import type {
  Article,
  EndReason,
  PageState,
  ParagraphRecord,
  ReadingPosition,
  Settings,
  SpeedSummary,
} from "../../types.ts";
import { DEFAULT_SETTINGS } from "../../types.ts";
import { normalizeUrl, isUrlExcluded } from "../../lib/url.ts";
import { isFinished } from "../../lib/finish.ts";
import { send } from "../../core/page/send.ts";
import { clampOffset, planRestore, type RestorePlan } from "../../lib/position.ts";
import { estimateReading, formatEstimate } from "../../lib/readingTime.ts";
import { type ExtractResult, extractArticle, extractFromContainer, ParagraphTracker } from "./paragraphs.ts";
import { FinishCard } from "./finishCard.ts";
import { PositionCard } from "./positionCard.ts";
import { SessionMachine } from "./session.ts";

/**
 * 页内追踪的本体：判断是不是文章、抽正文、划 session、记段落停留、读完角标、跳回上次位置。
 * 划词翻译是另一个插件（features/translation），这里不碰。
 *
 * 从 content/index.ts 里拆出来，是因为它有两个宿主：扩展的 content script 跑在
 * 别人的网页上（index.ts），安卓 App 的阅读器跑在自己渲染的正文上（src/app/read.ts）。
 * 两边的差别只有三处，都收在 TrackOptions 里：文章的地址不一定是页面的地址、
 * 焦点的来源不同、可见性可能要由宿主来通知。
 */

const HEARTBEAT_MS = 5_000;
const TICK_MS = 1_000;
/** 页面往往在 document_idle 之后才渲染正文，抽取失败时重试几次。 */
const EXTRACT_RETRY_MS = [0, 1_500, 4_000];
/**
 * 跳回上次位置之后的复查时刻。
 *
 * 跳的那一瞬间图片多半还没加载完、广告位还没撑开，落点会被后来的内容顶走。
 * 复查三次覆盖大多数情况，再往后拖就该由用户自己滚了。
 */
const RESTORE_RECHECK_MS = [250, 750, 1_500];

export interface TrackOptions {
  /** User-saved content has already been explicitly selected for reading; works offline. */
  approvedArticle?: boolean;
  /**
   * 文章的地址。扩展里就是 location.href；App 的阅读器页面里是**原文**的地址——
   * 页面自己的地址是 read.html，不代表文章。articleId 从它归一化而来，
   * 手机上和电脑上读同一篇才能合并到同一条记录。
   */
  url: string;
  /**
   * 焦点的来源。扩展里跟着 window 的 focus/blur 走；WebView 未必发这两个事件，
   * 而 App 在前台就等于有焦点，所以 App 传 "assume"，可见性由宿主用 setVisible 通知。
   */
  focus?: "window" | "assume";
  /**
   * 怎么拿到正文。缺省是对整个文档跑 Readability（网页上必须如此，还会重试几次等它渲染完）；
   * App 的阅读器自己渲染正文，直接从那个容器里取（见 paragraphs.ts 的 extractFromContainer）。
   */
  extract?: () => ExtractResult | null;
  /** 开始等 LLM 判断是不是文章了。宿主借此告诉用户这几秒在等什么。 */
  onClassifying?: () => void;
  /** 认出是文章、抽出标题之后告诉别人（见 core/page 的 PageInfo）。 */
  onTitle?: (title: string) => void;
  /**
   * 这一轮不作数了。页内换文章时宿主会作废手上这轮、按新地址另起一轮（见 core/page/host.ts），
   * 而抽正文最长要重试到 4 秒：没有这个信号，作废的那轮会一路跑到底，还会替**旧**那篇
   * 发一遍 article:meta。每个 await 之后查一次，作废了就当没识别过这一页。
   */
  signal?: AbortSignal;
}

export interface TrackController {
  /** 当前状态，popup / 阅读器顶栏每次询问都现算。 */
  state(): PageState;
  /** 宿主通知可见性变化（App 切到后台再回来）。扩展里 visibilitychange 事件自己会驱动，不必调。 */
  setVisible(visible: boolean): void;
  /** 结束追踪：结算最后一段、判一次读完、拆掉所有监听。重复调用无害。 */
  stop(reason?: EndReason): void;
}

/** chrome.storage.onChanged 的回调类型。具名注册才摘得掉，见 finish。 */
type SettingsListener = Parameters<typeof chrome.storage.onChanged.addListener>[0];

const idle = (reason: string): TrackController => ({
  state: () => ({ tracked: false, reason }),
  setVisible: () => undefined,
  stop: () => undefined,
});

export async function startTracking(opts: TrackOptions): Promise<TrackController> {
  const pageUrl = opts.url;
  const assumeFocus = opts.focus === "assume";

  /*
   * 这一轮挂到 document / window 上的监听，收摊时一次摘掉。
   *
   * 页内换文章要靠"摘干净"才敢原地再起一轮：漏掉哪一个，它就会和新那轮的同名监听
   * 一起留在页面上，同一个 scroll 喂给两个状态机，同一段阅读记两遍。注册和摘除写在
   * 一处，往后添监听不至于只写一半——划词翻译那边是同样的做法，见 selection.ts。
   */
  const detach: Array<() => void> = [];
  const on = (target: Document | Window, type: string, fn: EventListener, init?: AddEventListenerOptions): void => {
    target.addEventListener(type, fn, init);
    detach.push(() => target.removeEventListener(type, fn, init));
  };

  /*
   * 「用户已经自己动过了」的哨兵，必须在第一个 await 之前挂上：
   * 抽取最长要重试到 4 秒，这期间人可能早就读起来了，那就不该再跳。
   *
   * 只认真实的输入事件，不认 scroll——插件自己那一跳也会发 scroll，
   * 拿它当依据等于每次跳完都判自己出局。
   */
  let userMoved = false;
  const markMoved = (): void => {
    userMoved = true;
  };
  const MOVE_EVENTS = ["wheel", "keydown", "touchstart", "mousedown"] as const;
  const watchOpts = { passive: true, capture: true } as const;
  for (const type of MOVE_EVENTS) document.addEventListener(type, markMoved, watchOpts);
  const stopWatchingInput = (): void => {
    for (const type of MOVE_EVENTS) document.removeEventListener(type, markMoved, watchOpts);
  };
  // 这一组另有出口：跳回上次位置之后就不必再盯着，不必等到收摊。重复摘无害。
  detach.push(stopWatchingInput);

  /** 这一轮已经被顶掉了：把提前挂上的那组监听摘掉，当没识别过这一页。 */
  const abandoned = (): TrackController | null => {
    if (opts.signal?.aborted !== true) return null;
    stopWatchingInput();
    return idle("已切到另一篇");
  };

  const stored = await chrome.storage.local.get("settings");
  // 下一步就要跑 Readability 了，先看这一轮还作不作数
  const preempted = abandoned();
  if (preempted) return preempted;

  let settings: Settings = { ...DEFAULT_SETTINGS, ...((stored["settings"] as Partial<Settings>) ?? {}) };

  settings.articleExcludedUrls = (stored["settings"] as Partial<Settings> | undefined)?.articleExcludedUrls ?? settings.excludedDomains;
  if (isUrlExcluded(pageUrl, settings.articleExcludedUrls)) {
    stopWatchingInput();
    return idle("命中文章记录黑名单");
  }

  const supplied = opts.extract?.();
  if (!opts.approvedArticle) opts.onClassifying?.();
  let pageLeft = false;
  const left = (): void => { pageLeft = true; };
  window.addEventListener("pagehide", left, { once: true });
  let decision: { ok: boolean; isArticle?: boolean; reason: string };
  try {
    decision = opts.approvedArticle ? {ok:true,isArticle:true,reason:"已保存的文章"} : await chrome.runtime.sendMessage({ type: "article:classify", url: pageUrl,
      title: supplied?.title || document.title,
      text: samplePage(supplied ? supplied.paragraphs.map(p => p.text).join("\n\n") : (document.body?.innerText || document.body?.textContent || "")),
    });
  } catch { decision = { ok: false, reason: "文章判断失败，请刷新重试" }; }
  window.removeEventListener("pagehide", left);
  if (pageLeft) { stopWatchingInput(); return idle("已离开页面"); }
  const cancelled = abandoned();
  if (cancelled) return cancelled;
  // 判断期间设置可能已变化（比如刚把这一页加进了黑名单），再读一次。
  const fresh = await chrome.storage.local.get("settings");
  const saved = (fresh["settings"] as Partial<Settings>) ?? {};
  settings = { ...DEFAULT_SETTINGS, ...saved, articleExcludedUrls: saved.articleExcludedUrls ?? saved.excludedDomains ?? [] };
  const changed = abandoned();
  if (changed) return changed;
  if (!decision?.ok || !decision.isArticle || isUrlExcluded(pageUrl, settings.articleExcludedUrls)) {
    stopWatchingInput();
    return idle(isUrlExcluded(pageUrl, settings.articleExcludedUrls)
      ? "命中文章记录黑名单" : decision?.reason || "文章判断失败，请刷新重试");
  }
  // Readability 只负责正文定位，不再决定页面是否属于文章。
  const article = supplied || await extractWithRetry(opts.signal)
    || (document.body ? extractFromContainer(document.body, document.title) : null);
  // 抽正文那几秒里页面可能又换了一篇。必须赶在 article:meta 之前：那条消息会替
  // 这个 articleId 建卡，慢一步就在**旧**那篇名下留一张没人读过的孤儿卡。
  const gone = abandoned();
  if (gone) return gone;
  if (!article) {
    stopWatchingInput();
    return idle("未识别为文章页");
  }

  const articleId = normalizeUrl(pageUrl);
  const title = article.title || document.title;
  opts.onTitle?.(title);

  send({
    type: "article:meta",
    meta: {
      articleId,
      url: pageUrl,
      title,
      totalWords: article.totalWords,
      trackedWords: article.trackedWords,
      paragraphCount: article.paragraphs.length,
      // 按一般速度读完全文要多久，分文种算好再送：估「还需多久」时它是先验
      expectedMs: article.paragraphs.reduce((n, p) => n + p.expectedMs, 0),
    },
  });

  const tracker = new ParagraphTracker(article.paragraphs, {
    dwellMs: settings.paragraphDwellMs,
    readFraction: settings.readFraction,
    now: () => Date.now(),
  });

  // 跨刷新去重：已经读过的段落不再计入本次字数。
  // 顺带取 articles：本次加载**之前**就已读完的文章不该再弹回顾按钮。
  // 直接读存储而不是发 article:review-state——那个 handler 带 ensureArticleCard 的写入，
  // 是给 popup 用的，不该每开一个文章页就跑一次。
  // 顺带把位置记录也读出来（键名与 background/store.ts 的 posKey 一致），
  // 省一次往返——跳回上次位置这件事越早做越好。
  // 再带一份个人阅读速度的摘要（键名与 background/store.ts 的 KEY_SPEED 一致）：估「还需多久」要用。
  const prior = await chrome.runtime.sendMessage({type:"article:local-state",articleId}) ?? {};
  const priorRecords = (prior[`p:${articleId}`] as ParagraphRecord[]) ?? [];
  const priorPosition = (prior[`pos:${articleId}`] as ReadingPosition | undefined) ?? null;
  const priorArticle = ((prior["articles"] as Record<string, Article> | undefined) ?? {})[articleId];
  const wasFinishedOnLoad = priorArticle?.finished === true;
  const speedSummary = (prior["speed"] as SpeedSummary | undefined) ?? null;
  tracker.seedRead(priorRecords.filter((r) => r.firstSeenTs > 0).map((r) => r.hash));
  tracker.start();

  /**
   * 采一次「读到哪了」。
   *
   * 视口里一个正文段落都没有（人滚到评论区了、或者页面还没渲染完）时返回
   * undefined——**保留上一次的记录，别用一个空位置去覆盖对的**。
   */
  const positionNow = (): ReadingPosition | undefined => {
    const at = tracker.anchor();
    if (!at) return undefined;
    return {
      articleId,
      hash: at.hash,
      index: at.index,
      offset: at.offset,
      paragraphCount: article.paragraphs.length,
      savedTs: Date.now(),
    };
  };

  /*
   * 正文只上报一次，条件是**已读比例达到 finishRatio**。
   *
   * 不等"读完"（读完还要求触底）：读到 80% 时先把正文送出去，后台就能开始
   * 生成回顾材料，等你读完最后那一点，材料已经备好了。也天然把"打开两眼就走"
   * 的页面挡在外面——那些页面的正文存下来纯属占地方。
   */
  const body = article.paragraphs.map((p) => p.text).join("\n\n");
  let textSent = false;
  const maybeSendText = (): void => {
    if (textSent || !settings.articleReviewEnabled || article.trackedWords <= 0) return;
    if (tracker.wordsRead / article.trackedWords < settings.finishRatio) return;
    textSent = true;
    // 截断交给后台做，这里送全的——省得两处都要知道上限是多少
    send({ type: "article:text", articleId, text: body, fullChars: body.length });
  };

  /*
   * 读完就在右下角弹一个回顾入口。
   *
   * 判定必须在页内做：后台的 `finished` 是 session 结算时才置位的，而 session
   * 结束意味着用户已经走神或关掉了页面——那时候再弹按钮没人看得见。
   * 判定规则和后台共用 lib/finish.ts，避免两边说法不一致。
   */
  const finishCard = new FinishCard({
    onOpen: () => send({ type: "review:open", articleId }),
    onDismiss: () => {
      cardDone = true;
    },
  });
  /** 已经弹过或已被关掉。本次加载内不再弹第二次。 */
  let cardDone = wasFinishedOnLoad;
  let marking = false;
  /**
   * 已经收摊（离开页面 / 页内换了文章 / 域名被加进排除列表）。
   *
   * 事件那一侧不用查它——finish 已经把监听整组摘掉了。留着是为了两处
   * 跑在收摊边界上的调用：读完自查要等后台确认建卡才挂角标，回来时页面可能已经拆了；
   * 以及宿主直接调的 setVisible（App 的 WebView 那条路，不经过事件）。
   *
   * 因此 torn 必须在 machine.stop() **之后**才置位：stop 会同步走一遍 onEnd，
   * 那里还要结算最后一段、把正文和读完判定送出去。
   */
  let torn = false;
  const maybeShowFinished = (): void => {
    if (torn || cardDone || marking || !settings.articleReviewEnabled) return;
    const done = isFinished({
      wordsRead: tracker.wordsRead,
      trackedWords: article.trackedWords,
      reachedBottom: tracker.reachedBottom,
      finishRatio: settings.finishRatio,
    });
    if (!done) return;
    // 先让后台落盘建卡，拿到确认再弹：否则手快的用户点进回顾队列会扑空。
    // 后台正在重启时这一步会失败，下一拍心跳自然重试。
    //
    // 不能用上面的 send()——那个是发完就不管的，这里要等应答。但同样得包 try/catch：
    // 扩展被重载后 sendMessage 是**同步抛**的，漏掉就会把 marking 永久卡在 true。
    marking = true;
    const done_ = (): void => {
      marking = false;
    };
    try {
      void chrome.runtime
        .sendMessage({ type: "article:finished", articleId, ts: Date.now() })
        .then((res: { marked?: boolean } | undefined) => {
          // 落盘期间可能已经拆了（切走触发 pagehide），别再挂一个孤儿角标上去
          if (torn) return;
          // marked 为 false 说明后台压根没有这篇的记录（article:meta 丢了），
          // 这时候弹出来点进去是死路。不置 cardDone，下一拍再试。
          if (!res?.marked) return;
          cardDone = true;
          finishCard.show();
        })
        .catch(() => undefined)
        .finally(done_);
    } catch {
      done_(); // 扩展已被卸载/重载
    }
  };

  /*
   * 跳回上次位置之后的那行说明。
   * 和读完角标一样是浮层，但生命周期完全不同：它 6 秒后自己走，
   * 拆页面时也要跟着收掉——`stopRestore` 是唯一的出口。
   */
  const positionCard = new PositionCard({
    onTop: () => {
      window.scrollTo({ top: 0, behavior: "instant" });
      syncScrollBaseline();
    },
  });
  const restoreTimers = new Set<ReturnType<typeof setTimeout>>();
  const stopRestore = (): void => {
    for (const t of restoreTimers) clearTimeout(t);
    restoreTimers.clear();
    positionCard.hide();
    stopWatchingInput();
  };

  /** 本 session 内新读的字数。 */
  let sessionWords = 0;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let beatTimer: ReturnType<typeof setInterval> | null = null;
  const sessionsThisLoad: NonNullable<PageState["sessionsThisLoad"]> = [];

  /**
   * 这篇还要读多久。
   *
   * 三层证据见 lib/readingTime.ts：一般速度 → 你的整体速度（后台缓存的摘要）→ 这一篇自己的节奏。
   * 本篇的记录 = 加载时后台已聚合的 + 本次加载里已结束的片段。两者不重叠：聚合值是加载那一刻
   * 读出来的快照，之后的片段后台虽然也记了，手上这份没有变。进行中的片段不算——
   * 它的时长里含着此刻这段静默，还不知道是在读还是走了。
   */
  const estimateNow = () => {
    let words = priorArticle?.wordsRead ?? 0;
    let ms = priorArticle?.readingMs ?? priorArticle?.totalMs ?? 0;
    for (const s of sessionsThisLoad) {
      if (s.wordsRead <= 0) continue;
      words += s.wordsRead;
      ms += s.endTs - s.startTs;
    }
    return estimateReading(tracker.remainingTarget(), { article: { words, ms }, personal: speedSummary });
  };

  const machine = new SessionMachine(
    {
      idleTimeoutMs: settings.idleTimeoutMs,
      stallTimeoutMs: settings.stallTimeoutMs,
      minSessionMs: settings.minSessionMs,
      maxQuietMs: settings.maxQuietMs,
    },
    {
      now: () => Date.now(),
      // 走神阈值随视口里的文字量自适应：安静读完一屏所需的时间内不算走神
      visibleExpectedMs: () => tracker.visibleExpectedMs(),
      onStart(startTs) {
        sessionWords = 0;
        tracker.takeNewWords(); // 丢掉上一个 session 结束后残留的计数
        tracker.setActive(true);
        tickTimer = setInterval(() => machine.tick(), TICK_MS);
        beatTimer = setInterval(() => {
          sessionWords += tracker.takeNewWords();
          send({
            type: "session:heartbeat",
            articleId,
            now: Date.now(),
            wordsRead: sessionWords,
            position: positionNow(),
          });
          maybeSendText();
          maybeShowFinished();
        }, HEARTBEAT_MS);
        send({ type: "session:start", articleId, url: pageUrl, title, startTs });
      },
      onEnd(ev) {
        tracker.setActive(false);
        sessionWords += tracker.takeNewWords();
        // 心跳 5s 才一拍：读到 82% 后四秒就切走的话，只靠心跳会永远送不出去
        maybeSendText();
        // 正文先送、再判读完：读完那一刻后台才拿得到正文去生成材料
        maybeShowFinished();
        if (tickTimer !== null) clearInterval(tickTimer);
        if (beatTimer !== null) clearInterval(beatTimer);
        tickTimer = beatTimer = null;
        send({
          type: "session:end",
          articleId,
          startTs: ev.startTs,
          endTs: ev.endTs,
          wordsRead: sessionWords,
          endReason: ev.reason,
          discard: ev.discard,
          reachedBottom: tracker.reachedBottom,
          paragraphs: tracker.snapshot(),
          position: positionNow(),
        });
        if (!ev.discard) {
          sessionsThisLoad.push({
            startTs: ev.startTs,
            endTs: ev.endTs,
            wordsRead: sessionWords,
            endReason: ev.reason,
          });
        }
      },
    },
    { visible: document.visibilityState === "visible", focused: assumeFocus || document.hasFocus() },
  );

  const state = (): PageState => {
    const st: PageState = {
      tracked: true,
      articleId,
      title,
      totalWords: article.totalWords,
      trackedWords: article.trackedWords,
      wordsRead: tracker.wordsRead,
      paragraphCount: article.paragraphs.length,
      readParagraphCount: tracker.readCount,
      activeSince: machine.activeSince,
      sessionsThisLoad,
      visibleExpectedMs: tracker.visibleExpectedMs(),
      idleLimitMs: machine.quietLimits().idleMs,
      estimate: estimateNow(),
    };
    return st;
  };

  /* ---- 活动信号 ---- */

  // 滚动"里程表"：只有真实滚动位移才会让它变化，鼠标移动不会。
  // 用累计位移而非 window.scrollY，是为了兼容把正文放进内部滚动容器的站点。
  let odometer = 0;
  let lastWindowY = Math.round(window.scrollY);
  const containerTops = new WeakMap<Element, number>();

  /*
   * 状态机没有终态：`maybeStart` 只看"此刻活跃吗"。收摊之后随便一个 scroll 都会开一个新
   * session，认的还是**旧**那篇的 articleId——页内换文章时这就是把新文章的阅读时间记到旧
   * 文章头上，域名被加进排除列表时更糟：用户刚说别记了，下一次滚动又记起来。
   * 防的是 finish 那一步把这些监听整组摘掉，而不是在每个回调里设闸。
   */
  const signal = (): void => machine.activity(odometer);

  /**
   * 把里程表基准对齐到当前滚动位置。
   *
   * 插件自己滚的那一下也会发 scroll 事件，不对齐的话这段位移会被记进里程表，
   * 当成"用户真的滚了"——发呆判定（stall 之后必须有真实滚动才重新计时）
   * 就被一次程序性跳转骗过去了。
   */
  const syncScrollBaseline = (): void => {
    lastWindowY = Math.round(window.scrollY);
  };

  const onScroll = (ev: Event): void => {
    const t = ev.target;
    if (t instanceof Element && t !== document.documentElement && t !== document.body) {
      const top = Math.round(t.scrollTop);
      odometer += Math.abs(top - (containerTops.get(t) ?? top));
      containerTops.set(t, top);
    } else {
      const y = Math.round(window.scrollY);
      odometer += Math.abs(y - lastWindowY);
      lastWindowY = y;
    }
    signal();
  };

  // scroll 事件不冒泡，用捕获阶段才能收到内部容器的滚动
  on(document, "scroll", onScroll, { passive: true, capture: true });

  let lastMove = 0;
  const opts_ = { passive: true, capture: true } as const;
  on(
    document,
    "mousemove",
    () => {
      const now = Date.now();
      if (now - lastMove < 250) return; // mousemove 太密，节流
      lastMove = now;
      signal();
    },
    opts_,
  );
  for (const type of ["wheel", "keydown", "touchmove"]) on(document, type, signal, opts_);

  on(document, "visibilitychange", () => machine.setVisible(document.visibilityState === "visible"));
  if (!assumeFocus) {
    on(window, "focus", () => machine.setFocused(true));
    on(window, "blur", () => machine.setFocused(false));
  }

  let stopped = false;
  const finish = (reason: EndReason) => (): void => {
    if (stopped) return;
    stopped = true;
    machine.stop(reason); // 先停：onEnd 里还要结算最后一段、判一次读完
    torn = true;
    tracker.destroy();
    finishCard.hide();
    stopRestore();
    chrome.storage.onChanged.removeListener(onSettingsChanged);
    for (const off of detach) off(); // 页内换文章时紧接着就要另起一轮，漏一个就累积一个
    detach.length = 0;
  };
  // pagehide 的消息未必送达，后台会在 tab 关闭/导航时用最后一次心跳兜底
  on(window, "pagehide", finish("unload"));

  /* ---- 设置热更新 ---- */
  const onSettingsChanged: SettingsListener = (changes, area) => {
    if (area !== "local" || !changes["settings"]) return;
    settings = { ...DEFAULT_SETTINGS, ...(changes["settings"].newValue as Partial<Settings>) };
    machine.updateThresholds({
      idleTimeoutMs: settings.idleTimeoutMs,
      stallTimeoutMs: settings.stallTimeoutMs,
      minSessionMs: settings.minSessionMs,
      maxQuietMs: settings.maxQuietMs,
    });
    tracker.setThresholds({ dwellMs: settings.paragraphDwellMs, readFraction: settings.readFraction });
    if (isUrlExcluded(pageUrl, settings.articleExcludedUrls)) {
      finish("unload")();
      excludedNow = "命中文章记录黑名单";
    }
  };
  chrome.storage.onChanged.addListener(onSettingsChanged);
  /** 运行中被加进排除列表：状态要能说明为什么不追踪了。 */
  let excludedNow: string | null = null;

  /* ---- 跳回上次读到的位置 ----
   *
   * 放在最后是因为它依赖上面两样东西：滚动里程表的基准（跳完要对齐，
   * 否则这一跳会被当成用户的滚动），以及还没开始计时的 machine——
   * 落点应当是本次 session 的起点，而不是文章开头。
   *
   * 该不该跳全在 lib/position.ts 里判，这里只负责跳得准。 */
  const plan = planRestore({
    enabled: settings.restorePositionEnabled,
    pos: priorPosition,
    paragraphs: article.paragraphs,
    urlHash: location.hash,
    scrollY: window.scrollY,
    userScrolled: userMoved,
  });
  // 下标由 planRestore 保证落在本次抽取的范围内
  if (plan) applyRestore(article.paragraphs[plan.index]!.el, plan);
  else stopWatchingInput();

  machine.bootstrap();

  return {
    state: () => excludedNow ? { tracked: false, reason: excludedNow } : state(),
    setVisible: (v) => {
      // 宿主直接调的，不在 finish 摘掉的那组监听里：收摊之后再通知可见也不该重新计时
      if (!torn) machine.setVisible(v);
    },
    stop: (reason = "unload") => finish(reason)(),
  };

  /** 滚到锚点段落，并把落点微调到离开时的那个偏移。 */
  function scrollToAnchor(el: Element, offset: number): void {
    /*
     * instant 而不是 auto：站点若设了 `html { scroll-behavior: smooth }`，
     * auto 会一路动画滚过几十屏，而且紧接着量到的 rect.top 是动画中途的值，
     * 据此算出的修正量全是错的。
     */
    el.scrollIntoView({ block: "start", behavior: "instant" });
    // scrollIntoView 把段落顶怼到视口顶，再补上离开时滚进段落内部的那一段，
    // 画面才和当时一致——包括被吸顶导航挡住的那部分。
    const drift = el.getBoundingClientRect().top + offset;
    if (Math.abs(drift) > 1) window.scrollBy({ top: drift, behavior: "instant" });
    syncScrollBaseline();
  }

  function applyRestore(target: Element, plan: RestorePlan): void {
    // 位置可能是另一台设备记的，那边的像素偏移搬到这块屏上会越过段尾，见 clampOffset
    const p = { ...plan, offset: clampOffset(plan.offset, target.getBoundingClientRect().height) };
    scrollToAnchor(target, p.offset);
    // 跳回来的那一刻顺便说一句还要读多久：「现在读还是待会儿读」最需要的就是这个数
    const left = estimateNow();
    positionCard.show(p.index + 1, p.total, left.words > 0 ? "还需" + formatEstimate(left.ms) : undefined);

    // 图片撑开、广告位插入都会把落点顶走，跳完再盯一会儿。
    // 用户一动手就收手：把正在读的画面抽走是最恼人的一种交互。
    RESTORE_RECHECK_MS.forEach((ms, i) => {
      const t = setTimeout(() => {
        restoreTimers.delete(t);
        if (userMoved || torn) {
          stopWatchingInput();
          return;
        }
        const drift = target.getBoundingClientRect().top + p.offset;
        if (Math.abs(drift) > 4) scrollToAnchor(target, p.offset);
        if (i === RESTORE_RECHECK_MS.length - 1) stopWatchingInput();
      }, ms);
      restoreTimers.add(t);
    });
  }
}

async function extractWithRetry(signal?: AbortSignal): Promise<ReturnType<typeof extractArticle>> {
  for (const delay of EXTRACT_RETRY_MS) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    // 等这几秒的工夫页面可能已经换了一篇，别再拿旧地址那轮去跑一遍 Readability
    if (signal?.aborted === true) return null;
    const res = extractArticle(document);
    if (res) return res;
  }
  return null;
}
