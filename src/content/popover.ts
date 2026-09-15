import type { PartialTranslation, Snippet, SnippetKind, VocabNote } from "../types.ts";
import { coarsePointer } from "../lib/pointer.ts";
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
/** 同 CSS 里 .box 那条 max-height：min(70vh, 520px)。挑边要算「这一边放不放得下」，JS 这边也得知道。 */
const MAX_HEIGHT = 520;
/** 挑边时一边至少得有这么高，才算放得下一个能看的浮层；两边都不到就贴顶，压住选区也认了。 */
const MIN_ROOM = 120;
/**
 * 流式开始时预计浮层会长到多高（算上收尾挂的追问入口），按选区种类估——那一刻内容还没来，量不出来。
 * 贴上方时照这个高度预留，浮层钉住上边往下长。数字是在 Chrome 里真排版量出来的：单词 250–260px，
 * 带两个生词的短语 390–400px，整句基本顶到上限。估高了是浮层和选区之间空一截，估低了是收尾时
 * 往上让一次（见 position）；两样都比流式期间一路挪好受。
 */
const EXPECTED_HEIGHT: Record<SnippetKind, number> = { word: 270, phrase: 400, sentence: MAX_HEIGHT };

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
  /*
   * 挂在宿主里，宿主冻结成定位那一刻的视口（见 freeze）：页面滚动时浮层由浏览器带着和原文一起挪，
   * 不用一滚就关，也不会比原文慢一拍。手机上贴屏幕顶的换成 fixed（.dock），钉在屏幕上不跟。
   */
  position: absolute;
  z-index: 2147483647;
  /*
   * 宽度一上来就定死，不跟着内容撑：译文、讲解一批批到，宽度一变行就重新折，
   * 贴右边的浮层还得往左挪。手机屏幕比 380px 窄：两边各留 8px，别顶穿视口。
   */
  width: min(380px, calc(100vw - 16px));
  /* 讲解能有五条，长句加满就是大半屏。给个上限让它自己滚；贴位时再按那一边的空间收（见 position） */
  max-height: min(70vh, 520px);
  overflow-y: auto;
  box-sizing: border-box;
  padding: 12px 14px;
  border-radius: 3px;
  border: 1px solid #d3cbbd;
  border-top: 3px solid #9c4d14;
  background: #f6f0e7;
  color: #3a342e;
  box-shadow: 0 1px 2px rgba(31, 27, 22, 0.06), 0 10px 28px rgba(31, 27, 22, 0.12);
  font: 14px/1.7 "Source Serif 4", Georgia, "Songti SC", "Noto Serif CJK SC", "SimSun", serif;
  overflow-wrap: break-word;
  /* 浮层里的字要能选中复制。有的网站给 html 挂 user-select: none 防复制，不写明的话浮层会跟着继承过来 */
  -webkit-user-select: text;
  user-select: text;
  /* 宿主盖住整个视口、不接指针（不然页面点不动也选不了字），浮层自己接回来 */
  pointer-events: auto;
}
.box.dock { position: fixed; }
/*
 * 内容真溢出时才不把滚动接力给页面：长讲解滚到底就停住，页面不跟着走。
 * 内容放得下时不加——实测 contain 在放得下的盒子上也会把滚轮吞掉，指针停在浮层上时页面就滚不动了。
 */
.box.scrolls { overscroll-behavior: contain; }
.head { display: flex; align-items: baseline; gap: 9px; margin-bottom: 5px; }
.term { font-weight: 600; font-size: 17px; letter-spacing: -0.01em; }
/*
 * 截断过的原文可以点：点一下展开全文，再点收起（见 fillTerm）。没截断的不挂 aria-expanded，不可点也不变色。
 * 不学音标描虚线：一整段粗体原文底下拖一道线太吵，结尾那个「…」本身就在说后面还有。
 */
