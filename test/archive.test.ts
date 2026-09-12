import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractArchive } from "../src/archive/capture.ts";
import { hashBytes, imageMime, readArchiveBytes, rewriteArchiveImages, validateArchiveCapture } from "../src/archive/types.ts";
import { sanitizeArticle } from "../src/app/sanitize.ts";

const content = "This is an article about reading, learning, and keeping a useful library on every device. ".repeat(20);
const hash = "a".repeat(64);

test("archive capture uses loaded responsive and lazy images and strips active content", () => {
  const doc = new JSDOM(`<html><head><title>Saved article</title></head><body><article><h1>Saved article</h1><p>${content}</p>
    <img src="/small.jpg" srcset="/small.jpg 1x, /large.jpg 2x" onerror="alert(1)">
    <img src="data:image/png;base64,eA==" data-src="/real.png">
    <p>${content}</p><script>stealCookies()</script><iframe src="/account"></iframe></article></body></html>`, { url: "https://example.com/read?utm_source=x" }).window.document;
  Object.defineProperty(doc.querySelector("img"), "currentSrc", { value: "https://example.com/large.jpg" });
  const archive = extractArchive(doc, doc.URL);
  assert.equal(archive.articleId, "https://example.com/read");
  assert.deepEqual(archive.resources.map(r => r.url), ["https://example.com/large.jpg", "https://example.com/real.png"]);
  assert.doesNotMatch(archive.html, /onerror|script|iframe|srcset|data-src/i);
  assert.match(archive.html, /Saved article|This is an article/);
});

test("archive capture rejects pages with no readable article", () => {
  const doc = new JSDOM("<html><body><form><input></form></body></html>", { url: "https://example.com" }).window.document;
  assert.throws(() => extractArchive(doc, doc.URL), /正文/);
});

test("image rewriting decodes HTML entities, deduplicates resources, and never keeps missing external URLs", () => {
  const html = '<a href="https://img.test/a?x=1&amp;y=2">link</a><img src="https://img.test/a?x=1&amp;y=2" alt="A"><img src="https://img.test/missing">';
  const rewritten = rewriteArchiveImages(html, new Map([["https://img.test/a?x=1&y=2", hash]]));
  assert.match(rewritten, new RegExp(`src="fs-blob:${hash}"`));
  assert.match(rewritten, /图片未保存/);
  assert.doesNotMatch(rewritten, /img\.test\/missing/);
  assert.match(rewritten, /<a href="https:\/\/img\.test\/a\?x=1&amp;y=2">/);
});

test("archive sanitizer permits only validated content hashes and strips all source-site image requests", () => {
  const doc = new JSDOM().window.document;
  const malicious = `<img src="fs-blob:${hash}" onload="steal()"><img src="https://private.test/cookie"><img src="data:image/png;base64,eA=="><img src="fs-blob:../../token"><script>steal()</script><a href="javascript:steal()">A</a>`;
  const clean = sanitizeArticle(malicious, "https://example.com", doc, true);
  assert.equal(clean, `<img src="fs-blob:${hash}"><a rel="noreferrer">A</a>`);
  assert.equal(sanitizeArticle(`<img src="fs-blob:${hash}">`, "https://example.com", doc), "");
});

test("archive content hashes are SHA-256 and only passive raster image MIME types are accepted", async () => {
  assert.equal(await hashBytes(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(imageMime("IMAGE/JPEG; charset=binary"), "image/jpeg");
  assert.equal(imageMime("image/svg+xml"), null);
  assert.equal(imageMime("text/html"), null);
});

test("resource downloads stop at a size limit even with no length header", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(4)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readArchiveBytes(response, 6), /大小限制/);
  assert.equal(cancelled, true);
  assert.deepEqual(await readArchiveBytes(new Response(new Uint8Array([1, 2, 3])), 3), new Uint8Array([1, 2, 3]));
});

test("capture runtime validation rejects mismatched article identity and malformed resource input", () => {
  const payload = { articleId: "https://example.com/read", url: "https://example.com/read", html: "<p>Article</p>", title: "Article", resources: [], missingResources: [], createdTs: 1 };
  assert.equal(validateArchiveCapture(payload), payload);
  assert.throws(() => validateArchiveCapture({ ...payload, articleId: "https://other.test/read" }));
  assert.throws(() => validateArchiveCapture({ ...payload, resources: [{ url: "https://example.com/a", base64: { value: "x" } }] }));
  assert.throws(() => validateArchiveCapture({ ...payload, missingResources: "not an array" }));
  assert.throws(() => validateArchiveCapture({ ...payload, articleId: "https://user:pass@example.com/", url: "https://user:pass@example.com/" }));
});
