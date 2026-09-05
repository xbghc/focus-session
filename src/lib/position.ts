import type { ReadingPosition } from "../types.ts";

/**
 * 「跳不跳、跳到哪」的判定。
 *
 * 抽出来是因为它全是边界条件，而这些边界条件只有在真实浏览器里才碰得到——
 * 放进 content script 就只能靠手点验证。这里是纯函数，`test/position.test.ts`
 * 把每一条都钉住了。
 */

/** 滚动位置在这个范围内都算「页面还在最上面」。 */
export const TOP_EPSILON_PX = 8;

/** 落在第一段且只滚进去这么点，跳了等于原地不动。 */
export const NEGLIGIBLE_OFFSET_PX = 120;

export interface RestoreInput {
  /** 设置里的总开关。 */
  enabled: boolean;
  /** 存下来的位置；没读过这篇就是 null。 */
  pos: ReadingPosition | null;
  /** 本次抽取到的段落，顺序即正文顺序。 */
  paragraphs: Array<{ hash: string }>;
  /** `location.hash`。非空 = 网页自带位置记录，浏览器会自己跳，别抢。 */
  urlHash: string;
  /** 判定时刻的 `window.scrollY`。非零 = 已经有人定位过这一页了。 */
  scrollY: number;
  /** 抽取期间用户是否已经动手了（滚轮、按键、触摸）。 */
  userScrolled: boolean;
}

export interface RestorePlan {
  /** 目标段落在**本次抽取**结果里的下标。 */
  index: number;
  /** 跳完之后目标段落的 `rect.top` 应该等于 `-offset`。 */
  offset: number;
  /** 靠指纹认出来的，还是靠序号兜的底。 */
  matched: "hash" | "index";
  /** 段落总数，供提示文案显示「第 N / 共 M 段」。 */
  total: number;
}

/**
 * 决定要不要跳回上次的位置。
 *
 * 五道否决，任何一条成立就不跳：
 *
 * 1. 关掉了；
 * 2. 这篇没有位置记录；
 * 3. **URL 带锚点**——网页自己带了位置记录，浏览器的落点优先；
 * 4. **页面已经不在顶部**——多半是浏览器自己恢复了滚动（F5 刷新的常态），
 *    它已经把人放回原处了，再跳一次只会打架；
 * 5. **用户已经自己滚了**——抽取要重试到 4 秒，这期间人可能早就读起来了，
 *    这时候把画面抽走是最恼人的一种交互。
 *
 * 另有两处「跳了也没意义」的短路：停在最后一段（上次读到结尾了，
 * 再打开多半是想重读或找东西，甩到文末只会挡路），以及落在第一段开头附近。
 */
export function planRestore(input: RestoreInput): RestorePlan | null {
  const pos = input.pos;
  if (!input.enabled || !pos) return null;
  if (input.urlHash !== "") return null;
  if (input.userScrolled) return null;
  if (!Number.isFinite(input.scrollY) || Math.abs(input.scrollY) > TOP_EPSILON_PX) return null;
  if (!Number.isFinite(pos.offset)) return null;

  const list = input.paragraphs;
  if (list.length === 0) return null;

  let at = list.findIndex((p) => p.hash === pos.hash);
  let matched: RestorePlan["matched"] = "hash";
  if (at < 0) {
    /*
     * 指纹没对上：文章被改过，或者这次抽取的结果和上次不同（懒加载、A/B 版式）。
     * 只有段落总数一模一样时才敢按序号兜底——**跳到错的地方比不跳更糟**，
     * 那会让人以为自己上次读到的是另一段。
     */
    if (pos.paragraphCount !== list.length) return null;
    if (!Number.isInteger(pos.index) || pos.index < 0 || pos.index >= list.length) return null;
    at = pos.index;
    matched = "index";
  }

  if (at >= list.length - 1) return null;
  if (at === 0 && pos.offset < NEGLIGIBLE_OFFSET_PX) return null;

  return { index: at, offset: Math.round(pos.offset), matched, total: list.length };
}

/**
 * 两次采到的位置算不算「同一个地方」。
 *
 * 用来省掉没必要的写入：安静读一屏时锚点段落不变，心跳每 5 秒送来一次同样的位置，
 * 没有这层过滤就是每 5 秒一次落盘。几十像素的抖动（浏览器缩放、图片撑开）也当没动过——
 * 恢复时差这点距离肉眼看不出来。
 */
const OFFSET_TOLERANCE_PX = 24;

export function samePosition(a: ReadingPosition | undefined | null, b: ReadingPosition): boolean {
  if (!a) return false;
  if (a.hash !== b.hash || a.index !== b.index) return false;
  return Math.abs(a.offset - b.offset) < OFFSET_TOLERANCE_PX;
}
