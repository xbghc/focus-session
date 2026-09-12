import type { HistoryArticleDecision } from "../lib/articleFilter.ts";
import type { BlacklistSuggestion } from "../lib/articleFilter.ts";
import { matchesUrlRule } from "../lib/url.ts";
import type { Settings } from "../types.ts";
import type {
  Article,
  ArticleReviewOutcome,
  ArticleReviewState,
  ArticleReviewView,
  ReviewCardView,
  ReviewStats,
  Snippet,
  SpeedSummary,
} from "../types.ts";
import { formatDuration } from "../lib/stats.ts";
import { describeBasis, estimateArticle, formatEstimate } from "../lib/readingTime.ts";
import { hostnameOf } from "../lib/url.ts";
import { fillMeta } from "../lib/speak.ts";
import { BOOKS_KEY, parseChapterId, type Book } from "../books/types.ts";
import { localStorage } from "../sync/storage.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const send = <T,>(msg: unknown): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;

/** 文本一律走 textContent 写入：标题和译文都来自网页/模型，绝不能拼进 innerHTML。 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const fmtDate = (ts: number): string =>
  new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });

/* ==================== 标签页切换 ==================== */

const PANES = ["articles", "review", "words"] as const;
type Pane = (typeof PANES)[number];

/** load=false 用于「队列已经装好了，只是切个面板」，见 openArticleReview。 */
function show(pane: Pane, load = true): void {
  for (const p of PANES) {
    $(`pane-${p}`).hidden = p !== pane;
    document.querySelector(`.tab[data-tab="${p}"]`)?.classList.toggle("active", p === pane);
  }
  location.hash = pane;
  if (!load) return;
  if (pane === "review") void loadReview();
  if (pane === "words") void loadWords();
  if (pane === "articles") void loadArticles();
}

for (const btn of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  btn.addEventListener("click", () => show(btn.dataset["tab"] as Pane));
}
$("to-options").addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});

/* ==================== 文章 ==================== */

let articles: Article[] = [];
/**
 * 书目。App 里才有；扩展那边这个键永远是空的，下面那段分组也就永远不进。
 * 章的阅读记录和文章是同一种东西，只是列表上折成一行，免得一本书把整页刷满。
 */
let books: Record<string, Book> = {};
const selectedArticles = new Set<string>();
let managingArticles = false;
let visibleArticles: Article[] = [];
let articleActionBusy = false;
type Classification = HistoryArticleDecision | { status: "pending" | "running" | "stopped" };
const classifications = new Map<string, Classification>();
let classificationRunning = false;
let stopClassification = false;
$("manage-articles").addEventListener("click", () => {
  managingArticles = !managingArticles;
  if (!managingArticles) selectedArticles.clear();
  updateArticleSelection();
  for (const checkbox of document.querySelectorAll<HTMLInputElement>('#articles .row1 > input[type="checkbox"]')) {
    checkbox.hidden = !managingArticles;
    checkbox.inert = !managingArticles;
    if (!managingArticles) {
      checkbox.checked = false;
      checkbox.closest(".article-card")?.classList.remove("selected");
    }
  }
});
/** 个人阅读速度的摘要，和文章列表一起取回，估每篇「还需多久」用。 */
let speed: SpeedSummary | null = null;

async function loadArticles(): Promise<void> {
  const res = await send<{ articles: Article[]; speed?: SpeedSummary | null }>({ type: "articles:list" });
  articles = res.articles ?? [];
  // 走 localStorage() 而不是 chrome.storage.local：App 里数据在同步库那一份下，
  // 扩展的这个页面没装过垫片，退回真正的 chrome.storage.local——那边本来就没有书。
  books = ((await localStorage().get(BOOKS_KEY))[BOOKS_KEY] ?? {}) as Record<string, Book>;
  for (const id of selectedArticles) if (!articles.some(a => a.id === id)) selectedArticles.delete(id);
  for (const id of classifications.keys()) if (!articles.some(a => a.id === id)) classifications.delete(id);
  speed = res.speed ?? null;
  renderArticles();
}

