import type {
  AskReply,
  AskRequest,
  EndReason,
  OcrReply,
  PageState,
  PartialTranslation,
  Settings,
  TranslatePortIn,
  TranslatePortOut,
  TranslateRequest,
} from "../../types.ts";
import { DEFAULT_SETTINGS, PORT_TRANSLATE } from "../../types.ts";
import { matchesUrlRules, normalizeUrl } from "../../lib/url.ts";
import { reasonOf } from "../../lib/reason.ts";
import type { PageContext, PageFeature, PagePlugin } from "../../core/page/plugin.ts";
import { send } from "../../core/page/send.ts";
import { selectRegion, cancelRegion } from "./screenshot.ts";
import { SelectionTranslator, paragraphContext, type TranslateResponse } from "./selection.ts";

/*
 * 划词翻译插件：在一个页面上挂不挂选区监听，只由翻译自己的设置决定，和这一页记不记专注无关。
 *
 *   - 总开关（translateEnabled）关着：不挂，也不给「本页开启」的入口。
 *   - 命中翻译白名单：自动挂。
 *   - 其余页面：默认不挂，用户从 popup（App 里是阅读器顶栏的「译」）点一下才挂，
 *     只对本次加载有效。在邮件、聊天这类网页应用里选中一段文字，不该悄悄发给 MiniMax。
 *
 * 截图翻译不受这些管：每次都是用户亲手框的，见 screenshotAction。
 */

export interface TranslationOptions {
  /** App 阅读器传正文容器，启用单击单词、双击句子。 */
  tapRoot?: HTMLElement;
  /**
   * 这里的内容都是用户自己挑来读的（App 的阅读器）：不看白名单，总开关开着就挂。
   * 扩展跑在任意网页上，不能这么做。
   */
  autoEnable?: boolean;
}

export interface TranslationFeature extends PageFeature {
  /** 「本页启用划词翻译」：只对本次加载有效。总开关关着时只记下这个选择，开关回来才挂。 */
  translateHere(): void;
  screenshot(): void;
}

/** chrome.storage.onChanged 的回调类型。具名注册才摘得掉。 */
type SettingsListener = Parameters<typeof chrome.storage.onChanged.addListener>[0];

export function translationPlugin(opts: TranslationOptions = {}): PagePlugin<TranslationFeature, boolean> {
  return {
    start: (ctx, carried) => startTranslation(ctx, opts, carried === true),
    // 带到 bfcache 回来的新一轮：用户在本页手动开过翻译
    carry: (f) => f.state().translateHere === "on",
  };
}

function startTranslation(ctx: PageContext, opts: TranslationOptions, wantedInitially: boolean): TranslationFeature {
  const pageUrl = ctx.url;
  /** 设置还没读回来时是 null：那一小会儿什么都不挂，也不给入口。 */
  let settings: Settings | null = null;
  /** 用户点过「本页启用划词翻译」。 */
  let wanted = wantedInitially;
  let stopped = false;
  let translator: SelectionTranslator | null = null;
  let on = false;

  const getTranslator = (): SelectionTranslator => {
    translator ??= makeTranslator(normalizeUrl(pageUrl), pageUrl, ctx.info.title, () => settings ?? DEFAULT_SETTINGS, opts.tapRoot);
    return translator;
  };
  const screenshot = screenshotAction(getTranslator, () => !stopped);
  const auto = (): boolean => opts.autoEnable === true || matchesUrlRules(pageUrl, settings?.translationAllowedUrls ?? []);

  const sync = (): void => {
    const want = !stopped && settings !== null && settings.translateEnabled && (auto() || wanted);
    if (want === on) return;
    on = want;
    if (want) getTranslator().start();
    else translator?.stop();
  };

  const read = (raw: unknown): Settings => ({ ...DEFAULT_SETTINGS, ...((raw as Partial<Settings> | undefined) ?? {}) });
  const onSettingsChanged: SettingsListener = (changes, area) => {
    if (area !== "local" || !changes["settings"]) return;
    settings = read(changes["settings"].newValue);
    sync();
    ctx.changed();
  };
  chrome.storage.onChanged.addListener(onSettingsChanged);
  void chrome.storage.local.get("settings").then((got) => {
    // 热更新可能已经抢先送来了更新的一份
    if (stopped || settings !== null) return;
    settings = read(got["settings"]);
    sync();
    ctx.changed();
  }, () => undefined);

  return {
    state: () => {
      const st: Partial<PageState> = {};
      if (stopped) return st;
      st.screenshot = "available";
      // 总开关关着：不给字段，popup 就不会画一个点不动的按钮。白名单里的本来就挂着，也不给
      if (settings?.translateEnabled && !auto()) st.translateHere = on ? "on" : "available";
      return st;
    },
    stop: (_reason?: EndReason) => {
      if (stopped) return;
      stopped = true;
      screenshot.stop();
      on = false;
      // 没挂选区监听时浮层也可能开着（截图翻译的结果、失败提示），一并收掉
      translator?.stop();
      chrome.storage.onChanged.removeListener(onSettingsChanged);
    },
    screenshot: screenshot.run,
    translateHere: () => {
      if (stopped) return;
      wanted = true;
      sync();
    },
  };
}

