import { test } from "node:test";
import assert from "node:assert/strict";
import type { Article, ParagraphRecord, ReadingPosition, Session, Snippet, StoredCard } from "../src/types.ts";
import { type DataSet, describeReport, emptyDataSet, mergeData, parseBundle, pickFsrs } from "../src/lib/merge.ts";
import { gradeCard, newCard, newFsrs } from "../src/lib/review.ts";

const OPTS = { now: 9_000_000, finishRatio: 0.8, episodeGapMs: 300_000 };
const A = "https://example.com/a";

const article = (over: Partial<Article> = {}): Article => ({
  id: A,
  url: A,
  title: "文章 A",
  totalWords: 1000,
  trackedWords: 1000,
  wordsRead: 0,
  paragraphCount: 10,
  readParagraphCount: 0,
  sessionCount: 0,
  totalMs: 0,
  maxSessionMs: 0,
  firstSeenTs: 1_000,
  lastSeenTs: 1_000,
  reachedBottom: false,
  finished: false,
  finishedTs: null,
  ...over,
});

const session = (startTs: number, endTs: number, wordsRead = 100, over: Partial<Session> = {}): Session => ({
  id: `s${startTs}`,
  articleId: A,
  url: A,
  title: "文章 A",
  startTs,
  endTs,
  wordsRead,
  endReason: "idle",
  ...over,
});

const para = (index: number, firstSeenTs: number, dwellMs = 1_000): ParagraphRecord => ({
  index,
  hash: `h${index}`,
  words: 100,
  firstSeenTs,
  dwellMs,
});

const snippet = (id: string, text: string, cardId: string | null, createdTs = 1): Snippet => ({
  id,
  articleId: A,
  url: A,
  articleTitle: "文章 A",
  text,
  kind: "word",
  context: `… ${text} …`,
  createdTs,
  translation: "译",
  contextNote: "",
  pos: null,
  phonetic: null,
  lemma: text,
  usage: null,
  vocab: [],
  cardId,
});

const position = (hash: string, savedTs: number): ReadingPosition => ({
  articleId: A,
  hash,
  index: 3,
  offset: 40,
  paragraphCount: 10,
  savedTs,
});

const dataset = (partial: Partial<DataSet>): DataSet => ({ ...emptyDataSet(), ...partial });

/** 数组按 id 排好序再比，两边合并的先后不同只影响顺序。 */
const byId = <T extends { id: string }>(list: T[]): T[] => [...list].sort((a, b) => a.id.localeCompare(b.id));

test("空本机导入 = 拿到对方的全部记录", () => {
  const theirs = dataset({
    articles: { [A]: article() },
    sessions: [session(10_000, 70_000)],
    paragraphs: { [A]: [para(0, 20_000)] },
    snippets: [snippet("s1", "leak", "c1")],
    cards: [newCard("c1", "leak", ["s1"], 1)],
    positions: { [A]: position("h0", 60_000) },
  });
  const { data, report } = mergeData(emptyDataSet(), theirs, OPTS);
  assert.equal(data.sessions.length, 1);
  assert.equal(data.snippets.length, 1);
  assert.equal(data.cards.length, 1);
  assert.equal(data.paragraphs[A]!.length, 1);
  assert.equal(data.positions[A]!.hash, "h0");
  assert.equal(report.articlesAdded, 1);
  assert.equal(report.sessionsAdded, 1);
  assert.equal(report.snippetsAdded, 1);
  assert.equal(report.cardsAdded, 1);
  assert.equal(report.positionsUpdated, 1);
  // 聚合数字从明细重算
  assert.equal(data.articles[A]!.wordsRead, 100);
  assert.equal(data.articles[A]!.sessionCount, 1);
  assert.equal(data.articles[A]!.totalMs, 60_000);
});

test("幂等：同一份文件导两次，第二次什么都不变、报告全零", () => {
  const mine = dataset({
    articles: { [A]: article({ wordsRead: 300 }) },
    sessions: [session(10_000, 70_000)],
    paragraphs: { [A]: [para(0, 20_000), para(1, 30_000), para(2, 40_000)] },
    snippets: [snippet("s1", "leak", "c1")],
    cards: [newCard("c1", "leak", ["s1"], 1)],
  });
  const theirs = dataset({
    articles: { [A]: article({ lastSeenTs: 5_000 }) },
    sessions: [session(100_000, 160_000, 200), session(10_000, 80_000, 150)],
    paragraphs: { [A]: [para(2, 35_000), para(3, 110_000), para(4, 120_000)] },
    snippets: [snippet("s2", "tacit", "c9", 2), snippet("s3", "leaks", "c8", 3)],
    cards: [newCard("c9", "tacit", ["s2"], 2), newCard("c8", "leak", ["s3"], 3)],
    positions: { [A]: position("h4", 150_000) },
  });
  const first = mergeData(mine, theirs, OPTS);
  const second = mergeData(first.data, theirs, OPTS);
  assert.deepEqual(second.data, first.data);
  assert.deepEqual(second.report, {
    sessionsAdded: 0,
    sessionsUpdated: 0,
    articlesAdded: 0,
    articlesUpdated: 0,
    snippetsAdded: 0,
    cardsAdded: 0,
    cardsMerged: 0,
    articleCardsAdded: 0,
    reviewsAdded: 0,
    positionsUpdated: 0,
  });
  assert.equal(describeReport(second.report), "没有新内容，本机已经有这些记录了");
});

