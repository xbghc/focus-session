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
/* :hover 一律关进 (hover: hover)，理由见 popup.css——这一份浮层在手机上也用 */
@media (hover: hover) { .ph:hover { color: #a4551f; border-bottom-color: #a4551f; } }
.ph:active { color: #a4551f; border-bottom-color: #a4551f; }
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
@media (hover: hover) { button:hover { border-color: #a4551f; color: #a4551f; } }
button:active { background: #eee7dc; border-color: #a4551f; color: #a4551f; }
/*
 * 「还在写」的尾灯。译文约 800ms 就到，讲解还要两三秒——中间没有任何动静的话，
 * 浮层看起来就是已经完事了，人转头就走，正要出来的讲解白生成。
 * 译文到达前不亮：那时 .tr 里已经有一个转圈，两个一起转是噪音。
 */
.more { display: none; margin-top: 9px; }
.more.on { display: block; }
/* ---- 追问：译文出来之后，就着这一段再问一句 ---- */
.ask { margin-top: 10px; padding-top: 8px; border-top: 1px solid #eee7dc; }
/* 骨架里先空着。译文还没到就先亮一道分隔线，看着像下面还有东西没加载出来 */
.ask:empty { display: none; }
.qa + .qa { margin-top: 10px; }
.qq {
  color: #6f6558; font-size: 11.5px;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.qq::before { content: "问 · "; }
/* 答案里的换行是模型自己分的段，留着 */
.aa { margin-top: 3px; font-size: 13px; line-height: 1.8; color: #4a4238; white-space: pre-wrap; }
.askbar { display: flex; align-items: center; gap: 7px; margin-top: 8px; }
/*
 * 图标按钮：拿一个字符当图标，不写文字标签。同 App 阅读器顶栏的 .iconbtn（那里是 ‹ 和 词）
 * 与读完角标的 ×——这套 UI 的图标一律是正文字体里的字形，不引矢量图标。
 *
 * 真正的名字挂在 aria-label 和 title 上：纯图标按钮不给无障碍名字就是个哑巴，
 * 鼠标用户也只能靠猜（tooltip 正是为这一下准备的）。
 */
.iconbtn {
  padding: 2px 7px; border-color: transparent; background: transparent;
  color: #9a8f7f; font-size: 15px; line-height: 1.3;
  font-family: "Source Serif 4", Georgia, "Songti SC", "Noto Serif CJK SC", "SimSun", serif;
}
@media (hover: hover) { .iconbtn:hover { color: #a4551f; border-color: transparent; background: transparent; } }
.iconbtn:active { color: #a4551f; }
.qin {
  flex: 1; min-width: 0; box-sizing: border-box;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12px; padding: 4px 8px;
  border: 1px solid #ddd5c8; border-radius: 3px;
  background: #fffdfa; color: #1f1b16;
}
.qin:focus { outline: none; border-color: #a4551f; }
/* 上一问还没答完时禁用。pointer-events 一并关掉，否则 :hover 还会把它描成可点的样子 */
.qin:disabled, button:disabled { opacity: 0.5; pointer-events: none; }
.err { color: #8b5a2b; }
.spin {
  display: inline-block; width: 11px; height: 11px;
  border: 2px solid #e3ddd2; border-top-color: #a4551f;
  border-radius: 50%; animation: r 0.7s linear infinite; vertical-align: -1px;
}
@keyframes r { to { transform: rotate(360deg); } }

/*
 * 手指。上面这些尺寸都是照鼠标给的：按钮 26px 高、追问框 12px 的字，
 * 手机上够不着也看不清。浮层的宽度早按 100vw 收过了，这里只放大能点的那几个。
 */
@media (pointer: coarse) {
  /* :host { all: initial } 把它一并复位了，页面 body 上那条到不了这里 */
  .box { -webkit-tap-highlight-color: transparent; }
  button { font-size: 13px; padding: 9px 14px; }
  .iconbtn { padding: 6px 10px; font-size: 17px; }
  .ctx, .askbar { gap: 8px; }
  /* 16px 起，WebView 才不会在聚焦时把整页放大 */
  .qin { font-size: 16px; padding: 8px 10px; }
}

/*
 * 深色的一套覆盖必须排在最后。这些选择器和上面浅色那套**同名同权重**（button、.note、
 * .qin…），@media 不加权重，靠的纯粹是后来居上：排在前面的话，浅色那份会在深色下把它压回去，
 * 卡片是深的、字却还是 #4a4238，正文直接看不清。
 */
@media (prefers-color-scheme: dark) {
  .box { background: #262220; color: #e8e0d5; border-color: #332f2a; border-top-color: #e18d5a; }
  .meta, .vm, .vn, .qq { color: #9a8f7f; }
  .ph { border-bottom-color: #6b6053; }
  @media (hover: hover) { .ph:hover { color: #e18d5a; border-bottom-color: #e18d5a; } }
  .note, .usage, .vd, .aa { color: #bdb3a4; }
  .usage::before { color: #9a8f7f; }
  .ctx, .vocab, .ask { border-top-color: #2b2724; }
  button { background: #1c1917; color: #bdb3a4; border-color: #3d3833; }
  @media (hover: hover) { button:hover { background: #332f2a; color: #e18d5a; border-color: #e18d5a; } }
  .qin { background: #1c1917; color: #e8e0d5; border-color: #3d3833; }
  .qin:focus { border-color: #e18d5a; }
  /* 图标按钮在深色下同样不要底和框，只换字色 */
  .iconbtn { background: transparent; border-color: transparent; color: #9a8f7f; }
  @media (hover: hover) { .iconbtn:hover { background: transparent; border-color: transparent; color: #e18d5a; } }
  button:active { background: #3d3833; border-color: #e18d5a; color: #e18d5a; }
  .ph:active, .iconbtn:active { color: #e18d5a; }
}
`;

/** 一问的长度上限。追问是「就这一段再问一句」，不是往这里贴一段材料。 */
const MAX_QUESTION_CHARS = 200;

/** 离底不到这么远就算「贴着底」，见 pinBottom。 */
const PIN_SLACK_PX = 24;

export interface PopoverActions {
  /** 用户点了「翻译」（长选区需要确认时才出现这个按钮）。 */
  onConfirm: () => void;
  onOpenOptions: () => void;
  /**
   * 用户就着这一段问了一句。答案由外面流式喂回来：
   * updateAnswer 逐段覆盖，finishAnswer / failAnswer 收尾。
   */
  onAsk: (question: string) => void;
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
  /**
   * 追问那一块。译文出来之后才挂（enableAsk），整块重建时跟着作废。
   *
   * engaged：用户已经点开输入框了。从这一刻起页面上原来那段选区就不作数了
   * （焦点进了输入框，选区会塌），浮层的去留不能再看它——见 asking。
   */
  private ask: {
    qas: HTMLElement;
    bar: HTMLElement;
    /** 正在写的那一条答案；没有在途的问就是 null。 */
    answer: HTMLElement | null;
    input: HTMLInputElement | null;
    send: HTMLButtonElement | null;
    engaged: boolean;
  } | null = null;
  /** 同一帧里的多次贴位合并成一次，见 reposition。 */
  private repositioning = false;

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
    box.addEventListener("mousedown", (e) => {
      // 唯一的例外是追问的输入框：拦掉默认行为它就永远拿不到焦点，一个字也打不进去。
      // 这时选区塌掉不要紧——要问的那一段早就在 selection.ts 手里了。
      if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
      e.preventDefault();
    });

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
    this.ask = null;
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
       <div class="more"><span class="spin"></span></div>
       <div class="ask"></div>`,
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
       <div class="vocab"></div>
       <div class="ask"></div>`,
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

  /* ==================== 追问 ==================== */

  /**
   * 用户已经在追问了：输入框点开过（此后一直算），或答案还在写。
   *
   * 这时页面上原来那段选区多半已经塌了——焦点进了输入框。选区的存亡因此不能再拿来
   * 决定浮层的去留，否则手机上打字打到一半浮层就没了（见 selection.ts 的 evaluate）。
   */
  get asking(): boolean {
    return this.ask?.engaged === true;
  }

  /**
   * 挂上追问入口。**只在译文已经到手之后调**——没有译文可倚，追问问的是空气。
   *
   * 骨架里那个 .ask 是空的（CSS 里 :empty 藏着），填上内容它才现身。
   */
  enableAsk(): void {
    const wrap = this.box?.querySelector(".ask") as HTMLElement | null;
    if (!wrap) return;
    wrap.textContent = "";
    const qas = document.createElement("div");
    qas.className = "qas";
    const bar = document.createElement("div");
    bar.className = "askbar";
    wrap.append(qas, bar);
    this.ask = { qas, bar, answer: null, input: null, send: null, engaged: false };

    // 先只给一个按钮：输入框一上来就摆着，会把「看一眼译文就走」的常态压成一个表单
    const open = iconButton("ask", "问", "就这段追问");
    open.addEventListener("click", () => this.openAsk());
    bar.append(open);
    this.position();
  }

  /** 点开输入框。之后它一直留着，答完一问可以接着问下一问。 */
  private openAsk(): void {
    const a = this.ask;
    if (!a) return;
    a.engaged = true;
    a.bar.textContent = "";

    const input = document.createElement("input");
    input.className = "qin";
    input.type = "text";
    input.maxLength = MAX_QUESTION_CHARS;
    input.placeholder = "就这段问一句…";
    input.addEventListener("keydown", (e) => {
      // 输入法选词时的回车是「确认候选」，不是「发送」——中文输入第一下就会撞上
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      this.submitAsk();
    });

    // 回车也能发；写进 title 里，否则这条捷径没人知道
    const send = iconButton("send", "↵", "发送（回车）");
    send.addEventListener("click", () => this.submitAsk());

    a.input = input;
    a.send = send;
    a.bar.append(input, send);
    input.focus();
    this.position();
  }

  /**
   * 浮层自己有 max-height 和内部滚动（讲解能占大半屏）。追问的问答挂在最底下，
   * 长选区上它一出生就在折线以下——答案一路往外冒，人却什么都看不见。
   *
   * 只在**本来就贴着底**时才跟着滚：流式期间回头重看译文是常事，
   * 无条件滚到底会把正在看的地方抽走。
   */
  private pinBottom(mutate: () => void): void {
    const box = this.box;
    const pinned = box !== null && box.scrollHeight - box.scrollTop - box.clientHeight < PIN_SLACK_PX;
    mutate();
    if (box && pinned) box.scrollTop = box.scrollHeight;
  }

  /** 发出这一问：把问题挂上去、答案位先放转圈，再交给外面。 */
  private submitAsk(): void {
    const a = this.ask;
    if (!a?.input || a.answer !== null) return; // 上一问还没答完
    const q = a.input.value.trim();
    if (!q) return;
    a.input.value = "";
    this.setAskBusy(true);

    const qa = document.createElement("div");
    qa.className = "qa";
    const qq = document.createElement("div");
    qq.className = "qq";
    qq.textContent = q;
    const slot = document.createElement("div");
    slot.className = "aa";
    slot.append(spinner());
    qa.append(qq, slot);
    a.answer = slot;
    this.pinBottom(() => a.qas.append(qa));

    this.actions.onAsk(q);
    this.position();
  }

  private setAskBusy(busy: boolean): void {
    const a = this.ask;
    if (!a) return;
    if (a.input) a.input.disabled = busy;
    if (a.send) a.send.disabled = busy;
  }

  /** 答案的增量。参数是**到目前为止的全部答案**，直接覆盖。 */
  updateAnswer(text: string): void {
    const slot = this.ask?.answer;
    if (!slot) return;
    // 直接来自模型，只能当文本填，不能拼进 HTML
    this.pinBottom(() => void (slot.textContent = text));
    this.reposition();
  }

  finishAnswer(text: string): void {
    const a = this.ask;
    if (!a?.answer) return;
    // 一个字都没吐出来（被截断、被拦）时别留个空框加转圈在那儿转
    a.answer.textContent = text || "（这一问没有得到回答）";
    a.answer = null;
    this.setAskBusy(false);
    this.position();
  }

  failAnswer(message: string, needsConfig: boolean): void {
    const a = this.ask;
    if (!a?.answer) return;
    const slot = a.answer;
    slot.textContent = needsConfig ? "还没配置 MiniMax API Key" : truncate(message, 200);
    slot.classList.add("err");
    if (needsConfig) {
      const row = document.createElement("div");
      row.className = "ctx";
      const btn = document.createElement("button");
      btn.setAttribute("data-act", "opt");
      btn.textContent = "去设置";
      btn.addEventListener("click", () => this.actions.onOpenOptions());
      row.append(btn);
      slot.after(row);
    }
    a.answer = null;
    this.setAskBusy(false);
    this.position();
  }

  /**
   * 合并同一帧里的多次贴位。
   *
   * 答案是一段一段冒出来的，每来一段都量一次尺寸、改一次 left/top，
   * 等于每帧强制同步布局好几回。翻译那边一次至多推四批，没有这个问题。
   */
  private reposition(): void {
    if (this.repositioning) return;
    this.repositioning = true;
    const run = (): void => {
      this.repositioning = false;
      this.position();
    };
    // 测试环境（jsdom）没有 rAF，退回同步——贴位本身不依赖动画帧
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  }

  hide(): void {
    stopSpeaking();
    this.host?.remove();
    this.host = this.root = this.box = null;
    this.stream = null;
    this.ask = null;
    this.anchor = null;
  }
}

/**
 * 一个字符当图标的按钮。
 *
 * label 同时挂到 aria-label 和 title 上：前者给读屏软件，后者给鼠标——
 * 纯图标按钮少了哪一个都等于没有名字。
 */
function iconButton(act: string, glyph: string, label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "iconbtn";
  btn.setAttribute("data-act", act);
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.textContent = glyph;
  return btn;
}

function spinner(): HTMLElement {
  const el = document.createElement("span");
  el.className = "spin";
  return el;
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
