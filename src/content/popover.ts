import type { PartialTranslation, Snippet, VocabNote } from "../types.ts";
import { fillMeta, stopSpeaking } from "../lib/speak.ts";

/**
 * 选区旁的翻译浮层。
 *
 * 整个 UI 装在 **Shadow DOM** 里：宿主页面的 CSS 五花八门，`* { box-sizing }`、
 * 全局 `p { margin }`、乃至给所有元素加 `!important` 的站点都存在，
 * 不隔离的话浮层在不同网站上会长得完全不一样。用 closed 模式，
 * 页面脚本也拿不到里面的内容。
 *
 * 配色与扩展其余部分同一套纸墨系统，顶部一道赭线呼应索引卡。
 * 拉丁衬线是扩展自带的（见 FONT_FACES），中文交给系统宋体。
 */

const HOST_ID = "focus-session-popover";
const MARGIN = 8;

/*
 * 字体 URL 只能在运行时拼：Shadow DOM 里的 `url()` 是相对宿主页面解析的，
 * 必须是绝对的 chrome-extension:// 地址，而扩展 id 每次安装都不同。
 * manifest 的 web_accessible_resources 放行了 fonts/*.woff2，否则宿主页面
 * 取这个地址会被拒。
 *
 * 代价：任何网页都能通过探测这个地址判断出装了本扩展。对一个自用的阅读工具
 * 来说这点指纹无所谓，换来的是浮层和扩展其余部分字体一致。
 */
const FONT_FACES = `
@font-face {
  font-family: "Source Serif 4";
  font-style: normal; font-weight: 400; font-display: swap;
  src: url("__FONTS__source-serif-4-latin-400-normal.woff2") format("woff2");
}
@font-face {
  font-family: "Source Serif 4";
  font-style: normal; font-weight: 600; font-display: swap;
  src: url("__FONTS__source-serif-4-latin-600-normal.woff2") format("woff2");
}
@font-face {
  font-family: "Source Serif 4";
  font-style: italic; font-weight: 400; font-display: swap;
  src: url("__FONTS__source-serif-4-latin-400-italic.woff2") format("woff2");
}
`;

