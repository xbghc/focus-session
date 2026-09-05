/** 一个 session 结束的原因，用于事后分析走神模式。 */
export type EndReason =
  | "idle" // 超过 idleTimeout 没有任何活动信号
  | "stall" // 有输入但滚动位置长时间不变（发呆）
  | "hidden" // 页面被隐藏（切标签、最小化）
  | "blur" // 窗口失焦（切到别的应用）
  | "unload" // 页面卸载/跳转
  | "recovered"; // 后台从最后一次心跳补记（标签页被关或 SW 重启）

/** 一次连续的注意力片段。 */
export interface Session {
  id: string;
  articleId: string;
  url: string;
  title: string;
  startTs: number;
  endTs: number;
  /** 本次 session 内新读到的字数（同一段落全局只算一次）。 */
  wordsRead: number;
  endReason: EndReason;
}

/** 段落级记录，供第二阶段的跳读（skim）检测使用。 */
export interface ParagraphRecord {
  index: number;
  /** 段落文本指纹，跨刷新/DOM 重排后仍能识别同一段落。 */
  hash: string;
  words: number;
  /** 记为已读的时刻；0 表示只是在视口里露过面、停留没到阈值。 */
  firstSeenTs: number;
  /** 累计在视口内的停留时长（仅统计 session 活跃期间）。 */
  dwellMs: number;
}

/** 同一篇文章内间隔不超过 episodeGapMs 的相邻 session 合成的「回合」。 */
export interface Episode {
  articleId: string;
  startTs: number;
  endTs: number;
  /** 合并进来的 session 数。 */
  sessionCount: number;
  /** 片段时长之和——回合里真正在计时的时间，不含片段之间的间隔。 */
  activeMs: number;
  wordsRead: number;
}

/**
 * 「上次读到哪」的位置记录。
 *
 * 认段落而不是认像素：`scrollY` 一遇到改版、换字号、图片懒加载完成、
 * 折叠区展开就全错，段落指纹在这些变化下都还指着同一段文字。
 */
export interface ReadingPosition {
  articleId: string;
  /** 视口里最靠上那个段落的文本指纹。 */
  hash: string;
  /** 该段落在本次抽取里的序号，指纹对不上时的退路。 */
  index: number;
  /**
   * 视口顶相对段落顶的距离（px），正数表示已经滚进段落内部。
   * 恢复后 `rect.top === -offset`，画面和离开时一致——包括被吸顶导航挡住的那部分。
   */
  offset: number;
  /** 记录时的段落总数。序号退路只在这个数字没变时才敢用。 */
  paragraphCount: number;
  savedTs: number;
}

/** 按文章聚合的统计。 */
export interface Article {
  id: string;
  url: string;
  title: string;
  /** Readability 正文全文字数（含未被段落覆盖的零散文本）。 */
  totalWords: number;
  /** 可观测段落的字数合计，是"已读比例"的分母。 */
  trackedWords: number;
  wordsRead: number;
  paragraphCount: number;
  readParagraphCount: number;
  sessionCount: number;
  totalMs: number;
  maxSessionMs: number;
  /** 回合数与最长回合（片段时长之和）。老记录没有这两个字段。 */
  episodeCount?: number;
  maxEpisodeMs?: number;
  /** 读到了新内容的片段时长之和——个人阅读速度的分母。老记录没有这个字段。 */
  readingMs?: number;
  /** 按一般速度读完全部可观测段落需要的毫秒数（分文种算好）。老记录没有，0 表示未知。 */
  expectedMs?: number;
  firstSeenTs: number;
  lastSeenTs: number;
  /** 正文最后一段是否曾进入视口。一旦为 true 就不再回退。 */
  reachedBottom: boolean;
  /** 已读比例达标 **且** 触底。同样 sticky——读完的文章不该因为改了阈值就变回没读完。 */
  finished: boolean;
  finishedTs: number | null;
}