/**
 * 走 port 发一次请求：把增量喂给调用方，拿到最终结果就收线。
 *
 * 走 port 而不是 sendMessage：一次请求要推多次增量（翻译是译文先到、语境解释后到，
 * 追问是答案一路往外冒），而 sendMessage 一个请求只允许一次应答。请求本身仍必须由
 * background 代发——MiniMax 端点没有 CORS 头，而且 API key 不能出现在与网页共享
 * 进程的 content script 里。
 *
 * 翻译和追问共用这一段：两者的差别只在发什么、怎么认增量、怎么认最终结果，
 * 而 port 的生命周期（取消、断线、重复 resolve）三处都一样，抄一遍就要错一遍。
 */
function onPort<R>(
  req: TranslatePortIn,
  signal: AbortSignal,
  /** 消化一条后台消息：是增量就自己处理并返回 null，是最终结果就把它返回。 */
  read: (m: TranslatePortOut) => R | null,
  /** 连不上、被取消、连接中断时给调用方的结果。 */
  failed: (error: string) => R,
): Promise<R> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(failed("已取消"));
      return;
    }
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: PORT_TRANSLATE });
    } catch (err) {
      // 扩展刚被重载时连不上，不该把页面搞崩
      resolve(failed(`后台未就绪：${reasonOf(err)}`));
      return;
    }

    let settled = false;
    const close = (): void => {
      try {
        port.disconnect();
      } catch {
        /* 已经断了 */
      }
    };
    const onAbort = (): void => {
      close(); // background 侧的 onDisconnect 会顺手中止请求
      finish(failed("已取消"));
    };
    const finish = (res: R): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(res);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    port.onMessage.addListener((m: TranslatePortOut) => {
      const res = read(m);
      if (res === null) return;
      finish(res);
      close();
    });
    port.onDisconnect.addListener(() => {
      // 正常收尾时 finish 已经落定，这里只兜住 SW 中途挂掉的情况
      finish(failed("与后台的连接中断"));
    });
    port.postMessage(req);
  });
}

/** 一次流式翻译。 */
function streamTranslate(
  req: TranslateRequest,
  onPartial: (p: PartialTranslation) => void,
  signal: AbortSignal,
): Promise<TranslateResponse> {
  return onPort<TranslateResponse>(
    { type: "start", req },
    signal,
    (m) => {
      if (m.type === "partial") onPartial(m.partial);
      return m.type === "done" ? m.res : null;
    },
    (error) => ({ ok: false, error, needsConfig: false }),
  );
}

/** 浮层里的一次追问。增量是**到目前为止的全部答案**，不是新增的那几个字。 */
function streamAsk(req: AskRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<AskReply> {
  return onPort<AskReply>(
    { type: "ask", req },
    signal,
    (m) => {
      if (m.type === "ask-partial") onDelta(m.text);
      return m.type === "ask-done" ? m.res : null;
    },
    (error) => ({ ok: false, error, needsConfig: false }),
  );
}

/** 划词翻译器的接线。 */
function makeTranslator(articleId: string, url: string, title: () => string, settings: () => Settings, tapRoot?: HTMLElement): SelectionTranslator {
  return new SelectionTranslator({
    recordTrace: trace => send({ type: "translation:trace", trace }),
    tapRoot,
    articleId,
    url,
    // 每次落库现取：专注记录抽出正文之后才知道真正的文章标题（见 PageInfo）
    get articleTitle() {
      return title();
    },
    settings,
    contextOf: paragraphContext,
    recognize: async (png, signal): Promise<OcrReply> => {
      if (signal.aborted) return { ok: false, error: "已取消" };
      const reply = await chrome.runtime.sendMessage({ type: "ocr:recognize", png }) as OcrReply | undefined;
      // Tesseract 不能中断；让后台那次跑完，前台只丢弃结果。
      return signal.aborted ? { ok: false, error: "已取消" }
        : reply ?? { ok: false, error: "识别失败：后台未就绪" };
    },
    translate: streamTranslate,
    ask: streamAsk,
    warm: () => send({ type: "sw:ping" }),
    openOptions: () => void chrome.runtime.sendMessage({ type: "options:open" }),
  });
}

/** 截图翻译每次都要用户动手、框出要译的那一块，所以不看白名单，也不看划词总开关。 */
function screenshotAction(getTranslator: () => SelectionTranslator, allowed: () => boolean) {
  let seq = 0;
  const stop = (): void => { seq++; cancelRegion(); };
  return {
    stop,
    run: (): void => {
      if (!allowed()) return;
      stop();
      const mine = seq;
      const translator = getTranslator();
      translator.dismiss();
      send({ type: "ocr:warm" });
      void (async () => {
        try {
          const reply = await chrome.runtime.sendMessage({ type: "page:capture" }) as
            { ok: boolean; dataUrl?: string; error?: string } | undefined;
          if (mine !== seq || !allowed()) return;
          if (!reply?.ok || !reply.dataUrl) throw new Error(reply?.error ?? "截图失败：后台未就绪或此页面不支持截图");
          const result = await selectRegion(reply.dataUrl);
          if (mine !== seq || !allowed() || !result) return;
          await translator.translateImage(result.png, result.rect);
        } catch (err) {
          if (mine === seq && allowed()) translator.showCaptureError(reasonOf(err));
        }
      })();
    },
  };
}