const CSS = `
:host { all: initial; }
.box {
  position: fixed;
  z-index: 2147483647;
  /* 手机屏幕比 380px 窄：两边各留 8px，别顶穿视口 */
  max-width: min(380px, calc(100vw - 16px));
  min-width: min(220px, calc(100vw - 16px));
  /* 讲解能有五条，长句加满就是大半屏。给个上限让它自己滚，别顶穿视口 */
  max-height: min(70vh, 520px);
  overflow-y: auto;
  box-sizing: border-box;
  padding: 12px 14px;
  border-radius: 3px;
  border: 1px solid #e0d8cb;
  border-top: 3px solid #a4551f;
  background: #fffdfa;
  color: #1f1b16;
  box-shadow: 0 1px 2px rgba(31, 27, 22, 0.06), 0 10px 28px rgba(31, 27, 22, 0.12);
  font: 14px/1.7 "Source Serif 4", Georgia, "Songti SC", "Noto Serif CJK SC", "SimSun", serif;
  overflow-wrap: break-word;
}
@media (prefers-color-scheme: dark) {
  .box { background: #262220; color: #e8e0d5; border-color: #332f2a; border-top-color: #e18d5a; }
  .meta, .vm, .vn { color: #9a8f7f; }
  .ph { border-bottom-color: #6b6053; }
  .ph:hover { color: #e18d5a; border-bottom-color: #e18d5a; }
  .note, .usage, .vd { color: #bdb3a4; }
  .usage::before { color: #9a8f7f; }
  .ctx, .vocab { border-top-color: #2b2724; }
  button { background: #1c1917; color: #bdb3a4; border-color: #3d3833; }
  button:hover { background: #332f2a; color: #e18d5a; border-color: #e18d5a; }
}
.head { display: flex; align-items: baseline; gap: 9px; margin-bottom: 5px; }
.term { font-weight: 600; font-size: 17px; letter-spacing: -0.01em; }
/* 注脚一律无衬线，和 popup / dashboard 同一套分工 */
.meta {
  color: #6f6558; font-size: 11.5px;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.tr { font-size: 16px; margin: 3px 0 6px; }
.note { color: #4a4238; font-size: 13px; line-height: 1.85; }
.ctx { margin-top: 10px; padding-top: 8px; border-top: 1px solid #eee7dc; display: flex; gap: 7px; flex-wrap: wrap; }

/* ---- 讲解：用法一行，生词逐条 ---- */
.usage { margin-top: 7px; color: #4a4238; font-size: 13px; line-height: 1.8; }
.usage::before {
  content: "用法 · ";
  color: #9a8f7f; font-size: 11.5px;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.vocab { margin-top: 9px; padding-top: 8px; border-top: 1px solid #eee7dc; }
/* 还没生成到的时候整块藏起来，免得先亮出一条空的分隔线和一个"用法 ·" */
.usage:empty, .vocab:empty { display: none; }
.v + .v { margin-top: 8px; }
.vh { display: flex; align-items: baseline; gap: 7px; }
.vw { font-weight: 600; }
.vm {
  color: #6f6558; font-size: 11.5px;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
/*
 * 可点朗读的音标。虚线下划线是这里唯一的提示——音标本身没法长得像按钮，
 * 而加个喇叭图标又会把这一行注脚顶成一行控件。
 */
.ph { cursor: pointer; border-bottom: 1px dotted #b9ae9d; }
.ph:hover { color: #a4551f; border-bottom-color: #a4551f; }
.vd { font-size: 13px; line-height: 1.75; color: #4a4238; }
.vn {
  font-size: 12px; line-height: 1.7; color: #6f6558;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
button {
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12px; cursor: pointer;
  padding: 4px 11px; border-radius: 3px;
  border: 1px solid #ddd5c8; background: #faf7f2; color: #4a4238;
}
button:hover { border-color: #a4551f; color: #a4551f; }
/*
 * 「还在写」的尾灯。译文约 800ms 就到，讲解还要两三秒——中间没有任何动静的话，
 * 浮层看起来就是已经完事了，人转头就走，正要出来的讲解白生成。
 * 译文到达前不亮：那时 .tr 里已经有一个转圈，两个一起转是噪音。
 */
.more { display: none; margin-top: 9px; }
.more.on { display: block; }
.err { color: #8b5a2b; }
.spin {
  display: inline-block; width: 11px; height: 11px;
  border: 2px solid #e3ddd2; border-top-color: #a4551f;
  border-radius: 50%; animation: r 0.7s linear infinite; vertical-align: -1px;
}
@keyframes r { to { transform: rotate(360deg); } }
`;

export interface PopoverActions {
  /** 用户点了「翻译」（长选区需要确认时才出现这个按钮）。 */
  onConfirm: () => void;
  onOpenOptions: () => void;
}

export class Popover {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private box: HTMLDivElement | null = null;
  private actions: PopoverActions;
  /** 当前锚定的选区矩形，内容变长后重新贴位要用。 */
  private anchor: DOMRect | null = null;
  /**
   * 流式期间缓存的节点。译文、音标、语境解释、生词是分批到的，
   * 每来一批都重建 DOM 会闪，所以搭一次骨架、之后只改 textContent。
   */
  private stream: {
    termEl: HTMLElement;
    meta: HTMLElement;
    tr: HTMLElement;
    note: HTMLElement;
    usage: HTMLElement;
    vocab: HTMLElement;
    /** 选中的原文。点音标时念它——.term 里那份被截断过。 */
    term: string;
    /** 「还在写」的尾灯，收尾时摘掉。 */
    more: HTMLElement;
    /** 已经画出来的生词条数。生词是**追加**的，不重画——重画会让读到一半的人跳行。 */
    drawn: number;
  } | null = null;

  constructor(actions: PopoverActions) {
    this.actions = actions;
  }

  /** 浮层自身的宿主元素——用来判断某次点击是不是发生在浮层内部。 */
  get hostElement(): HTMLElement | null {
    return this.host;
  }

  private ensure(): HTMLDivElement {
    if (this.box) return this.box;
    const host = document.createElement("div");
    host.id = HOST_ID;
    // 宿主本身不参与布局，免得把页面撑出滚动条
    host.style.cssText = "all:initial;position:static;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    // 字体地址带扩展 id，只能此刻才知道。取不到（扩展正在重载）就退回系统衬线。
    let faces = "";
    try {
      faces = FONT_FACES.replace(/__FONTS__/g, chrome.runtime.getURL("fonts/"));
    } catch {
      /* 字体加载失败不该让浮层不可用 */
    }
    style.textContent = faces + CSS;
    const box = document.createElement("div");
    box.className = "box";

    // 关键：按下浮层时不能让浏览器清掉选区，否则点按钮的瞬间
    // getSelection() 就空了，"翻译这段选中的文字"直接失效。
    box.addEventListener("mousedown", (e) => e.preventDefault());

    root.append(style, box);
    document.documentElement.appendChild(host);
    this.host = host;
    this.root = root;
    this.box = box;
    return box;
  }

