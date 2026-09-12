/**
 * 导入一本 EPUB：把 spine 里的每一份文档洗成一章正文，把它引用的图片存成资源，
 * 最后交回一份书目。
 *
 * 正文走的是和网页文章**同一个**白名单（app/sanitize.ts 的存档模式）：阅读器页面与
 * 其余页面同源，页面里的脚本拿得到全部记录和宿主桥，正文来自一个用户从别处拿来的文件，
 * 这一步不能省。图片先存进本机的资源库、正文里只留 `fs-blob:<哈希>`，
 * 打开时才换成临时的 blob 地址——和插件存档那条路径完全一致。
 */

import { sanitizeArticle } from "../app/sanitize.ts";
import { imageMime, MAX_RESOURCE_BYTES, type ArchiveResource } from "../archive/types.ts";
import { countWords, normalizeText } from "../lib/wordcount.ts";
import { CONTAINER_PATH, chapterTitle, decodeText, packagePath, parsePackage, resolvePath, tocTitles, type ParseXml } from "./epub.ts";
import {
  chapterId, MAX_BOOK_BYTES, MAX_BOOK_IMAGES, MAX_CHAPTER_BYTES, MAX_CHAPTERS,
  type Book, type BookChapter, type BookChapterContent,
} from "./types.ts";

/** 解开的 zip。宿主那边是 java.util.zip，测试里是一个现成的 Map。 */
export interface ZipSource {
  names: readonly string[];
  bytes(name: string): Promise<Uint8Array>;
}

/** 落盘的去处。分出来是为了让这条流水线能在 node 里测。 */
export interface BookSink {
  chapter(id: string, content: BookChapterContent): Promise<void>;
  resource(hash: string, bytes: Uint8Array, mime: string): Promise<void>;
}

export interface ImportEnv {
  parse: ParseXml;
  /** sanitizeArticle 用它造节点。 */
  doc: Document;
  hash(bytes: Uint8Array): Promise<string>;
  sink: BookSink;
  now?: () => number;
  onProgress?(done: number, total: number): void;
}

/** 导入时用的书名：dc:title 缺失或只是个占位时退回文件名。 */
function bookTitle(title: string, fileName: string): string {
  const clean = title.trim();
  if (clean && clean.toLowerCase() !== "unknown") return clean.slice(0, 300);
  return fileName.replace(/\.epub$/i, "").trim() || "未命名的书";
}