function renderArticles(): void {
  const q = $<HTMLInputElement>("q-article").value.trim().toLowerCase();
  const filter = $<HTMLSelectElement>("finish-filter").value;
  /*
   * 书里的章不在这份列表里露面——它们在书架那一栏按书折成一行，
   * 否则一本四十节的书能把整页刷满。记录本身还是一章一条，只是不在这儿逐条摆出来。
   * 扩展里 books 永远是空的，这几行等于不存在。
   */
  const shelved = (a: Article): boolean => Boolean(books[parseChapterId(a.id)?.bookId ?? ""]);
  const loose = articles.filter((a) => !shelved(a));
  const list = loose.filter((a) => {
    if (filter === "done" && !a.finished) return false;
    if (filter === "reading" && a.finished) return false;
    if (!q) return true;
    return a.title.toLowerCase().includes(q) || a.url.toLowerCase().includes(q);
  });

  visibleArticles = list;
  updateArticleSelection();
  const done = loose.filter((a) => a.finished).length;
  const chapters = articles.length - loose.length;
  $("article-summary").textContent = `共 ${loose.length} 篇，读完 ${done} 篇`
    + (chapters > 0 ? ` · 另有 ${chapters} 节在书架上` : "");

  const box = $("articles");
  box.textContent = "";
  if (list.length === 0) {
    box.append(el("div", "empty", loose.length ? "没有匹配的文章" : "还没有阅读记录"));
    return;
  }

  for (const a of list) {
    const card = el("div", "card article-card");
    const row = el("div", "row1");

    const title = el("div", "title");
    const link = el("a", undefined, a.title || a.url);
    link.href = a.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    title.append(link);

    const ratio = a.trackedWords > 0 ? Math.min(1, a.wordsRead / a.trackedWords) : 0;
    const pill = el("span", `pill${a.finished ? " done" : ""}`, a.finished ? "读完" : `${Math.round(ratio * 100)}%`);

    const toggle = el("button", "mini", a.finished ? "标记未读完" : "标记读完");
    toggle.addEventListener("click", async () => {
      const r = await send<{ ok: boolean; article: Article | null }>({
        type: "article:finish",
        articleId: a.id,
        finished: !a.finished,
      });
      if (r.article) {
        Object.assign(a, r.article);
        renderArticles();
      }
    });

    const select = el("input");
    select.type = "checkbox";
    select.hidden = !managingArticles;
    select.inert = !managingArticles;
    select.checked = selectedArticles.has(a.id);
    select.disabled = articleActionBusy;
    select.setAttribute("aria-label", "选择 " + (a.title || a.url));
    select.addEventListener("change", () => {
      if (select.checked) selectedArticles.add(a.id); else selectedArticles.delete(a.id);
      card.classList.toggle("selected", select.checked);
      updateArticleSelection();
    });
    row.append(select, title, pill);
    // 读完了才有回顾卡；没读完的文章连正文都未必存下来了
    if (a.finished) {
      const rev = el("button", "mini", "回顾");
      rev.addEventListener("click", () => void openArticleReview(a.id));
      row.append(rev);
    }
    toggle.classList.add("reading-action");
    row.append(toggle);

    const sub = el("div", "sub");
    sub.append(
      el("span", undefined, hostnameOf(a.url)),
      el("span", undefined, `${a.wordsRead} / ${a.trackedWords} 字`),
      el("span", undefined, formatDuration(a.totalMs)),
      el("span", undefined, `${a.sessionCount} 段专注`),
      el("span", undefined, `最近 ${fmtDate(a.lastSeenTs)}`),
    );
    if (!a.reachedBottom && !a.finished) sub.append(el("span", undefined, "未读到末尾"));
    // 没读完的说一句还需多久；依据挂在 title 上，悬停可见
    if (!a.finished) {
      const left = estimateArticle(a, speed);
      if (left && left.words > 0) {
        const span = el("span", undefined, "还需" + formatEstimate(left.ms));
        span.title = describeBasis(left);
        sub.append(span);
      }
    }

    const bar = el("div", "progress");
    const fill = el("i");
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    bar.append(fill);

    card.append(row, sub, bar);
    const classification = classifications.get(a.id);
    if (classification) {
      const result = el("div", "classification-result");
      card.classList.add("has-classification");
      if ("status" in classification) result.textContent = classification.status === "pending" ? "LLM：等待判别" : classification.status === "running" ? "LLM：正在判别…" : "LLM：已停止，尚未判别";
      else {
        result.classList.add(classification.ok ? classification.isArticle ? "is-article" : "not-article" : "failed");
        result.append(el("strong", undefined, classification.ok ? classification.isArticle ? "LLM：是文章" : "LLM：非文章" : "LLM：判别失败"),
          el("p", undefined, classification.reason));
        if (classification.ok) result.append(el("span", "muted small", classification.source === "saved" ? "依据：已存正文" : "依据：重新抓取的网页"));
      }
      card.append(result);
    }
    card.classList.toggle("selected", selectedArticles.has(a.id));
    box.append(card);
  }
}