export interface Settings {
  idleTimeoutMs: number;
  stallTimeoutMs: number;
  /** 短于此长度的 session 直接丢弃（alt-tab 抖动会产生大量碎片）。 */
  minSessionMs: number;
  /**
   * 走神阈值的自适应上限（毫秒）。
   *
   * 实际的静默上限 = max(idle/stall 阈值, 视口文字预计阅读时间 × READ_GRACE)，再夹到这个数以下。
   * 阅读本身不产生输入，一屏 400 词要读 100 秒；不自适应的话每读一屏就被切一刀。
   * 代价是真离开时最多高估这么长，有界。0 关闭自适应，退回固定阈值。
   */
  maxQuietMs: number;
  /** 段落在视口内至少停留多久才可能算"已读"——已读阈值的下限。 */
  paragraphDwellMs: number;
  /**
   * 段落已读阈值：停留达到「按正常速度读完这段所需时间」的这个比例即记为已读。
   * 正常阅读的停留 ≥ 0.8 倍、跳读（~650 wpm）只有 ~0.37 倍，0.5 落在两者之间。
   */
  readFraction: number;
  /** 同一篇文章内间隔不超过这个值（毫秒）的片段合成一个「回合」。 */
  episodeGapMs: number;
  excludedDomains: string[];
  /** 划词翻译总开关。关掉后 content script 不再挂选区监听。 */
  translateEnabled: boolean;
  /** 短于此长度的选区不翻译（避免误点选到一两个字符）。 */
  minSelectionChars: number;
  /**
   * 超过此词数不自动翻译，改为在浮层里给一个"翻译"按钮。
   *
   * 这道闸只拦**离谱的量**（顺手整段整节地选中），不拦"有点长"。
   * 实测一段 130 词的选区连讲解一起也才 400 多个输出 token、十秒内出完，
   * 为这种量级弹一次确认，等于把"选中即翻译"改成"选中再点一下才翻译"。
   *
   * 按词而不是按字符：读英文时"这段有多长"是按词感知的，
   * `unconstitutional` 一个词能顶三个短词的字符数，字符阈值会把它误判成长选区。
   */
  maxAutoSelectionWords: number;
  /** 发给 LLM 的上下文段落最多截取多少字符。 */
  contextChars: number;
  /**
   * 「英语老师模式」：除了翻译，再讲一句用法，并把多词选区里的生词逐个讲开。
   *
   * 关掉能省掉一半左右的输出 token，也让浮层早一两秒定住。
   * 只想要个译文的时候，这两样都是噪音。
   */
  explainVocab: boolean;
  /** 已读比例达到多少算读完（与触底是且的关系）。 */
  finishRatio: number;
  /**
   * 重新打开一篇读过的文章时，跳回上次读到的位置。
   *
   * 只在**网页自己没有定位过**时才跳：URL 带锚点、或浏览器已经恢复了滚动位置，
   * 都说明这一页已经有人安排好了落点，插件不该再抢。
   */
  restorePositionEnabled: boolean;
  /**
   * 文章回顾总开关。
   * 关掉后不再保存正文、也不再自动生成回顾材料——这是唯一一处**无需用户动作
   * 就会花 token** 的地方，得给个能关的闸。已生成的材料不受影响。
   */
  articleReviewEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  idleTimeoutMs: 30_000,
  stallTimeoutMs: 90_000,
  minSessionMs: 3_000,
  maxQuietMs: 300_000, // ActivityWatch 的 AFK 默认是 180s、RescueTime 是 5 分钟；一屏文字读满也就这个量级
  paragraphDwellMs: 1_000,
  readFraction: 0.5,
  episodeGapMs: 300_000,
  excludedDomains: [],
  translateEnabled: true,
  minSelectionChars: 2,
  maxAutoSelectionWords: 200, // ≈ 1100 字符（英文均值 5.5 字符/词），大致是三四段
  contextChars: 600,
  explainVocab: true,
  finishRatio: 0.8,
  restorePositionEnabled: true,
  articleReviewEnabled: true,
};

/**
 * 自动翻译上限能填到的最大值（设置页的区间上界，迁移换算也夹到这里）。
 *
 * 按英文均值 5.5 字符/词，360 词 ≈ 1980 字符，刚好压在 HARD_MAX_CHARS 之下——
 * 再往上填是空档：那些选区根本到不了这道闸，会先被硬上限拦掉。
 */
export const MAX_AUTO_WORDS = 360;

