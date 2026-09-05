import type {
  Article,
  ArticleReviewState,
  EndReason,
  Overview,
  PageState,
  ParagraphRecord,
  PopupToContent,
  Session,
  SpeedSummary,
} from "../types.ts";
import { formatDuration, overviewInsights, wordsPerMinute } from "../lib/stats.ts";
import { describeBasis, estimateArticle, formatEstimate } from "../lib/readingTime.ts";
import { hostnameOf } from "../lib/url.ts";
import { clear, el, empty } from "./dom.ts";

const REASON_LABEL: Record<EndReason, string> = {
  idle: "走神",
  stall: "发呆",
  hidden: "切走",
  blur: "失焦",
  unload: "离开",
  recovered: "补记",
};

function ask<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

const panels = {
  current: document.getElementById("panel-current")!,
  history: document.getElementById("panel-history")!,
  overview: document.getElementById("panel-overview")!,
};

function kv(rows: Array<[string, string]>): HTMLElement {
  return el(
    "dl",
    { class: "kv" },
    rows.flatMap(([k, v]) => [el("dt", {}, [k]), el("dd", {}, [v])]),
  );
}

/* ---------- 当前页 ---------- */

let liveTimer: ReturnType<typeof setInterval> | null = null;

/** 问当前标签页的 content script 一句。chrome:// 页、PDF、扩展商店等注入不了脚本，回 null。 */
async function askPage<T>(msg: PopupToContent): Promise<T | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    return (await chrome.tabs.sendMessage(tab.id, msg)) as T;
  } catch {
    return null;
  }
}

const fetchPageState = (): Promise<PageState | null> => askPage<PageState>({ type: "page:state" });

function renderCurrent(st: PageState | null): void {
  const root = panels.current;
  clear(root);
  if (liveTimer !== null) {
    clearInterval(liveTimer);
    liveTimer = null;
  }

  if (!st) {
    root.append(empty("此页面无法追踪（浏览器内部页面或未注入脚本）"));
    return;
  }
  if (!st.tracked) {
    const box = el("div", { class: "empty" }, [el("div", {}, [st.reason ?? "未追踪"])]);
    if (st.translateHere) box.append(translateHereNode(st.translateHere));
    root.append(box);
    return;
  }

  root.append(el("h2", {}, [st.title || "（无标题）"]));

  const durationNode = el("div", { class: "big" }, ["—"]);
  const label = el("div", { class: "muted small" }, ["当前 session"]);
  root.append(durationNode, label);

  const paint = (): void => {
    if (st.activeSince) {
      durationNode.textContent = formatDuration(Date.now() - st.activeSince);
      durationNode.classList.add("live");
      label.textContent = "正在计时";
    } else {
      durationNode.textContent = "未在计时";
      durationNode.classList.remove("live");
      label.textContent = "切回页面或滚动即可开始新的 session";
    }
  };
  paint();
  if (st.activeSince) liveTimer = setInterval(paint, 1000);

  const tracked = st.trackedWords ?? 0;
  const read = st.wordsRead ?? 0;
  const pct = tracked > 0 ? Math.min(100, Math.round((read / tracked) * 100)) : 0;

  root.append(el("div", { class: "progress" }, [el("span", { style: "width:" + pct + "%" })]));

  const done = st.sessionsThisLoad ?? [];
  const liveMs = st.activeSince ? Date.now() - st.activeSince : 0;
  const totalMs = done.reduce((n, s) => n + (s.endTs - s.startTs), 0) + liveMs;

  const rows: Array<[string, string]> = [
    ["已读", pct + "%（" + read + " / " + tracked + " 字）"],
    ["段落", (st.readParagraphCount ?? 0) + " / " + (st.paragraphCount ?? 0)],
    ["本次加载专注", formatDuration(totalMs)],
    ["session 数", String(done.length + (st.activeSince ? 1 : 0))],
    ["正文全文", (st.totalWords ?? 0) + " 字"],
  ];
  // 走神阈值随视口文字量自适应，把此刻的数字亮出来，"为什么还没算走神"就不用猜
  if (st.visibleExpectedMs !== undefined && st.idleLimitMs !== undefined) {
    rows.push(
      ["这一屏读完约需", formatDuration(st.visibleExpectedMs)],
      ["静默多久算走神", formatDuration(st.idleLimitMs)],
    );
  }
  // 还要读多久。都读过了就没这一行——那时该说话的是下面的回顾提示
  const est = st.estimate;
  if (est && est.words > 0) rows.push(["预计还需", formatEstimate(est.ms)]);
  root.append(kv(rows));
  if (est && est.words > 0) root.append(el("div", { class: "muted small basis" }, [describeBasis(est)]));

  if (st.articleId) void appendReviewLine(root, st.articleId);

  root.append(el("div", { class: "muted small" }, ["本页 session 时间条"]));
  root.append(timeline(done, st.activeSince ?? null));
  if (done.length > 0) {
    const legend = done
      .map((s) => formatDuration(s.endTs - s.startTs) + "·" + REASON_LABEL[s.endReason])
      .join("　");
    root.append(el("div", { class: "muted small" }, [legend]));
  }
}