$("q-article").addEventListener("input", renderArticles);
$("finish-filter").addEventListener("change", renderArticles);

function updateArticleSelection(): void {
  $("article-search").hidden = managingArticles;
  $("article-search").inert = managingArticles;
  $("article-actions").hidden = !managingArticles;
  $("article-actions").inert = !managingArticles;
  $("pane-articles").classList.toggle("managing-articles", managingArticles);
  $("manage-articles").textContent = managingArticles ? "完成" : "批量管理";
  $("manage-articles").setAttribute("aria-pressed", String(managingArticles));
  $("selection-count").textContent = `已选 ${selectedArticles.size} 篇`;
  const all = $<HTMLInputElement>("select-articles");
  const n = visibleArticles.filter(a => selectedArticles.has(a.id)).length;
  all.checked = n > 0 && n === visibleArticles.length;
  all.indeterminate = n > 0 && n < visibleArticles.length;
  all.disabled = articleActionBusy || !visibleArticles.length;
  for (const id of ["delete-articles", "suggest-blacklist", "classify-articles"]) {
    $<HTMLButtonElement>(id).disabled = articleActionBusy || !selectedArticles.size;
  }
  renderClassificationProgress();
}

function renderClassificationProgress(): void {
  $("classification-panel").hidden = classifications.size === 0;
  const values = [...classifications.values()];
  const done = values.filter(v => "ok" in v);
  const nonarticles = done.filter(v => "ok" in v && v.ok && !v.isArticle).length;
  const failed = done.filter(v => "ok" in v && !v.ok).length;
  const stopped = values.filter(v => "status" in v && v.status === "stopped").length;
  $("classification-progress").textContent = `${classificationRunning ? "筛选中" : "筛选结束"}：已处理 ${done.length} / ${values.length} 篇，其中非文章 ${nonarticles} 篇，失败 ${failed} 篇${stopped ? `，未处理 ${stopped} 篇` : ""}。`;
  $<HTMLButtonElement>("select-nonarticles").disabled = articleActionBusy || !visibleArticles.some(a => {
    const result = classifications.get(a.id); return result && "ok" in result && result.ok && !result.isArticle;
  });
  $<HTMLButtonElement>("retry-classification").disabled = articleActionBusy || !failed;
  $("stop-classification").hidden = !classificationRunning;
  $<HTMLButtonElement>("stop-classification").disabled = stopClassification;
}

async function classifySelected(ids: string[]): Promise<void> {
  if (articleActionBusy || !ids.length) return;
  classificationRunning = true;
  stopClassification = false;
  for (const id of ids) classifications.set(id, { status: "pending" });
  await articleAction(async () => {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!stopClassification && next < ids.length) {
        const id = ids[next++]!;
        classifications.set(id, { status: "running" }); renderArticles();
        try {
          const result = await send<HistoryArticleDecision>({ type: "article:classify-history", articleId: id });
          if (!result || typeof result.ok !== "boolean" || (result.ok && typeof result.isArticle !== "boolean")) throw new Error("判别响应无效，请重试");
          classifications.set(id, result);
        } catch (err) { classifications.set(id, { ok: false, reason: err instanceof Error ? err.message : String(err) }); }
        renderArticles();
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker)); }
    finally {
      for (const id of ids) if ((classifications.get(id) as { status?: string })?.status === "pending") classifications.set(id, { status: "stopped" });
      classificationRunning = false;
    }
  });
}

$("classify-articles").addEventListener("click", () => void classifySelected([...selectedArticles]));
$("stop-classification").addEventListener("click", () => { stopClassification = true; renderClassificationProgress(); });
$("retry-classification").addEventListener("click", () => void classifySelected([...classifications].flatMap(([id, result]) => "ok" in result && !result.ok ? [id] : [])));
$("select-nonarticles").addEventListener("click", () => {
  managingArticles = true;
  selectedArticles.clear();
  for (const a of visibleArticles) {
    const result = classifications.get(a.id);
    if (result && "ok" in result && result.ok && !result.isArticle) selectedArticles.add(a.id);
  }
  renderArticles();
});

$("select-articles").addEventListener("change", () => {
  const checked = $<HTMLInputElement>("select-articles").checked;
  for (const a of visibleArticles) {
    if (checked) selectedArticles.add(a.id); else selectedArticles.delete(a.id);
  }
  renderArticles();
});