/**
 * content script 在 session 结束时上报的段落快照。
 * `dwellMs` 是**自上次快照以来的增量**，后台累加；发累计值的话同一次页面加载里
 * 结束 30 个 session 就会把同一段落加 30 遍。
 */
export interface ParagraphSnapshot {
  index: number;
  hash: string;
  words: number;
  /** 记为已读的时刻；0 表示还没读到阈值。 */
  firstSeenTs: number;
  dwellMs: number;
}

export interface ArticleMeta {
  articleId: string;
  url: string;
  title: string;
  totalWords: number;
  trackedWords: number;
  paragraphCount: number;
  /** 按一般速度读完全部可观测段落需要的毫秒数，分文种算好（见 lib/reading.ts）。 */
  expectedMs: number;
}

/** 供 popup 显示的当前页实时状态。 */
export interface PageState {
  tracked: boolean;
  /** 未追踪时说明原因（排除域名 / 非文章页）。 */
  reason?: string;
  /**
   * 没识别为文章的页面上，划词翻译的临时开关。
   * "available"：可以从 popup 为本页开启；"on"：已经开着，只对本次加载有效。
   * 追踪中的文章页本来就挂着监听；被排除的域名、总开关关着时都不给这个字段——
   * popup 不该画一个点不动的按钮。
   */
  translateHere?: "available" | "on";
  articleId?: string;
  title?: string;
  totalWords?: number;
  trackedWords?: number;
  wordsRead?: number;
  paragraphCount?: number;
  readParagraphCount?: number;
  /** 当前正在计时的 session 起点；null 表示此刻没在计时。 */
  activeSince?: number | null;
  /** 本次页面加载期间已完成的 session。 */
  sessionsThisLoad?: Array<{ startTs: number; endTs: number; wordsRead: number; endReason: EndReason }>;
  /** 当前视口里的文字按正常速度读完需要多久。 */
  visibleExpectedMs?: number;
  /** 此刻的静默上限：没有任何输入超过这么久才算走神。 */
  idleLimitMs?: number;
  /** 这篇还要读多久，见 lib/readingTime.ts。 */
  estimate?: ReadingEstimate;
}

/* ---------- 消息协议 ---------- */

export type ContentToBg =
  | { type: "article:meta"; meta: ArticleMeta }
  | { type: "session:start"; articleId: string; url: string; title: string; startTs: number }
  /** `position` 捎在心跳上而不另开一条消息：这样它天然享有 session 的补记链路。 */
  | { type: "session:heartbeat"; articleId: string; now: number; wordsRead: number; position?: ReadingPosition }
  | {
      type: "session:end";
      articleId: string;
      startTs: number;
      endTs: number;
      wordsRead: number;
      endReason: EndReason;
      discard: boolean;
      reachedBottom: boolean;
      paragraphs: ParagraphSnapshot[];
      position?: ReadingPosition;
    }
  | { type: "settings:get" }
  | { type: "article:read-state"; articleId: string }
  | { type: "sw:ping" }
  | { type: "article:text"; articleId: string; text: string; fullChars: number }
  /** 页内判定读完。后台当场落盘并建回顾卡，不等 session 结算。 */
  | { type: "article:finished"; articleId: string; ts: number }
  /** 页内的回顾按钮被点了。content script 开不了标签页，得后台代劳。 */
  | { type: "review:open"; articleId: string }
  | { type: "options:open" };