  /**
   * 定位到选区下方；空间不够时翻到上方，左右两侧夹进视口。
   * 用 fixed 定位 + viewport 坐标，页面滚动时浮层会关掉，不需要跟随。
   */
  private place(rect: DOMRect): void {
    this.anchor = rect;
    this.position();
  }

  /**
   * 按当前内容重新贴位。流式期间每批新字段到达都要调一次。
   *
   * 测量前必须把 left 归零：`position: fixed` 只设了 left 时，可用宽度是
   * `视口宽 - left`，贴在右边缘的浮层量出来会比实际窄。归零和最终定位在同一个
   * 同步任务里完成，浏览器不会在中间绘制，所以不需要 visibility 那一套遮掩。
   */
  private position(): void {
    const box = this.box;
    const rect = this.anchor;
    if (!box || !rect) return;
    box.style.left = "0px";
    box.style.top = "0px";
    const { width, height } = box.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    let top = rect.bottom + MARGIN;
    if (top + height > vh - MARGIN) {
      const above = rect.top - height - MARGIN;
      top = above >= MARGIN ? above : Math.max(MARGIN, vh - height - MARGIN);
    }
    const left = Math.min(Math.max(MARGIN, rect.left), Math.max(MARGIN, vw - width - MARGIN));

    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
  }

  private render(rect: DOMRect, html: string, wire?: (box: HTMLDivElement) => void): void {
    const box = this.ensure();
    this.stream = null; // 整块重建，旧骨架的引用全作废
    box.innerHTML = html;
    wire?.(box);
    this.place(rect);
  }

  /**
   * 搭好最终形态的骨架，译文位置先放一个转圈。
   * 骨架和 showResult 完全同构，所以后面补内容不会引起整块跳动。
   */
  showStreaming(rect: DOMRect, term: string): void {
    this.render(
      rect,
      `<div class="head"><span class="term"></span><span class="meta"></span></div>
       <div class="tr"><span class="spin"></span></div>
       <div class="note"></div>
       <div class="usage"></div>
       <div class="vocab"></div>
       <div class="more"><span class="spin"></span></div>`,
      (box) => {
        const q = (sel: string): HTMLElement => box.querySelector(sel) as HTMLElement;
        const nodes = {
          termEl: q(".term"),
          meta: q(".meta"),
          tr: q(".tr"),
          note: q(".note"),
          usage: q(".usage"),
          vocab: q(".vocab"),
          more: q(".more"),
          term,
          drawn: 0,
        };
        // 和 showResult 用同一个长度：骨架是复用的，长度不一样会让词在收尾时抖一下
        nodes.termEl.textContent = truncate(term, 90);
        this.stream = nodes;
      },
    );
  }

  /**
   * 填入已经到达的字段。译文最先到（约 800ms），语境解释次之，生词最后，
   * 一条一条往下长——这正是"讲解"该有的样子，不必等整段生成完才亮。
   */
  updateStream(p: PartialTranslation): void {
    const n = this.stream;
    if (!n) return; // 已经被 hide / 其他 render 顶掉了
    // 空的一批不覆盖已经到的：流式只会往上加字段，收到空多半是这一帧还没生成到
    if (p.phonetic || p.pos) fillMeta(n.meta, { phonetic: p.phonetic, pos: p.pos, word: n.term });
    if (p.translation) n.tr.textContent = p.translation;
    if (p.contextNote) n.note.textContent = p.contextNote;
    if (p.usage) n.usage.textContent = p.usage;
    this.growVocab(n, p.vocab);
    // 译文一到就点亮尾灯：后面还有用法和生词，别让人以为已经完事了
    if (p.translation) n.more.classList.add("on");
    this.position();
  }

  /** 只追加还没画过的那几条。 */
  private growVocab(n: NonNullable<Popover["stream"]>, list: VocabNote[]): void {
    // 最终结果的条数只会等于或少于流式见过的（两边同一套校验），
    // 真少了说明这批和画上去的不是一回事，那就整块重来
    if (list.length < n.drawn) {
      n.vocab.textContent = "";
      n.drawn = 0;
    }
    for (let i = n.drawn; i < list.length; i++) n.vocab.append(vocabNode(list[i]!));
    n.drawn = list.length;
  }