async function articleAction(work: () => Promise<void>): Promise<void> {
  articleActionBusy = true;
  renderArticles();
  try { await work(); }
  catch (err) { $("article-action-status").textContent = "操作失败：" + (err instanceof Error ? err.message : String(err)); }
  finally { articleActionBusy = false; renderArticles(); }
}

$("delete-articles").addEventListener("click", () => {
  const ids = [...selectedArticles];
  if (!ids.length || !confirm(`删除所选 ${ids.length} 篇文章及其阅读记录、正文、回顾卡？划词记录和生词卡会保留。此操作不可撤销。`)) return;
  void articleAction(async () => {
    const res = await send<{ ok: boolean; deleted: number }>({ type: "articles:delete", articleIds: ids });
    if (!res.ok) throw new Error("删除失败");
    for (const id of ids) selectedArticles.delete(id);
    $("article-action-status").textContent = `已删除 ${res.deleted} 篇文章`;
    await loadArticles();
  });
});

$("suggest-blacklist").addEventListener("click", () => {
  const ids = [...selectedArticles];
  void articleAction(async () => {
    $("article-action-status").textContent = "LLM 正在根据所选记录的网址和标题提出建议…";
    const res = await send<{ ok: boolean; suggestions?: BlacklistSuggestion[]; error?: string }>({ type: "articles:blacklist-suggest", articleIds: ids });
    if (!res.ok) throw new Error(res.error || "生成失败");
    const box = $("blacklist-suggestions");
    const section = $<HTMLDetailsElement>("blacklist-section");
    section.hidden = false; section.open = true;
    box.textContent = "";
    const choices: { input: HTMLInputElement; pattern: string }[] = [];
    for (const suggestion of res.suggestions ?? []) {
      const row = el("label", "card suggestion");
      const input = el("input"); input.type = "checkbox";
      const matches = articles.filter(a => matchesUrlRule(a.url, suggestion.pattern)).length;
      row.append(input, el("strong", undefined, suggestion.pattern), el("p", undefined, suggestion.reason),
        el("p", "muted small", `匹配现有 ${matches} 条记录；采用后阻止后续记录，不删除已有文章，不影响翻译。`));
      choices.push({ input, pattern: suggestion.pattern });
      box.append(row);
    }
    $("article-action-status").textContent = choices.length ? "请勾选要采用的建议。" : "没有足够依据提出黑名单建议。";
    if (!choices.length) return;
    const apply = el("button", undefined, "采用勾选建议");
    apply.addEventListener("click", () => {
      const rules = choices.filter(c => c.input.checked).map(c => c.pattern);
      if (!rules.length) return;
      apply.disabled = true;
      void articleAction(async () => {
        const settings = await send<Settings>({ type: "settings:get" });
        await send({ type: "settings:set", settings: { articleExcludedUrls: [...new Set([...settings.articleExcludedUrls, ...rules])] } });
        box.textContent = "";
        section.hidden = true;
        $("article-action-status").textContent = `已采用 ${rules.length} 条文章记录黑名单建议`;
      }).finally(() => { apply.disabled = false; });
    });
    box.append(apply);
  });
});


/* ==================== 生词本 ==================== */

let snippets: Snippet[] = [];

async function loadWords(): Promise<void> {
  const res = await send<{ snippets: Snippet[] }>({ type: "snippets:list" });
  snippets = res.snippets ?? [];
  renderWords();
}

const KIND_LABEL: Record<Snippet["kind"], string> = { word: "单词", phrase: "短语", sentence: "句子" };