test("对称：两边互相导入之后收敛到同一份记录", () => {
  const a = dataset({
    articles: { [A]: article({ lastSeenTs: 2_000 }) },
    sessions: [session(10_000, 70_000)],
    paragraphs: { [A]: [para(0, 20_000), para(1, 30_000)] },
    snippets: [snippet("s1", "leak", "c1", 1)],
    cards: [newCard("c1", "leak", ["s1"], 1)],
    positions: { [A]: position("h1", 60_000) },
  });
  const b = dataset({
    articles: { [A]: article({ lastSeenTs: 3_000, title: "文章 A（手机）" }) },
    sessions: [session(100_000, 160_000, 300)],
    paragraphs: { [A]: [para(1, 105_000), para(2, 110_000), para(3, 120_000)] },
    snippets: [snippet("s2", "tacit", "c2", 2), snippet("s3", "leaks", "c3", 3)],
    cards: [newCard("c2", "tacit", ["s2"], 2), newCard("c3", "leak", ["s3"], 3)],
    positions: { [A]: position("h3", 150_000) },
  });
  const ab = mergeData(a, b, OPTS).data;
  const ba = mergeData(b, a, OPTS).data;

  assert.deepEqual(byId(ab.sessions), byId(ba.sessions));
  assert.deepEqual(ab.paragraphs, ba.paragraphs);
  assert.deepEqual(ab.positions, ba.positions);
  assert.deepEqual(ab.articles, ba.articles, "文章记录连标题都一致：以最近一次抽取为准");
  assert.equal(ab.articles[A]!.title, "文章 A（手机）");
  // 卡的 id 各留各的，但词元集合与出处集合一致
  const shape = (d: DataSet) =>
    [...d.cards].map((c) => ({ key: c.key, snippetIds: [...c.snippetIds].sort() })).sort((x, y) => x.key.localeCompare(y.key));
  assert.deepEqual(shape(ab), shape(ba));
  assert.deepEqual(shape(ab), [
    { key: "leak", snippetIds: ["s1", "s3"] },
    { key: "tacit", snippetIds: ["s2"] },
  ]);
  assert.deepEqual(byId(ab.snippets).map((s) => s.id), ["s1", "s2", "s3"]);
});

test("生词卡按词元合并成一张：出处并集，对方的划词改挂本机的卡", () => {
  const mine = dataset({
    snippets: [snippet("s1", "leak", "c1")],
    cards: [newCard("c1", "leak", ["s1"], 1)],
  });
  const theirs = dataset({
    snippets: [snippet("s2", "leaks", "c9", 5)],
    cards: [newCard("c9", "leak", ["s2"], 5)],
  });
  const { data, report } = mergeData(mine, theirs, OPTS);
  assert.equal(data.cards.length, 1);
  assert.equal(data.cards[0]!.id, "c1");
  assert.deepEqual(data.cards[0]!.snippetIds, ["s1", "s2"]);
  assert.equal(data.snippets.find((s) => s.id === "s2")!.cardId, "c1");
  assert.equal(report.cardsMerged, 1);
  assert.equal(report.cardsAdded, 0);
});

test("两边都复习过同一张卡：取最近复习过的那份排期", () => {
  const base = newCard("c1", "leak", ["s1"], 1_000);
  const mine = gradeCard(base, 3, 5_000);
  const theirs = gradeCard({ ...base, id: "c9" }, 1, 9_000);
  const { data } = mergeData(
    dataset({ cards: [mine], snippets: [snippet("s1", "leak", "c1")] }),
    dataset({ cards: [theirs], snippets: [snippet("s1", "leak", "c9")] }),
    OPTS,
  );
  const merged = data.cards[0]!;
  assert.equal(merged.id, "c1", "身份是本机的");
  assert.equal(merged.lastReview, 9_000, "排期是对方那次更晚的复习");
  assert.equal(merged.due, theirs.due);
  assert.equal(merged.lapses, theirs.lapses);

  // 反过来：本机更新，就保留本机的
  const { data: d2 } = mergeData(dataset({ cards: [theirs] }), dataset({ cards: [mine] }), OPTS);
  assert.equal(d2.cards[0]!.lastReview, 9_000);
});