/**
 * 非文章页上的划词翻译入口。
 *
 * 这类页面默认不挂选区监听（在网页应用里选中文本不该悄悄联网），这里点一下才挂，
 * 而且只对当前这次加载生效——刷新就回到默认。应答里带着更新后的状态，直接重画。
 */
function translateHereNode(state: NonNullable<PageState["translateHere"]>): HTMLElement {
  if (state === "on") return el("div", { class: "small translate-on" }, ["划词翻译已在本页开启，刷新后失效"]);
  const btn = el("button", { type: "button", class: "btn" }, ["本页启用划词翻译"]);
  btn.addEventListener("click", () => {
    btn.disabled = true;
    // 应答就是更新后的状态；拿不到（页面刚好跳走了）就再问一遍
    void askPage<PageState>({ type: "page:translate-here" })
      .then(async (st) => renderCurrent(st ?? (await fetchPageState())));
  });
  return btn;
}

/**
 * 「回顾材料备好了没」这一行。
 *
 * 走的是只读查询，**不会触发生成**——打开一次 popup 就烧一次 token 说不过去。
 * 异步追加而不是阻塞整个面板：这一行没了不影响别的信息。
 */
async function appendReviewLine(root: HTMLElement, articleId: string): Promise<void> {
  let st: ArticleReviewState;
  try {
    st = (await chrome.runtime.sendMessage({ type: "article:review-state", articleId })) as ArticleReviewState;
  } catch {
    return; // 后台正在重启，这一行可有可无
  }
  if (!st?.hasText) return; // 还没读到阈值，没什么可说的

  const row = el("div", { class: "review-line" });
  row.append(el("span", {}, [st.hasReview ? "回顾材料已备好" : "正在准备回顾材料…"]));

  // 回顾卡是读完那一刻才建的。没读完就给链接会跳到一个空白面板。
  if (st.carded) {
    const go = el("a", { href: "#" }, ["去回顾"]);
    go.addEventListener("click", (e) => {
      e.preventDefault();
      void chrome.tabs.create({
        url: chrome.runtime.getURL("dashboard.html") + "#review:" + encodeURIComponent(articleId),
      });
    });
    row.append(go);
  } else if (st.hasReview) {
    row.append(el("span", { class: "hint-right" }, ["读完后进入回顾队列"]));
  }
  root.append(row);
}

/** 每段宽度正比于时长，段与段之间留一个正比于间隔的空隙。 */
function timeline(done: NonNullable<PageState["sessionsThisLoad"]>, activeSince: number | null): HTMLElement {
  const row = el("div", { class: "timeline" });
  const segs = [
    ...done.map((s) => ({ start: s.startTs, ms: s.endTs - s.startTs, live: false })),
    ...(activeSince ? [{ start: activeSince, ms: Date.now() - activeSince, live: true }] : []),
  ];
  if (segs.length === 0) {
    row.append(el("span", { class: "muted small" }, ["本次加载还没有 session"]));
    return row;
  }
  const last = segs[segs.length - 1]!;
  const first = segs[0]!;
  const span = Math.max(1, last.start + last.ms - first.start);
  let prevEnd = first.start;
  for (const s of segs) {
    const gapPct = ((s.start - prevEnd) / span) * 100;
    if (gapPct > 0.5) row.append(el("span", { class: "gap", style: "flex:" + gapPct }));
    row.append(
      el("span", {
        class: s.live ? "seg is-live" : "seg",
        style: "flex:" + Math.max(1, (s.ms / span) * 100),
        title: new Date(s.start).toLocaleTimeString() + " · " + formatDuration(s.ms),
      }),
    );
    prevEnd = s.start + s.ms;
  }
  return row;
}

