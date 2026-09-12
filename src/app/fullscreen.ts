/**
 * 全屏阅读。手机上打开一篇文章就是整块屏：系统栏（状态栏、手势条）交给宿主收起来，
 * 顶栏那一排（返回、截、译、词）跟着滚动走——往下读就滑出去，往回滑一点就回来，
 * 滚到最上面一直露着。
 *
 * 为什么是滚动而不是"点一下切换"：正文里的单击和双击已经是点词 / 点句翻译，这个 App 手指
 * 落在正文上最常做的两件事都在那儿；再叠一个"点空白处显示顶栏"，落偏一点就成了收顶栏，
 * 反过来也一样。往回滑本来就是"我要找上面的东西"，不和任何手势抢。
 *
 * 为什么顶栏在最上面一直露着：那儿有返回键。一篇文章刚打开时把它也收掉，人就只剩系统的
 * 返回手势可用，而"往回滑能把它叫回来"这件事没人会告诉他。
 */

/** 往下读多少 px 才把顶栏收掉。 */
const HIDE_AT = 24;
/** 往回滑多少 px 算"要顶栏"。比 HIDE_AT 小一点：找顶栏的人希望它立刻来。 */
const SHOW_AT = 16;
/** 离正文顶端这么近就一直露着。 */
const TOP = 8;

/** 滚动的那个东西，生产里是 window；注进来是为了能在没有排版引擎的地方测。 */
export interface FullscreenHost {
  readonly scrollY: number;
  addEventListener(type: "scroll" | "resize", fn: () => void, options?: { passive?: boolean }): void;
  removeEventListener(type: "scroll" | "resize", fn: () => void): void;
}

export interface FullscreenOptions {
  /** 全屏的开关挂在它的 class 上（见 app.css 的 body.reader.immersive）。 */
  body: HTMLElement;
  /** 顶栏。收起它就是往上挪一格；高度要量给正文留白用。 */
  bar: HTMLElement;
  host: FullscreenHost;
  /** 让宿主收起（true）或放回（false）系统栏。老宿主没有这座桥就不传，只收顶栏。 */
  systemBars?: (hidden: boolean) => void;
}

export interface FullscreenReading {
  /** 顶栏现在露着没有。 */
  shown(): boolean;
  /** 露出顶栏，并从这一刻重新开始算滚动（生词单子那类"我要界面"的动作用它）。 */
  reveal(): void;
  /** 退出全屏：系统栏还给用户，顶栏回到常规位置。 */
  stop(): void;
}

/**
 * 进全屏，并把顶栏接到滚动上。
 *
 * 判断"在不在手机上"不在这里：调用方（read.ts）按宿主和指针粗细决定要不要叫这一下。
 */
export function startFullscreen(options: FullscreenOptions): FullscreenReading {
  const { body, bar, host, systemBars } = options;
  let shown = true;
  let stopped = false;
  /** 同一个方向上累计滑了多少，换方向就归零：读到一段停一下的抖动不该翻来覆去切顶栏。 */
  let run = 0;
  let last = host.scrollY;

  const measure = (): void => {
    // 顶栏浮在正文上，最上面那一屏要给它留出这么高（app.css 里的 --rbar-h）
    const h = Math.round(bar.getBoundingClientRect().height);
    if (h > 0) body.style.setProperty("--rbar-h", `${h}px`);
  };

  const apply = (next: boolean): void => {
    if (stopped || next === shown) return;
    shown = next;
    body.classList.toggle("chrome-hidden", !shown);
  };

  const onScroll = (): void => {
    const y = host.scrollY;
    const delta = y - last;
    last = y;
    if (y <= TOP) {
      run = 0;
      apply(true);
      return;
    }
    // 换方向：从零重新攒
    if ((delta > 0) !== (run > 0)) run = 0;
    run += delta;
    if (run >= HIDE_AT) apply(false);
    else if (run <= -SHOW_AT) apply(true);
  };

  const onResize = (): void => measure();

  body.classList.add("immersive");
  measure();
  systemBars?.(true);
  host.addEventListener("scroll", onScroll, { passive: true });
  host.addEventListener("resize", onResize, { passive: true });

  return {
    shown: () => shown,
    reveal() {
      run = 0;
      last = host.scrollY;
      apply(true);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      host.removeEventListener("scroll", onScroll);
      host.removeEventListener("resize", onResize);
      body.classList.remove("immersive", "chrome-hidden");
      shown = true;
      systemBars?.(false);
    },
  };
}