test("pickFsrs：没复习过的排最早，都没复习过看复习次数，再平取本机", () => {
  const fresh = newFsrs(1_000);
  const reviewed = { ...fresh, lastReview: 2_000, reps: 1 };
  assert.equal(pickFsrs(fresh, reviewed), reviewed);
  assert.equal(pickFsrs(reviewed, fresh), reviewed);
  const a = { ...fresh, reps: 2 };
  const b = { ...fresh, reps: 3 };
  assert.equal(pickFsrs(a, b), b);
  assert.equal(pickFsrs(a, { ...a }), a);
});

test("session 按 (articleId, startTs) 认身份：结束更晚的那份赢，id 保留本机的", () => {
  const mine = dataset({ sessions: [session(10_000, 70_000, 100, { id: "mine" })] });
  const later = mergeData(mine, dataset({ sessions: [session(10_000, 80_000, 120, { id: "theirs" })] }), OPTS);
  assert.equal(later.data.sessions.length, 1);
  assert.equal(later.data.sessions[0]!.endTs, 80_000);
  assert.equal(later.data.sessions[0]!.wordsRead, 120);
  assert.equal(later.data.sessions[0]!.id, "mine");
  assert.equal(later.report.sessionsUpdated, 1);

  const earlier = mergeData(mine, dataset({ sessions: [session(10_000, 60_000, 50)] }), OPTS);
  assert.equal(earlier.data.sessions[0]!.endTs, 70_000, "补记出来的更短的那份不覆盖");
  assert.equal(earlier.report.sessionsUpdated, 0);
});

test("段落按指纹合并：firstSeenTs 取最早的非零值，dwellMs 取最大而不是相加", () => {
  const mine = dataset({ paragraphs: { [A]: [para(0, 0, 500), para(1, 30_000, 200)] } });
  const theirs = dataset({ paragraphs: { [A]: [para(0, 40_000, 800), para(1, 25_000, 100), para(2, 50_000, 300)] } });
  const once = mergeData(mine, theirs, OPTS).data;
  const list = once.paragraphs[A]!;
  assert.deepEqual(
    list.map((p) => [p.hash, p.firstSeenTs, p.dwellMs]),
    [
      ["h0", 40_000, 800],
      ["h1", 25_000, 200],
      ["h2", 50_000, 300],
    ],
  );
  const twice = mergeData(once, theirs, OPTS).data;
  assert.deepEqual(twice.paragraphs, once.paragraphs, "再导一次停留时长不翻倍");
});

test("两台设备各读一半，合起来够阈值且触底：置位读完并建回顾卡", () => {
  const mine = dataset({
    articles: { [A]: article({ wordsRead: 500, readParagraphCount: 5 }) },
    sessions: [session(10_000, 70_000, 500)],
    paragraphs: { [A]: [0, 1, 2, 3, 4].map((i) => para(i, 20_000 + i)) },
  });
  const theirs = dataset({
    articles: { [A]: article({ wordsRead: 500, readParagraphCount: 5, reachedBottom: true, lastSeenTs: 200_000 }) },
    sessions: [session(100_000, 160_000, 500)],
    paragraphs: { [A]: [5, 6, 7, 8, 9].map((i) => para(i, 120_000 + i)) },
  });
  const { data, report } = mergeData(mine, theirs, OPTS);
  const a = data.articles[A]!;
  assert.equal(a.wordsRead, 1000);
  assert.equal(a.readParagraphCount, 10);
  assert.equal(a.reachedBottom, true);
  assert.equal(a.finished, true);
  assert.equal(a.finishedTs, 160_000, "读完时刻是最后一个片段的结束时刻");
  assert.equal(a.sessionCount, 2);
  assert.equal(a.totalMs, 120_000);
  assert.equal(a.episodeCount, 1, "两个片段只隔 30 秒，按 5 分钟的合并间隔是一个回合");
  assert.equal(report.articleCardsAdded, 1);
});

test("回合按本机的合并间隔重算", () => {
  const mine = dataset({ articles: { [A]: article() }, sessions: [session(10_000, 70_000)] });
  const theirs = dataset({ sessions: [session(100_000, 160_000)] });
  assert.equal(mergeData(mine, theirs, OPTS).data.articles[A]!.episodeCount, 1, "隔 30 秒，5 分钟内算一个回合");
  assert.equal(mergeData(mine, theirs, { ...OPTS, episodeGapMs: 10_000 }).data.articles[A]!.episodeCount, 2);
});

