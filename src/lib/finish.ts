/**
 * 「读完」的判定规则。
 *
 * 单独抽出来是因为它有**两个**调用方：后台在 session 结算时置位 `finished`，
 * content script 在页内实时判定要不要弹回顾按钮。两边漂移的话，
 * 会出现"角标说读完了、点进去却说还没读完"这种自相矛盾的状态。
 */
export interface FinishInput {
  /** 已读段落的字数。 */
  wordsRead: number;
  /** 参与统计的正文字数。抽取失败时可能是 0。 */
  trackedWords: number;
  /** 正文最后一段是否进过阅读视野。 */
  reachedBottom: boolean;
  finishRatio: number;
}

/**
 * 读完 = 已读比例达标 **且** 正文最后一段进过视口。
 *
 * 只看比例会把"读了 80% 就关掉"算成读完；只看触底会把一路滚到底的跳读
 * 也算成读完。调用方还需自己保证"一旦置位不再回退"——这里是纯判定，不管状态。
 */
export function isFinished(input: FinishInput): boolean {
  if (input.trackedWords <= 0) return false;
  if (!input.reachedBottom) return false;
  return input.wordsRead / input.trackedWords >= input.finishRatio;
}