function renderWords(): void {
  const q = $<HTMLInputElement>("q-word").value.trim().toLowerCase();
  const kind = $<HTMLSelectElement>("kind-filter").value;
  const list = snippets.filter((s) => {
    if (kind && s.kind !== kind) return false;
    if (!q) return true;
    return (
      s.text.toLowerCase().includes(q) ||
      s.translation.toLowerCase().includes(q) ||
      s.articleTitle.toLowerCase().includes(q)
    );
  });

  const queued = snippets.filter((s) => s.cardId).length;
  $("word-summary").textContent = `共 ${snippets.length} 条，其中 ${queued} 条在复习队列`;

  const box = $("words");
  box.textContent = "";
  if (list.length === 0) {
    box.append(el("div", "empty", snippets.length ? "没有匹配的记录" : "还没有划词记录"));
    return;
  }

  for (const s of list) {
    const card = el("div", "card");
    const row = el("div", "row1");
    row.append(el("div", "title", s.text), el("span", "pill", KIND_LABEL[s.kind]));

    if (s.cardId) {
      row.append(el("span", "pill done", "在复习"));
    } else {
      // 整句默认不排期，但用户可以手动捞进来
      const add = el("button", "mini", "加入复习");
      add.addEventListener("click", async () => {
        await send({ type: "snippet:enqueue", id: s.id });
        await loadWords();
      });
      row.append(add);
    }

    const del = el("button", "mini danger", "删除");
    del.addEventListener("click", async () => {
      await send({ type: "snippet:delete", id: s.id });
      await loadWords();
    });
    row.append(del);

    const tr = el("div", undefined, s.translation);
    tr.style.margin = "5px 0 2px";

    const sub = el("div", "sub");
    const meta = el("span");
    if (fillMeta(meta, { phonetic: s.phonetic, pos: s.pos, word: s.text })) sub.append(meta);
    const from = el("a", undefined, s.articleTitle || hostnameOf(s.url));
    from.href = s.url;
    from.target = "_blank";
    from.rel = "noreferrer";
    from.style.color = "inherit";
    sub.append(from, el("span", undefined, fmtDate(s.createdTs)));

    card.append(row, tr);
    if (s.contextNote) {
      const note = el("div", "sub", s.contextNote);
      note.style.display = "block";
      card.append(note);
    }
    if (s.usage) card.append(el("div", "usage", s.usage));
    if (s.vocab.length > 0) {
      const box = el("div", "vocab");
      for (const v of s.vocab) {
        const one = el("div", "v");
        const head = el("div");
        head.append(el("span", "vw", v.word));
        const m = el("span", "vm");
        if (fillMeta(m, { phonetic: v.phonetic, pos: v.pos, word: v.word })) head.append(m);
        one.append(head, el("div", "vd", v.meaning));
        if (v.note) one.append(el("div", "vn", v.note));
        box.append(one);
      }
      card.append(box);
    }
    card.append(sub);
    box.append(card);
  }
}

$("q-word").addEventListener("input", renderWords);
$("kind-filter").addEventListener("change", renderWords);

/* ==================== 复习 ==================== */

/**
 * 复习页下面挂着两个独立队列。刻意不交错渲染：
 * 生词卡是一个词，文章卡是一整篇，翻卡的节奏完全不同，混在一起两边都难受。
 */
type Queue = "words" | "articles";
let queueKind: Queue = "words";

/** 导航上的红点是两个队列之和。 */
let dueWords = 0;
let dueArticles = 0;

function paintBadge(): void {
  const total = dueWords + dueArticles;
  const badge = $("due-badge");
  badge.textContent = String(total);
  badge.hidden = total === 0;
  $("seg-words-n").textContent = dueWords > 0 ? String(dueWords) : "";
  $("seg-articles-n").textContent = dueArticles > 0 ? String(dueArticles) : "";
}

function setQueue(k: Queue, load = true): void {
  queueKind = k;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg")) {
    b.classList.toggle("active", b.dataset["queue"] === k);
  }
  if (load) void loadReview();
}

for (const btn of document.querySelectorAll<HTMLButtonElement>(".seg")) {
  btn.addEventListener("click", () => setQueue(btn.dataset["queue"] as Queue));
}

let queue: ReviewCardView[] = [];
let cursor = 0;
let revealed = false;

async function loadReview(): Promise<void> {
  if (queueKind === "articles") return loadArticleQueue();
  const res = await send<{ cards: ReviewCardView[]; stats: ReviewStats }>({ type: "review:due", limit: 60 });
  queue = res.cards ?? [];
  cursor = 0;
  revealed = false;
  renderStats(res.stats, "words");
  renderReview();
}

function renderStats(s: ReviewStats, kind: Queue): void {
  const box = $("review-stats");
  box.textContent = "";
  const add = (n: number | string, label: string): void => {
    const stat = el("div", "stat");
    stat.append(el("b", undefined, String(n)), el("span", undefined, label));
    box.append(stat);
  };
  add(s.dueNow, kind === "words" ? "待复习" : "待回顾");
  add(s.total, kind === "words" ? "卡片总数" : "文章总数");
  add(s.newCount, "新的");
  add(s.learningCount, "学习中");
  add(s.reviewCount, "已进入复习");
  add(s.forecast.slice(1).reduce((a, b) => a + b, 0), "未来 6 天到期");

  if (kind === "words") dueWords = s.dueNow;
  else dueArticles = s.dueNow;
  paintBadge();
}