  /** 长选区不自动翻译，先问一句——"选中即翻译"不该把整段几百字直接发出去。 */
  showConfirm(rect: DOMRect, term: string, words: number): void {
    this.render(
      rect,
      `<div class="head"><span class="term"></span></div>
       <div class="meta">选中了 ${words} 个词，较长，确认后再翻译</div>
       <div class="ctx"><button data-act="go">翻译这段</button></div>`,
      (box) => {
        box.querySelector(".term")!.textContent = truncate(term, 80);
        box.querySelector('[data-act="go"]')!.addEventListener("click", () => this.actions.onConfirm());
      },
    );
  }

  showResult(rect: DOMRect, s: Snippet): void {
    const meta = { phonetic: s.phonetic, pos: s.pos, word: s.text };

    // 流式已经把骨架搭好了，就地补最终值——整块重建会让内容闪一下，
    // 而这里前后内容几乎一样，闪得毫无理由。
    const n = this.stream;
    if (n) {
      this.anchor = rect;
      n.termEl.textContent = truncate(s.text, 90);
      fillMeta(n.meta, meta);
      n.tr.textContent = s.translation;
      n.note.textContent = s.contextNote;
      if (!s.contextNote) n.note.remove();
      n.usage.textContent = s.usage ?? "";
      if (!s.usage) n.usage.remove();
      this.growVocab(n, s.vocab);
      if (s.vocab.length === 0) n.vocab.remove();
      n.more.remove();
      this.stream = null;
      this.position();
      return;
    }

    this.render(
      rect,
      `<div class="head"><span class="term"></span><span class="meta"></span></div>
       <div class="tr"></div>
       <div class="note"></div>
       <div class="usage"></div>
       <div class="vocab"></div>`,
      (box) => {
        box.querySelector(".term")!.textContent = truncate(s.text, 90);
        fillMeta(box.querySelector(".meta")!, meta);
        box.querySelector(".tr")!.textContent = s.translation;
        const note = box.querySelector(".note")!;
        note.textContent = s.contextNote;
        if (!s.contextNote) note.remove();
        const usage = box.querySelector(".usage")!;
        usage.textContent = s.usage ?? "";
        if (!s.usage) usage.remove();
        const vocab = box.querySelector(".vocab")!;
        for (const v of s.vocab) vocab.append(vocabNode(v));
        if (s.vocab.length === 0) vocab.remove();
      },
    );
  }

  showError(rect: DOMRect, message: string, needsConfig: boolean): void {
    this.render(
      rect,
      `<div class="meta err"></div>${needsConfig ? '<div class="ctx"><button data-act="opt">去设置</button></div>' : ""}`,
      (box) => {
        box.querySelector(".err")!.textContent = needsConfig ? "还没配置 MiniMax API Key" : truncate(message, 200);
        box.querySelector('[data-act="opt"]')?.addEventListener("click", () => this.actions.onOpenOptions());
      },
    );
  }

  hide(): void {
    stopSpeaking();
    this.host?.remove();
    this.host = this.root = this.box = null;
    this.stream = null;
    this.anchor = null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * 一条生词：词 + 音标词性一行，意思一行，用法提示一行。
 *
 * 逐个 textContent 填而不是拼 innerHTML——这些字符串直接来自模型，
 * 拼进 HTML 等于把模型输出当代码执行。
 */
function vocabNode(v: VocabNote): HTMLElement {
  const box = document.createElement("div");
  box.className = "v";

  const head = document.createElement("div");
  head.className = "vh";
  const word = document.createElement("span");
  word.className = "vw";
  word.textContent = truncate(v.word, 40);
  head.append(word);

  const m = document.createElement("span");
  m.className = "vm";
  // 念的是这一条讲的词，不是整个选区
  if (fillMeta(m, { phonetic: v.phonetic, pos: v.pos, word: v.word })) head.append(m);

  const meaning = document.createElement("div");
  meaning.className = "vd";
  meaning.textContent = truncate(v.meaning, 120);
  box.append(head, meaning);

  if (v.note) {
    const note = document.createElement("div");
    note.className = "vn";
    note.textContent = truncate(v.note, 120);
    box.append(note);
  }
  return box;
}