/* ---------- 历史 ---------- */

const expanded = new Set<string>();

async function renderHistory(): Promise<void> {
  const root = panels.history;
  clear(root);
  const res = await ask<{ articles: Article[]; speed: SpeedSummary | null }>({ type: "articles:list" });
  const withData = res.articles.filter((a) => a.sessionCount > 0);
  if (withData.length === 0) {
    root.append(empty("还没有记录。打开一篇文章读一会儿就会出现。"));
    return;
  }
  for (const a of withData) root.append(articleItem(a, res.speed ?? null));
}

function articleItem(a: Article, speed: SpeedSummary | null): HTMLElement {
  const pct = a.trackedWords > 0 ? Math.round((a.wordsRead / a.trackedWords) * 100) : 0;
  const wpm = Math.round(wordsPerMinute(a.wordsRead, a.totalMs));
  const item = el("div", { class: "item" });
  // 回合数比片段数更接近"来读了几次"；老记录没有回合字段时只显示片段
  const meta =
    a.episodeCount !== undefined && a.episodeCount > 0
      ? formatDuration(a.totalMs) + " · " + a.episodeCount + " 回合 / " + a.sessionCount + " 段"
      : formatDuration(a.totalMs) + " · " + a.sessionCount + " 段";
  const head = el("div", { class: "item-head" }, [
    el("span", { class: "item-title", title: a.title }, [a.title || a.url]),
    el("span", { class: "item-meta" }, [meta]),
  ]);
  const body = el("div");
  head.addEventListener("click", () => {
    if (expanded.has(a.id)) {
      expanded.delete(a.id);
      clear(body);
    } else {
      expanded.add(a.id);
      void renderSessions(a, body);
    }
  });
  const hostNode = el("div", { class: "item-host" }, [hostnameOf(a.url) + " · 已读 " + pct + "% · " + wpm + " 字/分"]);
  // 没读完的才说还需多久；依据放在 title 里，窄栏放不下一整句
  const left = a.finished ? null : estimateArticle(a, speed);
  if (left && left.words > 0) {
    hostNode.append(" · 还需" + formatEstimate(left.ms));
    hostNode.title = describeBasis(left);
  }
  item.append(head, hostNode, body);
  if (expanded.has(a.id)) void renderSessions(a, body);
  return item;
}

async function renderSessions(a: Article, host: HTMLElement): Promise<void> {
  clear(host);
  const res = await ask<{ sessions: Session[]; paragraphs: ParagraphRecord[] }>({
    type: "article:sessions",
    articleId: a.id,
  });
  if (res.sessions.length === 0) {
    host.append(el("div", { class: "muted small" }, ["没有 session 明细"]));
    return;
  }
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const rows = res.sessions.map((s) => {
    const ms = s.endTs - s.startTs;
    return el("tr", {}, [
      el("td", {}, [fmt.format(new Date(s.startTs))]),
      el("td", {}, [formatDuration(ms)]),
      el("td", {}, [String(s.wordsRead)]),
      el("td", {}, [String(Math.round(wordsPerMinute(s.wordsRead, ms)))]),
      el("td", {}, [el("span", { class: "reason" }, [REASON_LABEL[s.endReason]])]),
    ]);
  });
  host.append(
    el("table", { class: "sessions" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", {}, ["开始"]),
          el("th", {}, ["时长"]),
          el("th", {}, ["字数"]),
          el("th", {}, ["字/分"]),
          el("th", {}, ["结束"]),
        ]),
      ]),
      el("tbody", {}, rows),
    ]),
  );
}

/* ---------- 概览 ---------- */