export type PopupToBg =
  | { type: "articles:list" }
  | { type: "article:sessions"; articleId: string }
  | { type: "stats:overview" }
  | { type: "data:export" }
  /** 把另一台设备导出的文件合并进来。规则见 lib/merge.ts。 */
  | { type: "data:import"; bundle: unknown }
  | { type: "data:clear" }
  | { type: "settings:get" }
  | { type: "settings:set"; settings: Partial<Settings> }
  /* ---- 划词与复习 ---- */
  | { type: "snippets:list"; articleId?: string }
  | { type: "snippet:delete"; id: string }
  | { type: "snippet:enqueue"; id: string }
  | { type: "article:finish"; articleId: string; finished: boolean }
  | { type: "review:due"; limit?: number }
  | { type: "review:grade"; cardId: string; grade: 1 | 2 | 3 | 4 }
  | { type: "review:stats" }
  | { type: "review:assist"; cardId: string; mode: AssistMode }
  /* ---- 文章回顾 ---- */
  | { type: "article:review"; articleId: string; regenerate?: boolean }
  | { type: "article:review-due"; limit?: number; articleId?: string }
  /** 只读查询，**不会触发生成**——打开一次 popup 不该花掉一次 LLM 调用。 */
  | { type: "article:review-state"; articleId: string }
  | { type: "article:review-grade"; articleId: string; grade: 1 | 2 | 3 | 4 }
  /* ---- LLM 配置（独立于 Settings，见 llm.ts 的说明）---- */
  | { type: "llm:get" }
  | { type: "llm:set"; config: Partial<LlmConfig> }
  | { type: "llm:test" }
  | { type: "llm:usage" }
  /* ---- 诊断日志（设置页）---- */
  | { type: "llm:log" }
  | { type: "llm:log-clear" };

export type PopupToContent =
  | { type: "page:state" }
  /** 「本页启用划词翻译」：只对本次加载有效。应答和 page:state 一样是更新后的 PageState。 */
  | { type: "page:translate-here" };

export type AnyMessage = ContentToBg | PopupToBg | PopupToContent;

export interface ReadState {
  /** 已读段落的文本指纹，用于跨刷新去重。 */
  hashes: string[];
}

export type ReasonBreakdown = Record<EndReason, { count: number; ms: number }>;

export interface Overview {
  /** 统计窗口与回合合并阈值一并回传：阈值的选择是结果的一部分，界面上要写明。 */
  windowMs: number;
  episodeGapMs: number;
  sessionCount: number;
  totalMs: number;
  /** 原始片段的分位数。它量的是两次输入事件的间隔，不是注意力长度——保留供对照。 */
  medianMs: number;
  p90Ms: number;
  articleCount: number;
  wordsRead: number;
  /** 读到新段落的片段的时长之和。 */
  readingMs: number;
  episodeCount: number;
  /** 回合的分位数按 activeMs（片段时长之和）算。 */
  episodeMedianMs: number;
  episodeP90Ms: number;
  longestEpisodeMs: number;
  byReason: ReasonBreakdown;
  /** 以切走/失焦结束的片段数 ÷ 专注小时数。Mark 等人量的就是这个口径。 */
  switchesPerHour: number;
}

/* ==================== 预计阅读时间 ==================== */

/** 阅读速度的证据：读了多少字、花了多少时间。字数是混合口径（中日韩按字、拉丁按词）。 */
export interface SpeedEvidence {
  words: number;
  ms: number;
}

/**
 * 个人阅读速度的缓存摘要，每次 session 结算时由后台重算并写入 `speed` 键。
 * 只统计**读到了新内容**的片段：重读、停留、页面开着没在读的时间不该拉低速度。
 */
export interface SpeedSummary extends SpeedEvidence {
  sessions: number;
  /** 统计窗口天数；0 表示近期证据不够、退回了全部历史。 */
  windowDays: number;
  updatedTs: number;
}

/** 要估的目标：多少字，按一般速度要多久（文种构成已折进去）。 */
export interface ReadingTarget {
  words: number;
  expectedMs: number;
}

/** 估计的依据，界面据此措辞：这一篇自己的节奏 / 你的整体速度 / 一般速度。 */
export type EstimateBasis = "article" | "personal" | "default";

export interface ReadingEstimate {
  /** 估的是多少字。0 表示没什么可估的（都读过了）。 */
  words: number;
  ms: number;
  /** 实际采用的速度，字/分，供界面说明。 */
  wordsPerMinute: number;
  basis: EstimateBasis;
  /** 个人证据覆盖的天数，0 = 全部历史。basis 为 personal 时界面用它措辞。 */
  windowDays: number;
}