.term[aria-expanded] { cursor: pointer; }
@media (hover: hover) { .term[aria-expanded]:hover { color: #9c4d14; } }
.term[aria-expanded]:active { color: #9c4d14; }
/* 注脚一律无衬线，和 popup / dashboard 同一套分工 */
.meta {
  color: #6c6254; font-size: 11.5px;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.tr { font-size: 16px; margin: 3px 0 6px; }
.note { color: #574e44; font-size: 13px; line-height: 1.85; }
.ctx { margin-top: 10px; padding-top: 8px; border-top: 1px solid #e3dbcf; display: flex; gap: 7px; flex-wrap: wrap; }

/* ---- 讲解：用法一行，生词逐条 ---- */
.usage { margin-top: 7px; color: #574e44; font-size: 13px; line-height: 1.8; }
.usage::before {
  content: "用法 · ";
  color: #8f8475; font-size: 11.5px;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.vocab { margin-top: 9px; padding-top: 8px; border-top: 1px solid #e3dbcf; }
/* 还没生成到的时候整块藏起来，免得先亮出一条空的分隔线和一个"用法 ·" */
.usage:empty, .vocab:empty { display: none; }
.v + .v { margin-top: 8px; }
.vh { display: flex; align-items: baseline; gap: 7px; }
.vw { font-weight: 600; }
.vm {
  color: #6c6254; font-size: 11.5px;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
/*
 * 可点朗读的音标。虚线下划线是这里唯一的提示——音标本身没法长得像按钮，
 * 而加个喇叭图标又会把这一行注脚顶成一行控件。
 */
.ph { cursor: pointer; border-bottom: 1px dotted #aea392; }
/* :hover 一律关进 (hover: hover)，理由见 popup.css——这一份浮层在手机上也用 */
@media (hover: hover) { .ph:hover { color: #9c4d14; border-bottom-color: #9c4d14; } }
.ph:active { color: #9c4d14; border-bottom-color: #9c4d14; }
.vd { font-size: 13px; line-height: 1.75; color: #574e44; }
.vn {
  font-size: 12px; line-height: 1.7; color: #6c6254;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
button {
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12px; cursor: pointer;
  padding: 4px 11px; border-radius: 3px;
  border: 1px solid #d0c8ba; background: #efe9de; color: #574e44;
  /* 拖选浮层里的字时，别把按钮上的字也圈进去 */
  -webkit-user-select: none;
  user-select: none;
}
@media (hover: hover) { button:hover { border-color: #9c4d14; color: #9c4d14; } }
button:active { background: #e3dbcf; border-color: #9c4d14; color: #9c4d14; }
/*
 * 「还在写」的尾灯。译文约 800ms 就到，讲解还要两三秒——中间没有任何动静的话，
 * 浮层看起来就是已经完事了，人转头就走，正要出来的讲解白生成。
 * 译文到达前不亮：那时 .tr 里已经有一个转圈，两个一起转是噪音。
 */
.more { display: none; margin-top: 9px; }
.more.on { display: block; }
/* ---- 追问：译文出来之后，就着这一段再问一句 ---- */
.ask { margin-top: 10px; padding-top: 8px; border-top: 1px solid #e3dbcf; }
/* 骨架里先空着。译文还没到就先亮一道分隔线，看着像下面还有东西没加载出来 */
.ask:empty { display: none; }
.qa + .qa { margin-top: 10px; }
.qq {
  color: #6c6254; font-size: 11.5px;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.qq::before { content: "问 · "; }
/* 答案里的换行是模型自己分的段，留着 */
.aa { margin-top: 3px; font-size: 13px; line-height: 1.8; color: #574e44; white-space: pre-wrap; }
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
  color: #8f8475; font-size: 15px; line-height: 1.3;
  font-family: "Source Serif 4", Georgia, "Songti SC", "Noto Serif CJK SC", "SimSun", serif;
}
@media (hover: hover) { .iconbtn:hover { color: #9c4d14; border-color: transparent; background: transparent; } }
.iconbtn:active { color: #9c4d14; }
.qin {
  flex: 1; min-width: 0; box-sizing: border-box;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12px; padding: 4px 8px;
  border: 1px solid #d0c8ba; border-radius: 3px;
  background: #f6f0e7; color: #3a342e;
}
.qin:focus { outline: none; border-color: #9c4d14; }
/* 上一问还没答完时禁用。pointer-events 一并关掉，否则 :hover 还会把它描成可点的样子 */
.qin:disabled, button:disabled { opacity: 0.5; pointer-events: none; }
.err { color: #845424; }
.spin {
  display: inline-block; width: 11px; height: 11px;
  border: 2px solid #d7d0c3; border-top-color: #9c4d14;
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
 * 卡片是深的、字却还是 #574e44，正文直接看不清。
 */
@media (prefers-color-scheme: dark) {
  .box { background: #342f2c; color: #d6cec3; border-color: #423e38; border-top-color: #e18d5a; }
  .meta, .vm, .vn, .qq { color: #a39889; }
  .ph { border-bottom-color: #756a5d; }
  @media (hover: hover) { .ph:hover { color: #e18d5a; border-bottom-color: #e18d5a; } }
  @media (hover: hover) { .term[aria-expanded]:hover { color: #e18d5a; } }
  .note, .usage, .vd, .aa { color: #b7aea0; }
  .usage::before { color: #a39889; }
  .ctx, .vocab, .ask { border-top-color: #3a3632; }
  button { background: #2b2724; color: #b7aea0; border-color: #4c4741; }
  @media (hover: hover) { button:hover { background: #423e38; color: #e18d5a; border-color: #e18d5a; } }
  .qin { background: #2b2724; color: #d6cec3; border-color: #4c4741; }
  .qin:focus { border-color: #e18d5a; }
  /* 图标按钮在深色下同样不要底和框，只换字色 */
  .iconbtn { background: transparent; border-color: transparent; color: #a39889; }
  @media (hover: hover) { .iconbtn:hover { background: transparent; border-color: transparent; color: #e18d5a; } }
  button:active { background: #4c4741; border-color: #e18d5a; color: #e18d5a; }
  .ph:active, .iconbtn:active, .term[aria-expanded]:active { color: #e18d5a; }
  /* 出错那句：浅色那份深棕放在深色卡片上只剩 2:1 */
  .err { color: #d4a373; }
}
`;

/** 一问的长度上限。追问是「就这一段再问一句」，不是往这里贴一段材料。 */
const MAX_QUESTION_CHARS = 200;

/** 离底不到这么远就算「贴着底」，见 pinBottom。 */
const PIN_SLACK_PX = 24;

/**
 * 发出一问时给答案留的高度，见 reserveAnswer。提示词让模型把答案控制在 150 字以内；
 * 在 Chrome 里量过，150 个汉字的答案比「问题 + 转圈」多长出 117px。再长的就在浮层里滚。
 */
const ANSWER_ROOM = 120;

/** 贴选区的浮层滚到只露出这么高（矮浮层按自身一半算）就算看不见了，见 followAnchor。 */
const VISIBLE_MIN_PX = 40;

/** 贴屏幕顶的浮层：原文离开原位超过屏幕高度的这一份、并且被浮层遮住或出了屏幕，才算看不见了，见 followAnchor。 */
const DOCK_CLOSE_RATIO = 0.25;

export interface PopoverActions {
  /** 这次贴位的样式已经写好；观察器按帧去量真正画出来的位置。 */
  onPositioned?: (box: HTMLElement) => void;
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
   * 这个锚点上定下来的框：贴选区上方还是下方、左边在哪、钉住的是哪条边（edge 是那条边的 y）。
   * dock：手机上放上方时贴屏幕顶，不贴选区（见 place）。一个锚点只挑一次边，之后每次贴位都照它摆。
   * 坐标都是定位那一刻的视口坐标：vw / vh 是那时的视口宽高，ox / oy 是那时宿主的视口坐标（见 freeze）。
   */
  private frame: {
    above: boolean; dock: boolean; left: number; pin: "top" | "bottom"; edge: number;
    vw: number; vh: number; ox: number; oy: number;
  } | null = null;
  /** 原文没跟着文档滚（内部滚动容器、sticky）时给浮层补上的那一截，见 followAnchor。 */
  private drift = { x: 0, y: 0 };
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
  /** 截断过的原文，点开、收起时照它重填 .term（见 fillTerm）。没截断就是 null，整块重建时跟着作废。 */
  private origin: { el: Element; text: string; max: number } | null = null;
  /** 同一帧里的多次贴位合并成一次，见 reposition。 */
  private repositioning = false;
  private recognizing = false;

  constructor(actions: PopoverActions) {
    this.actions = actions;
  }

  /** 浮层自身的宿主元素——用来判断某次点击是不是发生在浮层内部。 */
  get hostElement(): HTMLElement | null {
    return this.host;
  }

  /**
   * 浮层里此刻有没有选中的字。
   *
   * 划词那边判选区前得先问这一句：Chrome 的 document.getSelection() 会把浮层里的选区原样交出来，
   * 照常判下去，浮层自己的字就成了一段新选区——人只是想复制，浮层却被收掉或顶掉（见 selection.ts 的 evaluate）。
   * 认选区在不在浮层里用 getComposedRanges：传进这个 shadow root，它才把里面的范围交出来，不传就折到宿主外面；
   * 没有它的旧 Chrome 退回 shadow root 自己的 getSelection。
   */
  holdsSelection(): boolean {
    const root = this.root;
    const sel = root ? document.getSelection() : null;
    if (!root || !sel || sel.rangeCount === 0) return false;
    const s = sel as unknown as { getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[] };
    if (typeof s.getComposedRanges === "function") {
      return s.getComposedRanges({ shadowRoots: [root] }).some((r) => !r.collapsed && root.contains(r.startContainer));
    }
    const own = (root as unknown as { getSelection?: () => Selection | null }).getSelection?.();
    return !!own && !own.isCollapsed && root.contains(own.anchorNode);
  }

  private ensure(): HTMLDivElement {
    if (this.box) return this.box;
    const host = document.createElement("div");
    host.id = HOST_ID;
    // 宿主不参与布局，免得把页面撑出滚动条。定位时冻结成那一刻的视口（见 freeze），浮层挂在里面跟着文档走；
    // 盖住视口的这一层不接指针。不能加 transform / filter / contain：那会让贴屏幕顶的 fixed 浮层改以宿主为包含块
    host.style.cssText = "all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;overflow-anchor:none;";
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

    // 按在按钮上拦住默认动作：页面上的选区不塌、还亮着，看得出浮层讲的是哪一段。
    // 字上不拦——译文、讲解、答案都得能选中复制
    box.addEventListener("mousedown", (e) => {
      if ((e.target as Element | null)?.closest("button")) e.preventDefault();
    });
    // 截断过的原文点一下展开、再点收起。它挂着 role="button"，键盘上的回车、空格也得认。
    // 在原文上拖着选字，松手那一下也会来一个 click：手里有选区时不算点
    box.addEventListener("click", (e) => {
      if (!(e.target as Element | null)?.closest(".term[aria-expanded]") || this.holdsSelection()) return;
      this.toggleTerm();
    });
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (!(e.target as Element | null)?.closest(".term[aria-expanded]")) return;
      e.preventDefault(); // 空格的默认动作是滚动浮层
      this.toggleTerm();
    });

    root.append(style, box);
    document.documentElement.appendChild(host);
    this.host = host;
    this.root = root;
    this.box = box;
    return box;
  }

  /**
   * 给新锚点定框：贴选区上方还是下方、钉住哪条边。之后内容再怎么变，position 只照这个框摆。
   *
   * 优先放上方：选区上面的字通常已经读过了，压住无所谓；放下方会挡住接着往下
   * 读、往下选的那片。挑边看的是浮层**会长到多高**，不是它此刻多高——流式骨架刚出来
   * 只有两三行，照它挑边，内容长到上面塞不下就得翻到下方，那是流式期间最晃眼的一下。
   * 所以流式时按选区种类预估（expected），浮层钉住预留好的上边往下长；确认、报错这类
   * 一次成型的内容就量现在的高度，贴着选区放、钉住下边。
   *
   * 手机上（主指针是手指）放上方时不贴选区，贴屏幕顶：窄屏上浮层本来就占满整宽，固定在顶上，
   * 每次点词都在同一个地方出现。上方可用的是从顶边到选区之间那一截，放不下预估的高度才落到选区下方。
   *
   * 两边都放不下时挑空间大的那边，浮层收矮、内容在里面滚；两边都挤不出 MIN_ROOM 才贴顶——
   * 那时选区本身占了大半屏（比如截图框），压住也认了。
   *
   * 框用定位这一刻的视口坐标，宿主同时冻结成这一刻的视口、挂在文档上（见 freeze）：之后页面滚动，
   * 浮层由浏览器带着和原文一起走，不跑 JS，不比原文慢一拍，也就不必一滚就关（什么时候关见 followAnchor）。
   * 贴屏幕顶的浮层照旧 fixed，钉在屏幕上不跟。
   */
  private place(rect: DOMRect, expected?: number): void {
    const box = this.box;
    const host = this.host;
    if (!box || !host) return;
    this.anchor = rect;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const origin = freeze(host, vw, vh);
    const view = { vw, vh, ox: origin.left, oy: origin.top };
    const need = Math.min(vh * 0.7, MAX_HEIGHT, expected ?? naturalHeight(box));
    const dock = coarsePointer() ? dockTop() : null;
    const above = rect.top - MARGIN - (dock ?? MARGIN);
    const below = vh - rect.bottom - 2 * MARGIN;
    const left = rect.left;
    let frame: NonNullable<Popover["frame"]>;
    if (above >= need || (below < need && above >= below && above >= MIN_ROOM)) {
      frame = dock !== null
        ? { above: true, dock: true, left, pin: "top", edge: dock, ...view }
        : expected === undefined
          ? { above: true, dock: false, left, pin: "bottom", edge: rect.top - MARGIN, ...view }
          : { above: true, dock: false, left, pin: "top", edge: Math.max(MARGIN, rect.top - MARGIN - need), ...view };
    } else if (below >= need || below >= MIN_ROOM) {
      frame = { above: false, dock: false, left, pin: "top", edge: rect.bottom + MARGIN, ...view };
    } else {
      frame = { above: false, dock: false, left, pin: "top", edge: dock ?? MARGIN, ...view };
    }
    this.frame = frame;
    box.classList.toggle("dock", frame.dock);
    // 新锚点从零算起：上一段原文补过的差值不作数
    this.drift = { x: 0, y: 0 };
    box.style.transform = "";
    this.position();
  }

  /**
   * 照定好的框摆放。内容每变一次都调：流式每一批、收尾、追问的每一段答案。
   *
   * 钉住的那条边不动，浮层只往另一头长，长到这一边的空间（和 MAX_HEIGHT）为止，再长就在里面滚。
   * 所以流式期间浮层不挪：贴上方钉的是预留好的上边（手机上是屏幕顶），贴下方钉的是选区下沿。
   * 宽度是 CSS 定死的，左边也就不会跟着内容变；贴屏幕顶的左右居中。钉下边直接写 CSS 的 bottom，
   * 浮层多高交给浏览器排，不用先量再倒推 top。
   *
   * 只有一种情况改钉下边：流式结束后内容比预留的那一格高——估低了，往上让一次，比把讲解的尾巴和
   * 追问入口藏进滚动条里强。贴屏幕顶的不让，顶上没地方可让；追问期间也不让：答案的地方在发出一问时
   * 就留好了（见 reserveAnswer），这时再让，浮层就跟着答案一路往上爬。
   */
  private position(): void {
    const box = this.box;
    const rect = this.anchor;
    const f = this.frame;
    if (!box || !rect || !f) return;
    // 定位那一刻的视口：浮层挂在冻结的宿主里，之后视口怎么变，框都照那时的坐标摆
    const { vw, vh } = f;
    // 浮层下沿最低能到哪：贴上方时是选区顶上那条缝，否则是视口底
    const floor = f.above ? rect.top - MARGIN : vh - MARGIN;
    // 量高度用 scrollHeight，不临时放开 max-height 再量：那一下会把用户在浮层里滚到的位置归零
    if (f.above && !f.dock && f.pin === "top" && !this.stream && !this.asking && naturalHeight(box) > floor - f.edge) {
      f.pin = "bottom";
      f.edge = floor;
    }
    const room = Math.floor(Math.max(0, Math.min(vh * 0.7, MAX_HEIGHT, f.pin === "bottom" ? f.edge - MARGIN : floor - f.edge)));
    const width = box.offsetWidth;
    const left = f.dock ? (vw - width) / 2 : Math.min(Math.max(MARGIN, f.left), Math.max(MARGIN, vw - width - MARGIN));
    box.style.maxHeight = `${room}px`;
    box.style.left = `${Math.round(left)}px`;
    box.style.top = f.pin === "top" ? `${Math.round(f.edge)}px` : "auto";
    box.style.bottom = f.pin === "bottom" ? `${Math.round(vh - f.edge)}px` : "auto";
    box.classList.toggle("scrolls", box.scrollHeight > box.clientHeight);
    this.actions.onPositioned?.(box);
  }

  /**
   * 发出一问时给答案留出地方，之后答案怎么长浮层都不挪。
   *
   * 答案是一小段一小段流出来的。浮层要是钉住下沿跟着往上长，整块就一路往上爬，连同上面的译文一起晃——
   * 生成期间最扎眼的就是这个。所以只在发送这一下挪：贴在选区上方的浮层下沿本来就贴着选区，底下没空，
   * 就把上边往上提，提到放得下 ANSWER_ROOM 为止，然后钉住上边往下长；提到头也放不下，答案就在浮层里滚。
   * 放下方的、贴屏幕顶的，钉的本来就是上边，往下长不用挪。
   */
  private reserveAnswer(): void {
    const box = this.box;
    const rect = this.anchor;
    const f = this.frame;
    if (!box || !rect || !f?.above || f.dock) return;
    const want = Math.min(f.vh * 0.7, MAX_HEIGHT, naturalHeight(box) + ANSWER_ROOM);
    // 浮层眼下的上边从框里算，不去量 getBoundingClientRect：页面滚过之后量出来的是另一套视口坐标
    const top = f.pin === "top" ? f.edge : f.edge - box.offsetHeight;
    f.pin = "top";
    f.edge = Math.max(MARGIN, Math.min(top, rect.top - MARGIN - want));
  }

  private render(rect: DOMRect, html: string, wire?: (box: HTMLDivElement) => void, expected?: number): void {
    const box = this.ensure();
    this.recognizing = false;
    this.stream = null; // 整块重建，旧骨架的引用全作废
    this.ask = null;
    this.origin = null;
    box.innerHTML = html;
    wire?.(box);
    this.place(rect, expected);
  }

  showRecognizing(rect: DOMRect): void {
    // 认出来的多半是一段话，按整句预留：接着翻译会沿用这个框，等认完再挑边就晚了
    this.showStreaming(rect, "正在识别图中文字…", "sentence");
    this.recognizing = true;
    const n = this.stream!;
    n.termEl.insertAdjacentHTML("beforeend", ' <span class="spin"></span>');
    n.tr.textContent = "";
  }

  setTerm(text: string): void {
    if (!this.stream) return;
    this.stream.term = text;
    this.fillTerm(this.stream.termEl, text, 90);
    this.position();
  }

  /**
   * 把选中的原文填进 .term。长了只露前 max 个字；截掉了的可以点，展开全文、再点收起——
   * 长选区等确认时、截图认出一整段时，截掉的那半在别处看不到。
   *
   * 展开与否记在节点自己的 aria-expanded 上：识别完转翻译、流式收尾补最终值都是就地重填，
   * 不能把人刚点开的全文又收回去；换一段选区是整块重建，节点是新的，自然回到收起。
   */
  private fillTerm(el: Element, text: string, max: number): void {
    const long = text.length > max;
    const open = long && el.getAttribute("aria-expanded") === "true";
    const shown = open ? text : truncate(text, max);
    // 没变就不重写：识别转翻译、流式收尾都会原样再填一遍，重写会把人正选着的字冲掉
    if (el.textContent !== shown) el.textContent = shown;
    this.origin = long ? { el, text, max } : null;
    if (long) {
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-expanded", String(open));
    } else {
      for (const a of ["role", "tabindex", "aria-expanded"]) el.removeAttribute(a);
    }
  }

  /** 点了截断过的原文：展开全文，或收回截断。之后照定好的框重新贴位，钉住的那条边不动。 */
  private toggleTerm(): void {
    const o = this.origin;
    const box = this.box;
    if (!o || !box) return;
    const open = o.el.getAttribute("aria-expanded") !== "true";
    o.el.setAttribute("aria-expanded", String(open));
    this.fillTerm(o.el, o.text, o.max);
    // 收起时滚回顶上：全文长到要在浮层里往下滚着读的话，缩回去还停在原来的滚动位置，
    // 露出来的是半截讲解，刚收起的原文反倒在视野外
    if (!open) box.scrollTop = 0;
    this.position();
  }

  /**
   * 搭好最终形态的骨架，译文位置先放一个转圈。
   * 骨架和 showResult 完全同构，所以后面补内容不会引起整块跳动。
   * kind 用来预估浮层会长多高，据此挑边、预留位置（见 EXPECTED_HEIGHT）。
   */
  showStreaming(rect: DOMRect, term: string, kind: SnippetKind = "word"): void {
    // 识别与翻译沿用同一骨架，避免识别刚结束就把整块浮层拆了重画；框也沿用，不重新挑边。
    if (this.recognizing && this.stream) {
      this.recognizing = false;
      this.setTerm(term);
      this.stream.tr.innerHTML = '<span class="spin"></span>';
      this.position();
      return;
    }
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
        this.fillTerm(nodes.termEl, term, 90);
        this.stream = nodes;
      },
      EXPECTED_HEIGHT[kind],
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
    if (p.translation) setText(n.tr, p.translation);
    if (p.contextNote) setText(n.note, p.contextNote);
    if (p.usage) setText(n.usage, p.usage);
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
  showConfirm(rect: DOMRect, term: string, words: number, source: "selection" | "image" = "selection"): void {
    this.render(
      rect,
      `<div class="head"><span class="term"></span></div>
       <div class="meta">${source === "image" ? "识别出" : "选中了"} ${words} 个词，较长，确认后再翻译</div>
       <div class="ctx"><button data-act="go">翻译这段</button></div>`,
      (box) => {
        this.fillTerm(box.querySelector(".term")!, term, 80);
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
      // 框和锚点照流式开始时定的：人可能已经滚过，这里换成外面传进来的矩形，两套坐标就混了
      this.fillTerm(n.termEl, s.text, 90);
      fillMeta(n.meta, meta);
      setText(n.tr, s.translation);
      setText(n.note, s.contextNote);
      if (!s.contextNote) n.note.remove();
      setText(n.usage, s.usage ?? "");
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
        this.fillTerm(box.querySelector(".term")!, s.text, 90);
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
    this.reserveAnswer();

    this.actions.onAsk(q);
    this.position();
  }

  private setAskBusy(busy: boolean): void {
    const a = this.ask;
    if (!a) return;
    if (a.input) a.input.disabled = busy;
    if (a.send) a.send.disabled = busy;
  }

  /** 答案的增量。参数是**到目前为止的全部答案**；接着已经写出的往后长，见 setText。 */
  updateAnswer(text: string): void {
    const slot = this.ask?.answer;
    if (!slot) return;
    // 直接来自模型，只能当文本填，不能拼进 HTML
    this.pinBottom(() => setText(slot, text));
    this.reposition();
  }

  finishAnswer(text: string): void {
    const a = this.ask;
    if (!a?.answer) return;
    // 一个字都没吐出来（被截断、被拦）时别留个空框加转圈在那儿转
    setText(a.answer, text || "（这一问没有得到回答）");
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

  /* ==================== 滚动 ==================== */

  /**
   * 页面、或原文所在的滚动容器滚过之后调：照原文此刻的视口矩形跟一下，返回浮层还看不看得见（看不见就该关）。
   *
   * 贴选区的浮层挂在冻结的宿主里，文档滚动由浏览器带着走，这里只补原文没跟着文档走的那一截——
   * 正文在内部滚动容器里、或是 sticky 的。滚出视口、只露出不到 VISIBLE_MIN_PX（矮浮层按一半算）才算看不见：
   * 看得见的留着；看不见的要是还开着，App 里下一次点词会被它吞掉（浮层开着时点正文只关不翻）。
   *
   * 贴屏幕顶的浮层钉在屏幕上不跟，看的是原文：离开原位超过 DOCK_CLOSE_RATIO 屏，并且被浮层整个遮住或出了屏幕，
   * 才算看不见。只看遮没遮住，词紧挨着浮层下沿时滚几像素就关；只看挪了多远，词还露在屏幕上浮层就没了。
   */
  followAnchor(anchorNow: DOMRect): boolean {
    const box = this.box;
    const host = this.host;
    const f = this.frame;
    const rect = this.anchor;
    if (!box || !host || !f || !rect) return true;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    if (f.dock) {
      const b = box.getBoundingClientRect();
      const moved = Math.abs(anchorNow.top - rect.top) >= f.vh * DOCK_CLOSE_RATIO;
      const offscreen = anchorNow.bottom <= 0 || anchorNow.top >= vh;
      const covered = anchorNow.top >= b.top && anchorNow.bottom <= b.bottom &&
        anchorNow.left >= b.left && anchorNow.right <= b.right;
      return !(moved && (offscreen || covered));
    }
    const h = host.getBoundingClientRect();
    const dx = anchorNow.left - (rect.left + h.left - f.ox);
    const dy = anchorNow.top - (rect.top + h.top - f.oy);
    // 半个像素以内是取整误差，不去动它，免得滚动时浮层跟着抖
    this.drift = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 ? { x: 0, y: 0 } : { x: dx, y: dy };
    box.style.transform = this.drift.x || this.drift.y ? `translate(${this.drift.x}px, ${this.drift.y}px)` : "";
    const b = box.getBoundingClientRect();
    if (!b.width || !b.height) return true;
    const shownW = Math.min(b.right, vw) - Math.max(b.left, 0);
    const shownH = Math.min(b.bottom, vh) - Math.max(b.top, 0);
    return shownW > 0 && shownH >= Math.min(VISIBLE_MIN_PX, b.height / 2);
  }

  /**
   * 浮层被滚动（和跟随原文）带着挪了多少。贴屏幕顶的不跟着滚，恒为 0。
   * 翻译轨迹量位置时减掉它：浮层跟着原文走不算浮层自己挪。
   */
  scrollShift(): { x: number; y: number } {
    const host = this.host;
    const f = this.frame;
    if (!host || !f || f.dock) return { x: 0, y: 0 };
    const h = host.getBoundingClientRect();
    return { x: h.left - f.ox + this.drift.x, y: h.top - f.oy + this.drift.y };
  }

  hide(): void {
    stopSpeaking();
    this.host?.remove();
    this.host = this.root = this.box = null;
    this.stream = null;
    this.ask = null;
    this.origin = null;
    this.anchor = null;
    this.frame = null;
    this.drift = { x: 0, y: 0 };
  }
}

/** 内容撑开时浮层有多高（含边框），不受 max-height 截断。 */
function naturalHeight(box: HTMLElement): number {
  return box.scrollHeight + box.offsetHeight - box.clientHeight;
}

/**
 * 把宿主摆成此刻的视口：absolute 挂在文档上，之后页面怎么滚，它连同里面的浮层都跟着内容走。
 * 站点给 html 加了 margin 或 position 时，absolute 的起点不在文档原点，量一次、差多少补多少。
 * 返回宿主此刻的视口矩形（正常就在原点）。
 */
function freeze(host: HTMLElement, vw: number, vh: number): DOMRect {
  const view = document.defaultView;
  const x = view?.scrollX ?? 0;
  const y = view?.scrollY ?? 0;
  host.style.left = `${x}px`;
  host.style.top = `${y}px`;
  host.style.width = `${vw}px`;
  host.style.height = `${vh}px`;
  const r = host.getBoundingClientRect();
  if (r.left || r.top) {
    host.style.left = `${x - r.left}px`;
    host.style.top = `${y - r.top}px`;
  }
  return host.getBoundingClientRect();
}

/**
 * 手机上浮层贴屏幕顶时的顶边：让开状态栏和刘海。App 的宿主把它们压在 WebView 上的高度
 * 写在 --inset-top 上（见 app/native.ts）；扩展里没有这个变量，就只留 MARGIN。
 */
function dockTop(): number {
  const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--inset-top"));
  return MARGIN + (inset > 0 ? inset : 0);
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

/**
 * 字真变了才写。流式每来一批都会把已经到的字段原样再带一遍，照写就是换一个新的文本节点，
 * 人在浮层里正选着的字跟着没了。越写越长的（追问的答案），只把新长出来的那截接上去。
 */
function setText(el: Element, text: string): void {
  const node = el.childNodes.length === 1 ? el.firstChild : null;
  if (node?.nodeType === 3) {
    const t = node as Text;
    if (t.data === text) return;
    if (text.startsWith(t.data)) {
      t.appendData(text.slice(t.data.length));
      return;
    }
  }
  el.textContent = text;
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
