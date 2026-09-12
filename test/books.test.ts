import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { chapterTitle, packagePath, parsePackage, resolvePath, tocTitles, decodeText } from "../src/books/epub.ts";
import { importEpub, type BookSink, type ZipSource } from "../src/books/import.ts";
import { chapterId, parseChapterId, nextChapter, type Book, type BookChapterContent } from "../src/books/types.ts";
import { normalizeUrl, isUrlExcluded } from "../src/lib/url.ts";
import { freshState, trackChanges } from "../src/sync/storage.ts";

const parse = (text: string, mime: "application/xml" | "text/html"): Document =>
  new JSDOM(text, { contentType: mime }).window.document as unknown as Document;
const sanitizeDoc = new JSDOM("<!doctype html><html><body></body></html>").window.document as unknown as Document;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const hash = async (data: Uint8Array): Promise<string> => createHash("sha256").update(data).digest("hex");
const BOOK_ID = "b".repeat(64);

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const opf = (extra = "") => `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>An Ordinary Book</dc:title>
    <dc:creator>A Writer</dc:creator>
    <dc:language>en</dc:language>
    ${extra}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="images/cover%20art.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c1"/></spine>
</package>`;

const NAV = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <nav epub:type="toc"><ol>
    <li><a href="text/ch1.xhtml">开篇</a></li>
    <li><a href="text/ch1.xhtml#part2">开篇的第二节</a></li>
    <li><a href="text/ch2.xhtml">图与注</a></li>
  </ol></nav></body></html>`;

const NCX = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint><navLabel><text>NCX 的第一章</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
</navMap></ncx>`;

const CH1 = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>忽略我</title></head><body>
  <h1>开篇</h1>
  <p>Reading a book on a phone should feel the same as reading an article.</p>
  <img src="../images/cover%20art.jpg" alt="封面"/>
  <script>steal()</script>
  <a href="ch2.xhtml">下一章</a>
</body></html>`;

const CH2 = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章的标题</title></head><body>
  <svg viewBox="0 0 10 10" xmlns:xlink="http://www.w3.org/1999/xlink">
    <image width="10" height="10" xlink:href="../images/cover%20art.jpg"/>
  </svg>
  <p>第二章讲图片。</p>
  <img src="../images/missing.png"/>
</body></html>`;

function zip(files: Record<string, string | Uint8Array>): ZipSource {
  return {
    names: Object.keys(files),
    bytes: async (name) => {
      const value = files[name];
      if (value === undefined) throw new Error(`no entry ${name}`);
      return typeof value === "string" ? bytes(value) : value;
    },
  };
}

function collector(): BookSink & { chapters: Map<string, BookChapterContent>; resources: Map<string, number> } {
  const chapters = new Map<string, BookChapterContent>();
  const resources = new Map<string, number>();
  return {
    chapters,
    resources,
    chapter: async (id, content) => { chapters.set(id, content); },
    resource: async (hex, data) => { resources.set(hex, data.byteLength); },
  };
}

const FILES: Record<string, string | Uint8Array> = {
  "META-INF/container.xml": CONTAINER,
  "OEBPS/content.opf": opf(),
  "OEBPS/nav.xhtml": NAV,
  "OEBPS/toc.ncx": NCX,
  "OEBPS/text/ch1.xhtml": CH1,
  "OEBPS/text/ch2.xhtml": CH2,
  "OEBPS/images/cover art.jpg": new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
};

test("zip 里的路径按引用方所在目录解析，百分号编码先解开", () => {
  assert.equal(resolvePath("OEBPS/text/ch1.xhtml", "../images/cover%20art.jpg"), "OEBPS/images/cover art.jpg");
  assert.equal(resolvePath("OEBPS/content.opf", "text/ch1.xhtml#anchor"), "OEBPS/text/ch1.xhtml");
  assert.equal(resolvePath("OEBPS/text/a.xhtml", "/top.xhtml"), "top.xhtml");
  assert.equal(resolvePath("", "OEBPS/content.opf"), "OEBPS/content.opf");
  // 跳出 zip 根的写法只会退到根，不会越界
  assert.equal(resolvePath("a/b.xhtml", "../../../etc/passwd"), "etc/passwd");
});

