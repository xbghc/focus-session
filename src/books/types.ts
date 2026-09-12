/**
 * 书这一层。
 *
 * 书底下那一整套（阅读片段、段落停留、跳回上次位置、划词翻译、复习）只认两样东西：
 * 一个叫 articleId 的字符串，和一份洗干净的正文。所以**一章就是一篇阅读材料**，
 * 那一层的接口一个字都不用改；书只是套在上面的一层目录——它知道有哪些章、按什么顺序排、
 * 书名是什么，此外什么都不管，进度一律由章的记录现算，不另存一份，免得两份状态对不上。
 *
 * 章的 id 形如 `epub:<书的内容哈希>/<spine 序号>`。归属关系编码在 id 里而不是在 Article
 * 上另加字段：Article 的形状、导入导出、同步记录都不必跟着改，`parseChapterId` 就能
 * 反查出这是哪本书的第几章。这个 id 也能被 `new URL` 解析，`normalizeUrl` 原样返回它，
 * `hostnameOf` 返回空串、两份黑名单都匹配不中——都是安全的退化。
 */

import type { ArchiveResource } from "../archive/types.ts";

export const BOOKS_KEY = "books";
/** 书的 id = EPUB 文件内容的 SHA-256，和文章存档的资源哈希同一个口径。 */
export const BOOK_ID = /^[a-f0-9]{64}$/;
const CHAPTER_ID = /^epub:([a-f0-9]{64})\/(\d{1,4})$/;

/** 一本书最多认这么多章、这么多张图、这么多字节。都是防着畸形或超大的文件，不是产品限制。 */
export const MAX_CHAPTERS = 2000;
export const MAX_BOOK_IMAGES = 800;
export const MAX_BOOK_BYTES = 64 * 1024 * 1024;
export const MAX_CHAPTER_BYTES = 4 * 1024 * 1024;
export const MAX_EPUB_ENTRIES = 5000;

export interface BookChapter {
  /** spine 里的序号，同时是 id 的后半截。 */
  index: number;
  title: string;
  /** 正文字数，供目录里显示"这一章有多长"。 */
  words: number;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  /** 导入时的文件名，书名缺失时拿它兜底。 */
  fileName: string;
  addedTs: number;
  chapters: BookChapter[];
  /** 封面图的资源哈希，书架上显示它。没有封面的书没有这个字段。 */
  coverHash?: string;
  /** 这本书占用的图片资源哈希。删书时按它回收，被别的书引用的除外。 */
  resources: string[];
  /** 因为太大、格式不认识或压根不在包里而没能存下的图片数。 */
  missingResources: number;
}

/** 存进 `rh:<章 id>` 的正文。形状与阅读器缓存网页正文时一致，多一个 book 字段。 */
export interface BookChapterContent {
  url: string;
  finalUrl: string;
  title: string;
  html: string;
  savedTs: number;
  book: { id: string; index: number; resources: ArchiveResource[] };
}

export const chapterId = (bookId: string, index: number): string => `epub:${bookId}/${index}`;

export function parseChapterId(id: string): { bookId: string; index: number } | null {
  const m = CHAPTER_ID.exec(id);
  return m ? { bookId: m[1]!, index: Number(m[2]) } : null;
}

export const isBookChapterId = (id: string): boolean => CHAPTER_ID.test(id);

/** 书里读到第几章了：第一章没读完的，没有就是最后一章。 */
export function nextChapter(book: Book, finished: ReadonlySet<number>): number {
  const pending = book.chapters.find(c => !finished.has(c.index));
  return pending?.index ?? book.chapters[book.chapters.length - 1]?.index ?? 0;
}