async function renderOverview(): Promise<void> {
  const root = panels.overview;
  clear(root);
  const o = await ask<Overview>({ type: "stats:overview" });
  root.append(el("h2", {}, ["近 7 天"]));
  if (o.sessionCount === 0) {
    root.append(empty("近 7 天没有记录"));
    return;
  }
  const readingPct = o.totalMs > 0 ? Math.round((o.readingMs / o.totalMs) * 100) : 0;
  root.append(
    kv([
      ["总专注时长", formatDuration(o.totalMs)],
      ["其中读到新内容", formatDuration(o.readingMs) + "（" + readingPct + "%）"],
      ["文章数", String(o.articleCount)],
      ["已读字数", String(o.wordsRead)],
      // 速度只按读到新内容的时间算：回看和停留会把它稀释成一个没有含义的数
      ["阅读速度", Math.round(wordsPerMinute(o.wordsRead, o.readingMs)) + " 字/分"],
    ]),
  );

  // 回合是主指标：session 的边界是"输入信号中断"，量的是两次输入之间的间隔，不是注意力长度
  root.append(
    el("div", { class: "muted small" }, [
      "回合 · 同一篇文章内间隔不超过 " + formatDuration(o.episodeGapMs) + " 的片段合并",
    ]),
  );
  root.append(
    kv([
      ["回合数", String(o.episodeCount)],
      ["回合中位数", formatDuration(o.episodeMedianMs)],
      ["回合 P90", formatDuration(o.episodeP90Ms)],
      ["最长回合", formatDuration(o.longestEpisodeMs)],
    ]),
  );

  root.append(el("div", { class: "muted small" }, ["原始片段 · 供对照"]));
  root.append(
    kv([
      ["片段数", String(o.sessionCount)],
      ["片段中位数", formatDuration(o.medianMs)],
      ["片段 P90", formatDuration(o.p90Ms)],
      ["切换频率", Math.round(o.switchesPerHour) + " 次/时"],
    ]),
  );

  // 结束原因的构成：idle 是"没输入"、blur/hidden 是"切走了"，混在一个分布里没法读
  const reasons = (Object.keys(REASON_LABEL) as EndReason[])
    .filter((r) => o.byReason[r].count > 0)
    .sort((a, b) => o.byReason[b].count - o.byReason[a].count)
    .map((r) => REASON_LABEL[r] + " " + o.byReason[r].count);
  root.append(el("div", { class: "muted small" }, ["结束原因　" + reasons.join("　")]));

  // 只在数据支持时才说话的解读——一句在任何数据下都显示的解读等于没有解读
  for (const line of overviewInsights(o)) root.append(el("p", { class: "muted small" }, [line]));
}

/* ---------- 标签页切换 ---------- */

for (const btn of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".tab")) b.classList.toggle("is-active", b === btn);
    const name = btn.dataset["tab"] as keyof typeof panels;
    for (const [k, p] of Object.entries(panels)) p.toggleAttribute("hidden", k !== name);
    if (name === "history") void renderHistory();
    if (name === "overview") void renderOverview();
  });
}

document.getElementById("open-options")!.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("open-dashboard")!.addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

/**
 * sidePanel.open() 只在**用户手势的同步调用栈**里有效，await 之后再调会被拒。
 * 所以窗口 id 在 popup 打开时就预取好，点击时直接同步用。
 */
let currentWindowId: number | null = null;
void chrome.windows.getCurrent().then((w) => {
  currentWindowId = w.id ?? null;
});

document.getElementById("open-panel")!.addEventListener("click", (e) => {
  e.preventDefault();
  if (currentWindowId === null) return;
  // 同步发起（手势要求），失败只记日志——popup 马上就关了，没地方显示错误
  chrome.sidePanel.open({ windowId: currentWindowId }).catch((err: unknown) => {
    console.warn("[focus-session] 打开侧边栏失败", err);
  });
  window.close();
});

async function refreshCurrent(): Promise<void> {
  renderCurrent(await fetchPageState());
}

void refreshCurrent();
// 本地每秒只是插值，session 可能在 popup 打开期间结束，定期回源校正
setInterval(() => {
  if (!panels.current.hasAttribute("hidden")) void refreshCurrent();
}, 3000);