test("container 指出主文档，OPF 给出元信息与 spine，重复的 itemref 只读一次", () => {
  assert.equal(packagePath(CONTAINER, parse), "OEBPS/content.opf");
  const pkg = parsePackage(opf(), "OEBPS/content.opf", parse);
  assert.equal(pkg.title, "An Ordinary Book");
  assert.equal(pkg.author, "A Writer");
  assert.deepEqual(pkg.spine.map(s => s.href), ["OEBPS/text/ch1.xhtml", "OEBPS/text/ch2.xhtml"]);
  assert.equal(pkg.navHref, "OEBPS/nav.xhtml");
  assert.equal(pkg.ncxHref, "OEBPS/toc.ncx");
  assert.equal(pkg.coverHref, "OEBPS/images/cover art.jpg");
  assert.equal(pkg.mediaTypes.get("OEBPS/images/cover art.jpg"), "image/jpeg");
});

test("EPUB 2 的包没有 nav，封面由 meta 指定", () => {
  const legacy = opf('<meta name="cover" content="cover"/>').replace(' properties="nav"', "").replace(' properties="cover-image"', "");
  const pkg = parsePackage(legacy, "OEBPS/content.opf", parse);
  assert.equal(pkg.navHref, null);
  assert.equal(pkg.ncxHref, "OEBPS/toc.ncx");
  assert.equal(pkg.coverHref, "OEBPS/images/cover art.jpg");
});

test("目录给出章标题：同一篇文件的第二条（小节）不覆盖第一条", () => {
  const nav = tocTitles(NAV, "OEBPS/nav.xhtml", parse, "nav");
  assert.equal(nav.get("OEBPS/text/ch1.xhtml"), "开篇");
  assert.equal(nav.get("OEBPS/text/ch2.xhtml"), "图与注");
  const ncx = tocTitles(NCX, "OEBPS/toc.ncx", parse, "ncx");
  assert.equal(ncx.get("OEBPS/text/ch1.xhtml"), "NCX 的第一章");
  // 目录坏掉不该让整本书打不开
  assert.equal(tocTitles("<ncx", "OEBPS/toc.ncx", parse, "ncx").size, 0);
});

test("章内标题退回 h1，再退回 <title>；文本编码按 BOM 判", () => {
  assert.equal(chapterTitle(parse(CH1, "text/html")), "开篇");
  assert.equal(chapterTitle(parse("<html><head><title>只有它</title></head><body><p>x</p></body></html>", "text/html")), "只有它");
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])), "hi");
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00])), "h");
});

test("导入一本书：每一章都是一篇阅读材料，脚本去掉，图片换成本机资源", async () => {
  const sink = collector();
  const book = await importEpub(zip(FILES), BOOK_ID, "an-ordinary-book.epub", {
    parse, doc: sanitizeDoc, hash, sink, now: () => 1_700_000_000_000,
  });

  assert.equal(book.title, "An Ordinary Book");
  assert.equal(book.author, "A Writer");
  assert.deepEqual(book.chapters.map(c => c.title), ["开篇", "图与注"]);
  assert.ok(book.chapters[0]!.words > 10, "章里应当数出字数");

  const first = sink.chapters.get(chapterId(BOOK_ID, 0))!;
  assert.equal(first.book.index, 0);
  assert.doesNotMatch(first.html, /script|steal/i, "脚本连内容一起去掉");
  const coverHash = await hash(FILES["OEBPS/images/cover art.jpg"] as Uint8Array);
  assert.match(first.html, new RegExp(`src="fs-blob:${coverHash}"`));
  assert.deepEqual(first.book.resources, [{ hash: coverHash, mime: "image/jpeg", size: 7 }]);
  // 站内相对链接在阅读器里落不了地，白名单只放行 http(s) 与页内锚点
  assert.doesNotMatch(first.html, /ch2\.xhtml/);

  const second = sink.chapters.get(chapterId(BOOK_ID, 1))!;
  assert.match(second.html, new RegExp(`<img src="fs-blob:${coverHash}"`), "svg 里裹着的封面提成一张图");
  assert.doesNotMatch(second.html, /missing\.png/);
  assert.equal(book.missingResources, 1, "包里没有的图算一张没保存");

  // 同一张图被两章引用，只存一份
  assert.equal(sink.resources.size, 1);
  assert.deepEqual(book.resources, [coverHash]);
  assert.equal(book.coverHash, coverHash);
});

