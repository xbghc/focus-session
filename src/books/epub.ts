/**
 * EPUB 的骨架解析：包在哪、有哪些章、按什么顺序排、各章叫什么。
 *
 * 只认结构，不碰字节的来源，也不碰存储——解压交给宿主（android 那边的 java.util.zip），
 * 落盘交给 import.ts。这样这一整套能在 node 里用 jsdom 直接测，不必有手机。
 *
 * 宽容优先：市面上的 EPUB 什么样的都有（EPUB 2 的 NCX、EPUB 3 的 nav、大小写对不上的
 * 路径、没有 dc:title 的包）。认不出来的地方一律退回一个能用的默认值，
 * 只有连 spine 都读不出来时才算这个文件打不开。
 */

/** 造 Document 的方式。浏览器里是 DOMParser，测试里是 jsdom。 */
export type ParseXml = (text: string, mime: "application/xml" | "text/html") => Document;

export const CONTAINER_PATH = "META-INF/container.xml";
const DC_NS = "http://purl.org/dc/elements/1.1/";

/** zip 里的路径：相对 zip 根、已解码、不含 ./ 与 ../。`from` 传的是引用方的**文件**路径。 */
export function resolvePath(from: string, href: string): string {
  const bare = href.split("#")[0]!.split("?")[0]!;
  let decoded = bare;
  try { decoded = decodeURIComponent(bare); } catch { /* 本来就没编码 */ }
  const parts = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const seg of decoded.replace(/^\/+/, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function parsed(text: string, mime: "application/xml" | "text/html", parse: ParseXml): Document {
  const doc = parse(text, mime);
  // 浏览器解析 XML 出错时不抛异常，而是给一份 <parsererror> 的文档
  if (mime === "application/xml" && doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("EPUB 的 XML 结构不完整");
  }
  return doc;
}

/** 按标签名找元素，不计大小写和命名空间前缀：XML 里是 navPoint，HTML 解析出来是 navpoint。 */
const tags = (doc: Document | Element, name: string): Element[] =>
  [...doc.getElementsByTagName("*")].filter(el => el.localName.toLowerCase() === name.toLowerCase());

const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** META-INF/container.xml → 主文档（OPF）在 zip 里的路径。 */
export function packagePath(containerXml: string, parse: ParseXml): string {
  const doc = parsed(containerXml, "application/xml", parse);
  const full = tags(doc, "rootfile").map(el => el.getAttribute("full-path")).find(Boolean);
  if (!full) throw new Error("这个 EPUB 里没有 container.xml 指向的主文档");
  return resolvePath("", full);
}

export interface EpubSpineItem {
  /** zip 里的路径。 */
  href: string;
  mediaType: string;
}

export interface EpubPackage {
  title: string;
  author: string;
  language: string;
  spine: EpubSpineItem[];
  /** 各资源的 media-type，按 zip 路径索引。图片认不认得出来靠它。 */
  mediaTypes: Map<string, string>;
  navHref: string | null;
  ncxHref: string | null;
  coverHref: string | null;
}

/** OPF：元信息、manifest（有什么文件）、spine（正文按什么顺序读）。 */
export function parsePackage(opfXml: string, opfPath: string, parse: ParseXml): EpubPackage {
  const doc = parsed(opfXml, "application/xml", parse);
  const dc = (name: string): string => {
    const ns = doc.getElementsByTagNameNS(DC_NS, name)[0];
    return text(ns ?? tags(doc, name)[0]);
  };

  const items = new Map<string, { href: string; mediaType: string; properties: string }>();
  const mediaTypes = new Map<string, string>();
  for (const item of tags(doc, "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    const entry = {
      href: resolvePath(opfPath, href),
      mediaType: (item.getAttribute("media-type") ?? "").toLowerCase(),
      properties: item.getAttribute("properties") ?? "",
    };
    items.set(id, entry);
    mediaTypes.set(entry.href, entry.mediaType);
  }

  const spine: EpubSpineItem[] = [];
  const seen = new Set<string>();
  for (const ref of tags(doc, "itemref")) {
    const item = items.get(ref.getAttribute("idref") ?? "");
    // 同一份文件在 spine 里出现两次（有的包用锚点切章）只读一次：id 按序号走，重复会串
    if (!item || seen.has(item.href)) continue;
    seen.add(item.href);
    spine.push({ href: item.href, mediaType: item.mediaType });
  }
  if (spine.length === 0) throw new Error("这个 EPUB 的 spine 里没有正文");

  const byProperty = (name: string): string | null =>
    [...items.values()].find(i => i.properties.split(/\s+/).includes(name))?.href ?? null;
  const ncxFromSpine = items.get(tags(doc, "spine")[0]?.getAttribute("toc") ?? "")?.href ?? null;
  const coverMeta = tags(doc, "meta").find(m => m.getAttribute("name") === "cover")?.getAttribute("content");

  return {
    title: dc("title"),
    author: dc("creator"),
    language: dc("language"),
    spine: spine.slice(0, 9999),
    mediaTypes,
    navHref: byProperty("nav"),
    ncxHref: ncxFromSpine ?? [...items.values()].find(i => i.mediaType === "application/x-dtbncx+xml")?.href ?? null,
    coverHref: byProperty("cover-image") ?? (coverMeta ? items.get(coverMeta)?.href ?? null : null),
  };
}

/**
 * 目录 → 各章的标题，按 zip 路径索引。
 *
 * 同一个文件在目录里出现多次（一章里的几个小节）时只认第一条：目录是按阅读顺序排的，
 * 章本身那一条总在它的小节之前。
 */
export function tocTitles(source: string, path: string, parse: ParseXml, kind: "nav" | "ncx"): Map<string, string> {
  const titles = new Map<string, string>();
  const add = (href: string | null, label: string): void => {
    if (!href || !label) return;
    const target = resolvePath(path, href);
    if (target && !titles.has(target)) titles.set(target, label.slice(0, 200));
  };
  try {
    if (kind === "ncx") {
      const doc = parsed(source, "application/xml", parse);
      for (const point of tags(doc, "navPoint")) {
        add(tags(point, "content")[0]?.getAttribute("src") ?? null, text(tags(point, "text")[0]));
      }
      return titles;
    }
    // nav 是 XHTML，按 HTML 解析最省事：epub:type 这类带前缀的属性在 HTML 里是普通属性名
    const doc = parsed(source, "text/html", parse);
    const navs = tags(doc, "nav");
    const toc = navs.find(n => (n.getAttribute("epub:type") ?? n.getAttribute("type") ?? "").includes("toc")) ?? navs[0] ?? doc.body;
    for (const a of tags(toc, "a")) add(a.getAttribute("href"), text(a));
  } catch {
    /* 目录坏了不该让整本书打不开，退回用章内的标题 */
  }
  return titles;
}

/** 章自己的标题：正文里的第一个标题，没有就用 <title>。 */
export function chapterTitle(doc: Document): string {
  for (const tag of ["h1", "h2", "h3", "title"]) {
    const value = text(tags(doc, tag)[0]);
    if (value) return value.slice(0, 200);
  }
  return "";
}

/** EPUB 的文本文件只可能是 UTF-8 或 UTF-16，按 BOM 判，没有 BOM 就是 UTF-8。 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder("utf-8").decode(bytes.subarray(start));
}