export interface ExportBundle {
  /**
   * 4：加了 `positions`。导入时 3 和 4 都认——安卓 App 和扩展之间靠这份文件互相合并，
   * 两边不一定同时升级。
   */
  schema: 4;
  exportedAt: number;
  settings: Settings;
  articles: Article[];
  sessions: Session[];
  paragraphs: Record<string, ParagraphRecord[]>;
  /**
   * 「上次读到哪」。3 版不导出它（外部统计工具拿它没用），4 版导出：
   * 手机上读到一半、回到电脑接着读，靠的正是这一条。
   */
  positions: ReadingPosition[];
  snippets: Snippet[];
  cards: StoredCard[];
  /*
   * 只导出回顾材料和调度状态，**不导出文章正文**：
   * 几百篇 × 30KB 会让备份文件涨到几 MB，而正文是可再抓取的输入，不是用户的产出。
   */
  articleReviews: ArticleReview[];
  articleCards: ArticleCard[];
  /** 不含 apiKey——导出文件常被随手分享。 */
  llm: Omit<LlmConfig, "apiKey"> & { apiKeySet: boolean };
}

/** 导入另一台设备的导出文件的结果。合并了什么见 lib/merge.ts 的 MergeReport。 */
export type ImportOutcome =
  | { ok: true; report: Record<string, number>; message: string }
  | { ok: false; error: string };

/* ==================== 划词翻译 ==================== */

/**
 * 选区的语言学粒度。**由客户端按词数判定，不采信 LLM 的说法**——
 * 入队规则依赖它，不能让模型的一次胡乱输出把整段句子塞进复习队列。
 */
export type SnippetKind = "word" | "phrase" | "sentence";

/** content script 发起翻译时携带的全部信息。 */
export interface TranslateRequest {
  articleId: string;
  url: string;
  articleTitle: string;
  /** 选中的原文，已 trim 并压缩连续空白。 */
  text: string;
  /** 选区所在段落（截断到 contextChars），给 LLM 做语境判断用——**只判断义项，不参与讲解**。 */
  context: string;
  kind: SnippetKind;
  /**
   * 要不要讲用法和生词。和 `kind` 一样由客户端决定并随请求带上——
   * 设置在 content script 手里，后台不必为一次翻译再读一遍。
   */
  explainVocab: boolean;
}

/**
 * 讲解里的一条生词。
 *
 * 只出现在**多词选区**上：选中一句话时，句子本身给译文，句子里那些不认识的词
 * 逐条讲开。单词选区不需要这个——那时整条记录讲的就是它自己。
 *
 * 讲的**只能是选中文本里的词**：上下文段落是喂给模型判断义项的，不是讲解材料。
 * 用户选了什么就讲什么，模型讲到选区外的词由 `inSelection` 挡掉。
 */
export interface VocabNote {
  /** 原文里出现的形式（`leaks` 而不是 `leak`），这样才能在句子里对上号。 */
  word: string;
  phonetic: string | null;
  pos: string | null;
  /** 它在**这一句**里的意思，不是词典义项的罗列。 */
  meaning: string;
  /** 搭配、词根、近义辨析——老师会多说的那一句。没什么可说就是 null。 */
  note: string | null;
}

/** 一条选区上最多讲几个生词。再多就不是讲解而是词汇表了，浮层也装不下。 */
export const MAX_VOCAB = 5;

/** LLM 返回并被规范化后的翻译结果。 */
export interface TranslationResult {
  translation: string;
  /** 结合本文语境的解释；这是"译文 + 上下文解释"里的第二半。 */
  contextNote: string;
  /** 词性，仅词/短语有。 */
  pos: string | null;
  phonetic: string | null;
  /** 词元（原形），跨文章合并同一个词靠它。 */
  lemma: string | null;
  /** 这个词/短语怎么用：搭配、词根、近义辨析。整句没有"怎么用"，恒为 null。 */
  usage: string | null;
  /** 选区里值得讲的生词。单词选区恒为空数组。 */
  vocab: VocabNote[];
}

/** 一条划词记录。同一个 lemma 跨文章会有多条 snippet，但只对应一张卡。 */
export interface Snippet {
  id: string;
  articleId: string;
  url: string;
  articleTitle: string;
  text: string;
  kind: SnippetKind;
  context: string;
  createdTs: number;
  translation: string;
  contextNote: string;
  pos: string | null;
  phonetic: string | null;
  lemma: string | null;
  /** 用法提示。老版本的记录没有这个字段，读出来时补 null。 */
  usage: string | null;
  /** 生词讲解。老版本的记录没有这个字段，读出来时补空数组。 */
  vocab: VocabNote[];
  /** 关联的复习卡片；整句默认为 null，可手动入队。 */
  cardId: string | null;
}