function renderReview(): void {
  if (queueKind === "articles") {
    renderArticleReview();
    return;
  }
  const area = $("review-area");
  area.textContent = "";

  const item = queue[cursor];
  if (!item) {
    area.append(
      el("div", "empty", queue.length === 0 ? "现在没有到期的卡片。去读点文章、划几个生词吧。" : "这一轮复习完了 🎉"),
    );
    return;
  }

  const wrap = el("div", "reviewer");
  const face = el("div", "face");
  const s = item.snippet;

  face.append(el("div", "word", item.card.key));
  if (s?.phonetic) {
    const phon = el("div", "phon");
    // 念 s.text 而不是卡面上的 item.card.key：卡面是词元（leak），音标配的是原形式（leaks）
    fillMeta(phon, { phonetic: s.phonetic, pos: s.pos, word: s.text }, "  ");
    face.append(phon);
  }

  if (!revealed) {
    face.append(el("div", "note", `出现在 ${item.articleCount} 篇文章 · 复习 ${item.card.reps} 次`));
    wrap.append(face);
    const showBtn = el("button", "mini", "显示答案（空格）");
    showBtn.style.marginTop = "14px";
    showBtn.addEventListener("click", reveal);
    wrap.append(showBtn);
  } else {
    face.append(el("div", "answer", s?.translation ?? "（这条记录已被删除）"));
    if (s?.contextNote) face.append(el("div", "note", s.contextNote));
    if (s) {
      const src = el("div", "src");
      src.append(...highlight(s.context || s.text, s.text));
      const from = el("div");
      from.style.marginTop = "5px";
      from.append(el("span", undefined, `—— ${s.articleTitle || hostnameOf(s.url)}`));
      src.append(from);
      face.append(src);
    }
    wrap.append(face, gradeBar(item), assistBar(item));
  }

  area.append(wrap);
}

/** 在原句里把当初划中的部分标出来，比单看一个词更容易想起当时的语境。 */
function highlight(context: string, term: string): Node[] {
  const at = context.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return [document.createTextNode(context)];
  const em = el("em", undefined, context.slice(at, at + term.length));
  return [
    document.createTextNode(context.slice(0, at)),
    em,
    document.createTextNode(context.slice(at + term.length)),
  ];
}

const GRADES: Array<{ g: 1 | 2 | 3 | 4; label: string; key: string }> = [
  { g: 1, label: "忘了", key: "1" },
  { g: 2, label: "有点难", key: "2" },
  { g: 3, label: "记得", key: "3" },
  { g: 4, label: "太简单", key: "4" },
];

function gradeBar(item: ReviewCardView): HTMLElement {
  const bar = el("div", "grades");
  for (const { g, label, key } of GRADES) {
    const btn = el("button");
    btn.append(document.createTextNode(label), el("small", undefined, key));
    btn.addEventListener("click", () => void grade(item, g));
    bar.append(btn);
  }
  return bar;
}

async function grade(item: ReviewCardView, g: 1 | 2 | 3 | 4): Promise<void> {
  await send({ type: "review:grade", cardId: item.card.id, grade: g });
  cursor += 1;
  revealed = false;
  renderReview();
  // 评分会改变到期分布，顺手刷新一下顶部统计
  const stats = await send<ReviewStats>({ type: "review:stats" });
  renderStats(stats, "words");
}

/** 翻卡本身不花 token（用的是划词时存下的内容），这几个按钮才会调 LLM。 */
function assistBar(item: ReviewCardView): HTMLElement {
  const box = el("div", "assist");
  const bar = el("div", "bar");
  const out = el("div", "out");
  out.hidden = true;

  const modes: Array<{ mode: "example" | "explain" | "quiz"; label: string }> = [
    { mode: "example", label: "再给个例句" },
    { mode: "explain", label: "换个说法讲" },
    { mode: "quiz", label: "考我一下" },
  ];
  for (const { mode, label } of modes) {
    const btn = el("button", "mini", label);
    btn.addEventListener("click", async () => {
      out.hidden = false;
      out.textContent = "正在问 MiniMax…";
      for (const b of bar.querySelectorAll("button")) b.disabled = true;
      const res = await send<{ ok: boolean; text?: string; error?: string; needsConfig?: boolean }>({
        type: "review:assist",
        cardId: item.card.id,
        mode,
      });
      out.textContent = res.ok
        ? (res.text ?? "")
        : res.needsConfig
          ? "还没配置 MiniMax API Key，去「设置」里填。"
          : `失败：${res.error ?? "未知错误"}`;
      for (const b of bar.querySelectorAll("button")) b.disabled = false;
    });
    bar.append(btn);
  }
  box.append(bar, out);
  return box;
}