export async function importEpub(zip: ZipSource, id: string, fileName: string, env: ImportEnv): Promise<Book> {
  const now = env.now?.() ?? Date.now();
  // 有的包里路径大小写和 manifest 对不上，找不到时退一步按小写找
  const byLower = new Map<string, string>();
  for (const name of zip.names) byLower.set(name.toLowerCase(), name);
  const read = async (path: string): Promise<Uint8Array> => {
    const actual = zip.names.includes(path) ? path : byLower.get(path.toLowerCase());
    if (!actual) throw new Error(`EPUB 里缺少 ${path}`);
    return zip.bytes(actual);
  };
  const has = (path: string): boolean => zip.names.includes(path) || byLower.has(path.toLowerCase());

  const opfPath = packagePath(decodeText(await read(CONTAINER_PATH)), env.parse);
  const pkg = parsePackage(decodeText(await read(opfPath)), opfPath, env.parse);

  let titles = new Map<string, string>();
  if (pkg.navHref && has(pkg.navHref)) titles = tocTitles(decodeText(await read(pkg.navHref)), pkg.navHref, env.parse, "nav");
  if (titles.size === 0 && pkg.ncxHref && has(pkg.ncxHref)) {
    titles = tocTitles(decodeText(await read(pkg.ncxHref)), pkg.ncxHref, env.parse, "ncx");
  }

  /* 图片全书去重：同一张封面常被十几章引用，按 zip 路径记住算过的哈希。 */
  const stored = new Map<string, ArchiveResource | null>();
  let bytesStored = 0;
  let missing = 0;
  const store = async (path: string): Promise<ArchiveResource | null> => {
    const known = stored.get(path);
    if (known !== undefined) return known;
    let resource: ArchiveResource | null = null;
    try {
      const mime = imageMime(pkg.mediaTypes.get(path) ?? "");
      if (!mime || !has(path)) throw new Error("认不出的图片");
      if (stored.size >= MAX_BOOK_IMAGES || bytesStored >= MAX_BOOK_BYTES) throw new Error("这本书的图片太多");
      const bytes = await read(path);
      if (bytes.byteLength > MAX_RESOURCE_BYTES) throw new Error("单张图片过大");
      const hash = await env.hash(bytes);
      await env.sink.resource(hash, bytes, mime);
      bytesStored += bytes.byteLength;
      resource = { hash, mime, size: bytes.byteLength };
    } catch {
      resource = null;
    }
    if (!resource) missing++;
    stored.set(path, resource);
    return resource;
  };

  const spine = pkg.spine.slice(0, MAX_CHAPTERS);
  const chapters: BookChapter[] = [];
  for (const [index, item] of spine.entries()) {
    env.onProgress?.(index, spine.length);
    const used: ArchiveResource[] = [];
    let title = titles.get(item.href) ?? "";
    let html = "";
    let words = 0;
    try {
      const bytes = await read(item.href);
      if (bytes.byteLength > MAX_CHAPTER_BYTES) throw new Error("这一章太大");
      // spine 里偶尔直接挂一张图（漫画、扫描件），当成只有一张图的一章
      const source = item.mediaType.startsWith("image/")
        ? `<img src="${item.href.replace(/"/g, "&quot;")}">`
        : decodeText(bytes);
      const doc = env.parse(source, "text/html");
      for (const svg of [...doc.getElementsByTagName("*")].filter(el => el.localName.toLowerCase() === "svg")) {
        // 封面常是一张裹在 svg 里的图；svg 整个不进正文，先把里面那张图提出来
        const image = [...svg.getElementsByTagName("*")].find(el => el.localName.toLowerCase() === "image");
        const href = image?.getAttribute("href") ?? image?.getAttribute("xlink:href");
        if (!href) continue;
        const img = doc.createElement("img");
        img.setAttribute("src", href);
        svg.replaceWith(img);
      }
      for (const img of [...doc.getElementsByTagName("img")]) {
        const src = img.getAttribute("src");
        const resource = src ? await store(resolvePath(item.href, src)) : null;
        if (!resource) { img.remove(); continue; }
        img.setAttribute("src", `fs-blob:${resource.hash}`);
        if (!used.some(r => r.hash === resource.hash)) used.push(resource);
      }
      html = sanitizeArticle(doc.body?.innerHTML ?? "", `epub:${id}/${index}`, env.doc, true);
      words = countWords(normalizeText(doc.body?.textContent ?? ""));
      if (!title) title = chapterTitle(doc);
    } catch (err) {
      html = `<p>这一章没能读出来：${err instanceof Error ? err.message : String(err)}</p>`;
    }
    if (!title) title = `第 ${index + 1} 节`;
    chapters.push({ index, title, words });
    const content: BookChapterContent = {
      url: chapterId(id, index),
      finalUrl: chapterId(id, index),
      title,
      html,
      savedTs: now,
      book: { id, index, resources: used },
    };
    await env.sink.chapter(content.url, content);
  }
  env.onProgress?.(spine.length, spine.length);

  const cover = pkg.coverHref ? await store(pkg.coverHref) : null;
  return {
    id,
    title: bookTitle(pkg.title, fileName),
    author: pkg.author.slice(0, 200),
    fileName: fileName.slice(0, 300),
    addedTs: now,
    chapters,
    ...(cover ? { coverHash: cover.hash } : {}),
    resources: [...new Set([...stored.values()].flatMap(r => r ? [r.hash] : []).concat(cover ? [cover.hash] : []))],
    missingResources: missing,
  };
}