test("书名缺失时退回文件名，spine 读不出来才算这个文件打不开", async () => {
  const nameless = { ...FILES, "OEBPS/content.opf": opf().replace("<dc:title>An Ordinary Book</dc:title>", "<dc:title></dc:title>") };
  const book = await importEpub(zip(nameless), BOOK_ID, "Deep Work.epub", { parse, doc: sanitizeDoc, hash, sink: collector() });
  assert.equal(book.title, "Deep Work");

  const broken = { ...FILES, "OEBPS/content.opf": opf().replace(/<spine[\s\S]*<\/spine>/, "<spine/>") };
  await assert.rejects(
    importEpub(zip(broken), BOOK_ID, "x.epub", { parse, doc: sanitizeDoc, hash, sink: collector() }),
    /spine/,
  );
});

test("一章读不出来时只有这一章缺，别的章照常导入", async () => {
  const partial = { ...FILES };
  delete partial["OEBPS/text/ch2.xhtml"];
  const sink = collector();
  const book = await importEpub(zip(partial), BOOK_ID, "x.epub", { parse, doc: sanitizeDoc, hash, sink });
  assert.equal(book.chapters.length, 2);
  assert.match(sink.chapters.get(chapterId(BOOK_ID, 1))!.html, /没能读出来/);
  assert.match(sink.chapters.get(chapterId(BOOK_ID, 0))!.html, /Reading a book/);
});

test("章的 id 能被现有那套地址处理原样接住", () => {
  const id = chapterId(BOOK_ID, 12);
  assert.deepEqual(parseChapterId(id), { bookId: BOOK_ID, index: 12 });
  assert.equal(parseChapterId("https://example.com/a"), null);
  assert.equal(parseChapterId(`epub:${BOOK_ID}/x`), null);
  // 文章记录按 normalizeUrl 归一化，章的 id 过它一遍必须还是自己
  assert.equal(normalizeUrl(id), id);
  // 黑名单是按域名和 http 网址写的，书不该被它们误伤
  assert.equal(isUrlExcluded(id, ["example.com", "https://example.com/x"]), false);
});

test("书读到哪了：第一章没读完的那一节", () => {
  const book = { chapters: [0, 1, 2].map(index => ({ index, title: "", words: 1 })) } as Book;
  assert.equal(nextChapter(book, new Set([0])), 1);
  assert.equal(nextChapter(book, new Set([0, 1, 2])), 2);
  assert.equal(nextChapter(book, new Set()), 0);
});

test("书的记录不进同步：协议只认 http(s) 的标识，推上去会把整批卡住", () => {
  const chapter = chapterId(BOOK_ID, 0);
  const web = "https://example.com/article";
  const state = freshState({});
  trackChanges(state, {}, {
    articles: {
      [chapter]: { id: chapter, url: chapter, title: "开篇", finished: false },
      [web]: { id: web, url: web, title: "网页", finished: false },
    },
    sessions: [{ id: "s1", articleId: chapter }, { id: "s2", articleId: web }],
    snippets: [{ id: "n1", articleId: chapter, text: "book" }, { id: "n2", articleId: web, text: "web" }],
    cards: [{ key: "book", id: "c1", snippetIds: ["n1"] }, { key: "web", id: "c2", snippetIds: ["n1", "n2"] }],
    articleCards: [{ articleId: chapter }, { articleId: web }],
    reviewEvents: [{ id: "e1", kind: "article", cardKey: chapter }, { id: "e2", kind: "article", cardKey: web }],
    [`p:${chapter}`]: [{ hash: "h", index: 0, words: 3, firstSeenTs: 1, dwellMs: 5 }],
    [`pos:${chapter}`]: { hash: "h", index: 0 },
    [`t:${chapter}`]: { text: "正文" },
    [`r:${chapter}`]: { outline: [], questions: [] },
  });
  const pushed = state.outbox.map(op => `${op.record.type}:${op.record.id}`);
  assert.equal(pushed.some(key => key.includes("epub:")), false, `不该外发：${pushed.join(",")}`);
  assert.deepEqual(pushed.sort(), [
    `article:${web}`, `articleCard:${web}`, "card:web", "reviewEvent:e2", "session:s2", "snippet:n2",
  ].sort());
  // 两边都遇到过的词照常同步，出处只报网页那一个
  const card = state.outbox.find(op => op.record.id === "web")!.record.value as { snippetIds: string[] };
  assert.deepEqual(card.snippetIds, ["n2"]);
});