/* ==================== 复习 ==================== */

/**
 * FSRS 卡片的持久化形态。
 *
 * ts-fsrs 的 `Card` 用 `Date` 表示 due/last_review，而 chrome.storage 存的是
 * structured clone —— Date 能存但读回来在 JSON 导出/导入链路上会退化成字符串，
 * 静默喂给 fsrs() 会算出错误的间隔。这里统一存毫秒时间戳，进出算法时显式转换。
 */
/** 与 ts-fsrs 的 `Card` 一一对应的调度状态。生词卡和文章卡共用这一层。 */
export interface FsrsState {
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  /** 0=New 1=Learning 2=Review 3=Relearning */
  state: number;
  lastReview: number | null;
}

export interface StoredCard extends FsrsState {
  id: string;
  /** 卡面：词或短语的原形（lemma 优先，否则用选中原文）。 */
  key: string;
  /** 这张卡关联的所有 snippet，按时间升序；复习时展示最近一条的语境。 */
  snippetIds: string[];
}

/** 复习时按需向 LLM 追加要求的三种模式。翻卡本身不花 token。 */
export type AssistMode = "example" | "explain" | "quiz";

export interface ReviewStats {
  total: number;
  dueNow: number;
  newCount: number;
  learningCount: number;
  reviewCount: number;
  /** 未来 7 天每天的到期数量，索引 0 是今天。 */
  forecast: number[];
}

/** dashboard/sidepanel 拿到的复习卡片视图。 */
export interface ReviewCardView {
  card: StoredCard;
  /** 最近一次划到它的那条记录，卡背展示它的译文与语境解释。 */
  snippet: Snippet | null;
  /** 该卡在多少篇不同文章里出现过。 */
  articleCount: number;
}

/* ==================== LLM 配置 ==================== */

/**
 * 单独存一个 storage key，**不并进 Settings**。
 * content script 启动时会把整个 settings 对象读进页面上下文，
 * 而 content script 与网页共享同一个进程——API key 绝不能出现在那里。
 * 翻译请求一律由 background 代发。
 */
export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * 输出上限。**这是上限不是花销**——只有真生成出来的 token 才计费，
   * 压低它换不来省钱，只换来"输出被 max_tokens 截断"。
   * 所以留够：实测最长的一次（200 词选区 + 讲解）用了 671 个。
   */
  maxTokens: number;
  /**
   * 单次请求超时，**流式下是整条流的总时限**，不是首字节。
   * 实测非流式约 3s、开讲解的长选区约 10s；上限抬高之后这里也得跟着松，
   * 否则只是把"被截断"换成了"超时"。
   */
  timeoutMs: number;
}

export const DEFAULT_LLM: LlmConfig = {
  apiKey: "",
  baseUrl: "https://api.minimaxi.com/anthropic",
  model: "MiniMax-M3-highspeed",
  maxTokens: 4096,
  timeoutMs: 60_000,
};

/** 累计用量，给用户一个"烧了多少"的直观数字。 */
export interface LlmUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
  lastTs: number | null;
}

export const EMPTY_USAGE: LlmUsage = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  errors: 0,
  lastTs: null,
};

/**
 * 一次 LLM 调用失败的现场，给设置页的「诊断日志」用。
 * 只存本机；不进 ExportBundle（那份文件常被随手分享），自己单独导出；「清空全部记录」时一起清掉。
 */
export interface LlmFailure {
  ts: number;
  /** 哪条路径出的错 */
  source: "translate" | "test" | "assist" | "articleReview";
  /** LlmError 的 kind（config / http / network / timeout / parse / abort）；不是 LlmError 的记 unknown */
  kind: string;
  /** HTTP 状态码，只有 http 类失败才有 */
  status: number | null;
  message: string;
  /** 模型的 stop_reason 原值——只有拿到了响应的失败才有 */
  stopReason: string | null;
  /** 模型的完整输出——只有解析阶段的失败才有；超长的截掉尾部 */
  raw: string | null;
  /** 流式翻译下浮层是否已经显示过译文：「先显示再报错」和「一开始就报错」是两类问题 */
  partialShown: boolean | null;
  /** 当时请求里值得留下的部分，各路径各留各的；不存文章正文 */
  request: Record<string, string | number | boolean | null>;
  model: string;
  maxTokens: number;
}

