import type { Article, ArticleReview, Session, Snippet } from '../src/types.ts';
import { DEFAULT_LLM, DEFAULT_SETTINGS } from '../src/types.ts';
import { newCard, newFsrs } from '../src/lib/review.ts';
import { BOOKS_KEY, chapterId, type Book } from '../src/books/types.ts';

export const ARTICLE_URL = 'https://example.com/attention';
/** 书的 id 是文件内容的哈希，预览里给一个固定值就行。 */
export const BOOK_ID = 'b0'.repeat(32);
export const BODY = `<h2>Attention is a practice</h2><p>Attention is not simply a resource we spend. It is a practice shaped by the environments we create, the questions we ask, and the habits we repeat each day.</p><p>When we read a difficult text, we build a mental model one paragraph at a time. Taking a short pause can help consolidate the ideas and connect them with what we already know.</p><h2>Design a quieter environment</h2><p>Put distractions out of reach and choose one question to guide the session. The goal is not to finish every page quickly, but to understand enough to explain the argument in your own words.</p><blockquote>A good reading session leaves you with a clearer question.</blockquote><p>最后，给自己留一点回想的时间。合上文章，说出你记得的论点、证据与适用范围，才能发现真正理解了哪些内容。</p>`;

export function fixtures(empty = false) {
  const now = Date.now();
  const articles: Article[] = ['注意力是一种练习：如何建立更好的阅读习惯', 'Understanding the browser event loop', '从零搭建个人知识体系：阅读、记录与回顾'].map((title, i) => ({
    id: i ? `https://example.com/article-${i}` : ARTICLE_URL,
    url: i ? `https://example.com/article-${i}` : ARTICLE_URL, title,
    totalWords: 1500 + i * 400, trackedWords: 1400 + i * 400,
    wordsRead: i === 1 ? 1800 : 560, paragraphCount: 18, readParagraphCount: i === 1 ? 18 : 7,
    sessionCount: 3, totalMs: 720_000, maxSessionMs: 300_000, readingMs: 600_000,
    expectedMs: 900_000, firstSeenTs: now - 86_400_000, lastSeenTs: now - i * 3_600_000,
    reachedBottom: i === 1, finished: i === 1, finishedTs: i === 1 ? now - 3_600_000 : null,
  }));
  const snippets: Snippet[] = ['consolidate', 'mental model', 'Attention is a practice.'].map((text, i) => ({
    id: `snippet-${i}`, articleId: ARTICLE_URL, url: ARTICLE_URL, articleTitle: articles[0]!.title,
    text, context: `Taking a short pause can help ${text} and connect ideas with what we already know.`,
    kind: i === 0 ? 'word' : i === 1 ? 'phrase' : 'sentence', createdTs: now - i * 60_000,
    translation: ['巩固；使牢固', '心智模型', '注意力是一种练习。'][i]!,
    contextNote: '这里指把刚读到的内容整合进已有知识，使理解更牢固。',
    phonetic: i === 0 ? '/kənˈsɒlɪdeɪt/' : null, pos: i === 0 ? 'v.' : null,
    lemma: i === 0 ? 'consolidate' : null, usage: '常见搭配：consolidate knowledge（巩固知识）。',
    vocab: [], cardId: i < 2 ? `card-${i}` : null,
  }));
  const sessions: Session[] = articles.flatMap(a => [0, 1, 2].map(i => ({
    id: `${a.id}-${i}`, articleId: a.id, url: a.url, title: a.title,
    startTs: now - (i + 1) * 3_600_000, endTs: now - (i + 1) * 3_600_000 + 240_000,
    wordsRead: 180, endReason: 'blur' as const,
  })));
  const review: ArticleReview = { articleId: articles[1]!.id, generatedTs: now, model: 'preview',
    outline: ['事件循环协调调用栈与任务队列。', '微任务在当前任务结束后集中执行。', '耗时计算需要拆分，才能让界面及时响应。', '用时间线可以验证任务的执行顺序。'],
    questions: ['微任务与普通任务的执行顺序是什么？', '为什么长任务会阻塞界面？', '如何拆分一个耗时操作？'],
  };
  /* 书：章是普通的阅读材料，只是列表上折进书架那一行。 */
  const book: Book = {
    id: BOOK_ID, title: '深度阅读的技艺', author: '某位作者', fileName: 'the-art-of-deep-reading.epub',
    addedTs: now - 7_200_000, missingResources: 0, resources: [],
    chapters: [
      { index: 0, title: '开篇：为什么越读越快，记住的越少', words: 1240 },
      { index: 1, title: '第二章 一次只问一个问题', words: 2080 },
    ],
  };
  const chapter: Article = {
    id: chapterId(BOOK_ID, 0), url: chapterId(BOOK_ID, 0), title: book.chapters[0]!.title,
    totalWords: 1240, trackedWords: 1240, wordsRead: 1240, paragraphCount: 14, readParagraphCount: 14,
    sessionCount: 2, totalMs: 540_000, maxSessionMs: 320_000, readingMs: 480_000, expectedMs: 600_000,
    firstSeenTs: now - 7_000_000, lastSeenTs: now - 5_400_000,
    reachedBottom: true, finished: true, finishedTs: now - 5_400_000,
  };
  const activeArticles = empty ? [] : articles;
  return {
    articles, snippets,
    data: {
      settings: { ...DEFAULT_SETTINGS, articleExcludedUrls: ['https://example.com/search'], translationExcludedUrls: ['mail.example.com'] },
      llm: { ...DEFAULT_LLM, apiKey: '', model: 'storybook-preview' },
      articles: Object.fromEntries(activeArticles.concat(empty ? [] : [chapter]).map(a => [a.id, a])), sessions: empty ? [] : sessions,
      [BOOKS_KEY]: empty ? {} : { [book.id]: book },
      [`rh:${chapterId(BOOK_ID, 0)}`]: {
        url: chapterId(BOOK_ID, 0), finalUrl: chapterId(BOOK_ID, 0), title: book.chapters[0]!.title,
        html: BODY, savedTs: now, book: { id: BOOK_ID, index: 0, resources: [] },
      },
      snippets: empty ? [] : snippets,
      cards: empty ? [] : snippets.slice(0, 2).map((s, i) => newCard(`card-${i}`, s.text, [s.id], now)),
      articleCards: empty ? [] : [{ articleId: articles[1]!.id, ...newFsrs(now) }],
      [`r:${articles[1]!.id}`]: review,
      [`t:${articles[1]!.id}`]: { articleId: articles[1]!.id, text: '事件循环示例正文', fullChars: 9, savedTs: now },
      [`rh:${ARTICLE_URL}`]: { url: ARTICLE_URL, finalUrl: ARTICLE_URL, title: articles[0]!.title, html: BODY, savedTs: now },
    },
  };
}