function reveal(): void {
  revealed = true;
  renderReview();
}

// 键盘流：空格翻面，1-4 评分。复习时手不用离开键盘。
document.addEventListener("keydown", (e) => {
  if ($("pane-review").hidden) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const onArticles = queueKind === "articles";
  const item = onArticles ? aQueue[aCursor] : queue[cursor];
  if (!item) return;
  const open = onArticles ? aRevealed : revealed;

  if (e.code === "Space") {
    e.preventDefault();
    if (!open) (onArticles ? revealArticle : reveal)();
    return;
  }
  if (!open) return;
  const hit = GRADES.find((x) => x.key === e.key);
  if (!hit) return;
  e.preventDefault();
  if (onArticles) void gradeArticle(item as ArticleReviewView, hit.g);
  else void grade(item as ReviewCardView, hit.g);
});

/* ==================== 文章回顾 ==================== */

let aQueue: ArticleReviewView[] = [];
let aCursor = 0;
let aRevealed = false;

async function loadArticleQueue(): Promise<void> {
  const res = await send<{ items: ArticleReviewView[]; stats: ReviewStats }>({
    type: "article:review-due",
    limit: 30,
  });
  aQueue = res.items ?? [];
  aCursor = 0;
  aRevealed = false;
  renderStats(res.stats, "articles");
  renderArticleReview();
}

/** 打开某一篇的回顾：装好这一篇就切过去，不要被队列的自动加载覆盖。 */
async function openArticleReview(articleId: string): Promise<void> {
  const res = await send<{ items: ArticleReviewView[]; stats: ReviewStats }>({
    type: "article:review-due",
    articleId,
  });
  if (res.items.length === 0) {
    // 没有卡的原因不止一种，问清楚再说——直接退回队列会让人一头雾水
    setQueue("articles", false);
    show("review", false);
    const st = await send<ArticleReviewState>({ type: "article:review-state", articleId });
    renderNoCard(st);
    return;
  }
  aQueue = res.items;
  aCursor = 0;
  aRevealed = false;
  setQueue("articles", false);
  show("review", false);
  renderStats(res.stats, "articles");
  renderArticleReview();
}

/** 点了「回顾」却没有卡：说清是哪一种情况，以及该怎么办。 */
function renderNoCard(st: ArticleReviewState): void {
  const area = $("review-area");
  area.textContent = "";
  aQueue = [];
  const msg = !st.finished
    ? "这篇还没读完。读完之后它会自动进入回顾队列。"
    : st.hasText
      ? "这篇的回顾材料还在准备中，过一会儿再来。"
      : "这篇是在「文章回顾」上线之前读完的，当时没有保存正文，没法生成回顾材料。重新读一遍（读到已读比例阈值就行）会自动备好。";
  area.append(el("div", "empty", msg));
}

function renderArticleReview(): void {
  const area = $("review-area");
  area.textContent = "";

  const item = aQueue[aCursor];
  if (!item) {
    const msg =
      aQueue.length === 0 ? "现在没有到期的文章。读完一篇，过几天它会出现在这里。" : "这一轮回顾完了 🎉";
    area.append(el("div", "empty", msg));
    return;
  }

  const a = item.article;
  const wrap = el("div", "reviewer wide");
  const face = el("div", "face");

  face.append(el("div", "atitle", a.title || a.url));
  const bits = [hostnameOf(a.url)];
  if (a.finishedTs) bits.push(`读完于 ${fmtDate(a.finishedTs)}`);
  bits.push(`${a.sessionCount} 段专注`, formatDuration(a.totalMs));
  if (item.card.reps > 0) bits.push(`回顾 ${item.card.reps} 次`);
  face.append(el("div", "ameta", bits.join(" · ")));

  const r = item.review;
  if (!r) {
    face.append(el("div", "note", "还没有这篇的回顾材料。"));
    wrap.append(face, articleTools(item, false));
  } else if (!aRevealed) {
    // 先自己想，再翻开对答案——比直接读摘要记得牢
    if (r.questions.length > 0) {
      face.append(el("div", "lead", "先自己想一想"));
      const ol = el("ol", "qs");
      for (const q of r.questions) ol.append(el("li", undefined, q));
      face.append(ol);
    } else {
      face.append(el("div", "note", "这篇没生成回想问题，直接看大纲吧。"));
    }
    wrap.append(face);
    const btn = el("button", "mini", "翻开看大纲（空格）");
    btn.style.marginTop = "14px";
    btn.addEventListener("click", revealArticle);
    wrap.append(btn);
  } else {
    face.append(el("div", "lead", "这篇讲了什么"));
    const ol = el("ol", "ol");
    for (const line of r.outline) ol.append(el("li", undefined, line));
    face.append(ol);
    wrap.append(face, articleGradeBar(item), articleTools(item, true));
  }

  area.append(wrap);
}