/** 诊断日志的导出格式。和 ExportBundle 一样不含 apiKey。 */
export interface LlmLogBundle {
  schema: 1;
  exportedAt: number;
  /** 扩展版本，来自 manifest */
  version: string;
  llm: ExportBundle["llm"];
  failures: LlmFailure[];
}

/* ==================== 流式翻译 ==================== */

/** 划词翻译的 port 名。 */
export const PORT_TRANSLATE = "translate";

/**
 * 流式过程中已经到齐的字段。**只在某个字段完整闭合时才更新**，
 * 不做逐字推送——JSON 字符串的转义在半途无法安全解析，而且译文
 * 整块出现比一个字一个字蹦要好读。
 *
 * 字段顺序即到达顺序：system prompt 里让 translation 排第一，
 * 它闭合时（约 800ms）就能显示，不必等后面的语境解释生成完（约 1600ms）。
 */
export interface PartialTranslation {
  translation: string | null;
  phonetic: string | null;
  pos: string | null;
  contextNote: string | null;
  usage: string | null;
  /** **已经闭合**的那几条生词。半个对象不推，同字符串字段的规矩。 */
  vocab: VocabNote[];
}

/** 一次翻译的最终结果，background 与 content script 共用。 */
export type TranslateReply =
  | { ok: true; snippet: Snippet; cached: boolean }
  | { ok: false; error: string; needsConfig: boolean };

export type TranslatePortIn = { type: "start"; req: TranslateRequest };

export type TranslatePortOut =
  | { type: "partial"; partial: PartialTranslation }
  | { type: "done"; res: TranslateReply };

/* ==================== 文章回顾 ==================== */

/**
 * 读完的文章正文，供事后回顾用。
 *
 * **只在读到 finishRatio 时才存**——每篇打开两眼就走的页面都存全文，
 * 一年下来是几百 MB，而那些页面你根本不会想回顾。
 */
export interface ArticleText {
  articleId: string;
  /** 段落原文，空行分隔。保留段落边界对生成大纲有用。 */
  text: string;
  /** 截断前的字符数。截断时要告诉模型这只是前 N%，否则它会把截断处当结尾。 */
  fullChars: number;
  savedTs: number;
}

/** LLM 生成的回顾材料。生成一次就存下来，之后每次复习都读存的。 */
export interface ArticleReview {
  articleId: string;
  /** 要点大纲，按文章自己的脉络排。 */
  outline: string[];
  /** 回想问题。翻开大纲前先自己想一遍，比直接读摘要记得牢。 */
  questions: string[];
  generatedTs: number;
  /** 生成时用的模型；日后换了模型，能看出旧材料的来历。 */
  model: string;
}

/** 文章级回顾卡。一篇文章一张，articleId 就是身份，不另发 id。 */
export interface ArticleCard extends FsrsState {
  articleId: string;
}

/** 「拿回顾材料」这一步的结果。没有材料时界面要能分辨该引导用户做什么。 */
export interface ArticleReviewOutcome {
  ok: boolean;
  review?: ArticleReview;
  error?: string;
  /** 缺 key：引导去设置页。 */
  needsConfig?: boolean;
  /** 正文没存下来：这篇是功能上线前读的，或者当时没读够 finishRatio。 */
  noText?: boolean;
}

/** 某篇文章的回顾就绪程度，供 popup 显示一行状态。 */
export interface ArticleReviewState {
  finished: boolean;
  /** 正文已存下：读到 finishRatio 了。 */
  hasText: boolean;
  /** 材料已生成，点开就能看。 */
  hasReview: boolean;
  /** 已进入回顾队列（= 已读完）。 */
  carded: boolean;
}

/** dashboard 拿到的文章回顾视图。 */
export interface ArticleReviewView {
  card: ArticleCard;
  article: Article;
  /** 生成失败或还没生成时为 null，界面上给「生成」按钮。 */
  review: ArticleReview | null;
}