test("读完标记是 sticky 的：两边都读完时完成时刻取更早的；都没有卡就不凭空建卡", () => {
  const mine = dataset({ articles: { [A]: article({ finished: true, finishedTs: 8_000 }) } });
  const theirs = dataset({ articles: { [A]: article({ finished: true, finishedTs: 5_000 }) } });
  const { data, report } = mergeData(mine, theirs, OPTS);
  assert.equal(data.articles[A]!.finished, true);
  assert.equal(data.articles[A]!.finishedTs, 5_000);
  // 这个功能上线前读完的老文章两边都没有卡、也没有正文，塞进回顾队列只是一条看不了的东西
  assert.equal(data.articleCards.length, 0);
  assert.equal(report.articleCardsAdded, 0);
});

test("对方读完了、本机没读完：读完状态跟着翻转，回顾卡用对方带来的那张", () => {
  const mine = dataset({ articles: { [A]: article() } });
  const theirs = dataset({
    articles: { [A]: article({ finished: true, finishedTs: 5_000, reachedBottom: true }) },
    articleCards: [{ articleId: A, ...newFsrs(5_000) }],
  });
  const { data, report } = mergeData(mine, theirs, OPTS);
  assert.equal(data.articles[A]!.finished, true);
  assert.equal(data.articleCards.length, 1);
  assert.equal(report.articleCardsAdded, 1, "并进来的那张算新增");

  // 对方读完却没带卡（老文章）：本机翻转成读完，但同样不凭空建卡
  const bare = mergeData(mine, dataset({ articles: theirs.articles }), OPTS);
  assert.equal(bare.data.articles[A]!.finished, true);
  assert.equal(bare.data.articleCards.length, 1, "本机从没读完到读完是一次真正的翻转，建卡");
});

test("阅读位置取 savedTs 更晚的", () => {
  const mine = dataset({ positions: { [A]: position("h2", 60_000) } });
  const newer = mergeData(mine, dataset({ positions: { [A]: position("h5", 90_000) } }), OPTS);
  assert.equal(newer.data.positions[A]!.hash, "h5");
  assert.equal(newer.report.positionsUpdated, 1);
  const older = mergeData(mine, dataset({ positions: { [A]: position("h1", 10_000) } }), OPTS);
  assert.equal(older.data.positions[A]!.hash, "h2");
  assert.equal(older.report.positionsUpdated, 0);
});

test("本机独有的记录一个字都不动", () => {
  const B = "https://example.com/b";
  const mine = dataset({
    articles: { [B]: article({ id: B, url: B, wordsRead: 123, sessionCount: 7, totalMs: 999 }) },
    sessions: [session(10_000, 70_000, 100, { articleId: B })],
    paragraphs: { [B]: [para(0, 20_000)] },
  });
  const theirs = dataset({ articles: { [A]: article() }, sessions: [session(100_000, 160_000)] });
  const { data } = mergeData(mine, theirs, OPTS);
  assert.deepEqual(data.articles[B], mine.articles[B], "没被对方数据触及的文章不重算");
  assert.deepEqual(data.paragraphs[B], mine.paragraphs[B]);
});

test("parseBundle：3 与 4 都认，别的拒收，缺字段的条目丢掉", () => {
  const v3 = {
    schema: 3,
    articles: [article()],
    sessions: [session(1, 2), { id: "bad" }],
    paragraphs: { [A]: [para(0, 1), { hash: "x" }] },
    snippets: [snippet("s1", "leak", null)],
    cards: [],
    articleReviews: [],
    articleCards: [],
  };
  const d3 = parseBundle(v3);
  assert.equal(d3.sessions.length, 1);
  assert.equal(d3.paragraphs[A]!.length, 1);
  assert.deepEqual(d3.positions, {}, "3 版没有位置");

  const d4 = parseBundle({ ...v3, schema: 4, positions: [position("h1", 5)] });
  assert.equal(d4.positions[A]!.hash, "h1");

  assert.throws(() => parseBundle({ ...v3, schema: 5 }), /schema 5/);
  assert.throws(() => parseBundle("nope"), /不是有效/);
  assert.throws(() => parseBundle(null), /不是有效/);
});

test("老记录没有 usage / vocab 字段，合并时补齐", () => {
  const old = snippet("s1", "leak", null) as Partial<Snippet>;
  delete old.usage;
  delete old.vocab;
  const { data } = mergeData(emptyDataSet(), dataset({ snippets: [old as Snippet] }), OPTS);
  assert.equal(data.snippets[0]!.usage, null);
  assert.deepEqual(data.snippets[0]!.vocab, []);
});

test("卡片说这条划词是它的出处、划词自己却没挂卡：以卡片为准补上", () => {
  const mine = dataset({ snippets: [snippet("s1", "leak", null)] });
  const theirs = dataset({ cards: [newCard("c9", "leak", ["s1"], 1)] as StoredCard[] });
  const { data } = mergeData(mine, theirs, OPTS);
  assert.equal(data.snippets[0]!.cardId, "c9");
});