function revealArticle(): void {
  aRevealed = true;
  renderArticleReview();
}

function articleGradeBar(item: ArticleReviewView): HTMLElement {
  const bar = el("div", "grades");
  for (const { g, label, key } of GRADES) {
    const btn = el("button");
    btn.append(document.createTextNode(label), el("small", undefined, key));
    btn.addEventListener("click", () => void gradeArticle(item, g));
    bar.append(btn);
  }
  return bar;
}

async function gradeArticle(item: ArticleReviewView, g: 1 | 2 | 3 | 4): Promise<void> {
  await send({ type: "article:review-grade", articleId: item.article.id, grade: g });
  aCursor += 1;
  aRevealed = false;
  renderArticleReview();
  // 评分改变了到期分布，重取统计而不是自己减——和生词那边一致
  const res = await send<{ stats: ReviewStats }>({ type: "article:review-due", limit: 0 });
  renderStats(res.stats, "articles");
}

/** 打开原文 + 生成/重新生成。这两个按钮是这一页唯一会花 token 的地方。 */
function articleTools(item: ArticleReviewView, has: boolean): HTMLElement {
  const box = el("div", "assist");
  const bar = el("div", "bar");
  const out = el("div", "out");
  out.hidden = true;

  const open = el("button", "mini", "打开原文");
  open.addEventListener("click", () => window.open(item.article.url, "_blank", "noreferrer"));

  const gen = el("button", "mini", has ? "重新生成" : "生成回顾材料");
  gen.addEventListener("click", async () => {
    out.hidden = false;
    out.textContent = "正在通读原文并整理…这一步要十几秒。";
    for (const b of bar.querySelectorAll("button")) b.disabled = true;
    const res = await send<ArticleReviewOutcome>({
      type: "article:review",
      articleId: item.article.id,
      regenerate: has,
    });
    for (const b of bar.querySelectorAll("button")) b.disabled = false;
    if (res.ok && res.review) {
      item.review = res.review;
      aRevealed = false;
      renderArticleReview();
      return;
    }
    out.textContent = res.noText
      ? "这篇的正文没有存下来——文章回顾是后来才加的功能，之前读过的文章没赶上。重新读一遍就会存下。"
      : res.needsConfig
        ? "还没配置 MiniMax API Key，去「设置」里填。"
        : `失败：${res.error ?? "未知错误"}`;
  });

  bar.append(open, gen);
  box.append(bar, out);
  return box;
}

/* ==================== 启动 ==================== */

/*
 * hash 形如 `#review` 或 `#review:<articleId>`——后者是 popup 的「去回顾」直达。
 * articleId 本身是 URL，里面就有冒号，所以只按**第一个**冒号切。
 */
const raw = location.hash.slice(1);
const sep = raw.indexOf(":");
const initial = (sep < 0 ? raw : raw.slice(0, sep)) as Pane;
const target = sep < 0 ? "" : decodeURIComponent(raw.slice(sep + 1));

if (initial === "review" && target) {
  show("review", false);
  void openArticleReview(target);
} else {
  show(PANES.includes(initial) ? initial : "articles");
}
// 无论进哪个标签页，先把两个队列的待办数取回来标在导航上
void (async () => {
  const [w, a] = await Promise.all([
    send<ReviewStats>({ type: "review:stats" }),
    // limit 0：只要统计，不必把整个队列拖回来
    send<{ items: ArticleReviewView[]; stats: ReviewStats }>({ type: "article:review-due", limit: 0 }),
  ]);
  dueWords = w.dueNow;
  dueArticles = a.stats.dueNow;
  paintBadge();
})();
