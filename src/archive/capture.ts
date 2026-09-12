import { Readability } from "@mozilla/readability";
import { sanitizeArticle } from "../app/sanitize.ts";
import { normalizeUrl } from "../lib/url.ts";
import { imageMime, readArchiveBytes, MAX_ARCHIVE_IMAGES, MAX_RESOURCE_BYTES, type ArchiveCapture } from "./types.ts";

function base64(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 16384) raw += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(raw);
}

/** Capture the DOM the user can currently read, including resolved lazy images. */
export function extractArchive(doc: Document, url: string): ArchiveCapture {
  const copy = doc.cloneNode(true) as Document;
  const originals = [...doc.querySelectorAll("img")];
  [...copy.querySelectorAll("img")].forEach((image, i) => {
    const original = originals[i];
    const lazy = image.getAttribute("data-src") || image.getAttribute("data-original") || image.getAttribute("data-lazy-src");
    // The browser's selected responsive image is more reliable than parsing srcset.
    const src = original?.currentSrc && !original.currentSrc.startsWith("data:") && (!lazy || original.naturalWidth > 16)
      ? original.currentSrc
      : lazy || image.getAttribute("src") || image.getAttribute("srcset")?.split(",")[0]?.trim().split(/\s+/)[0];
    if (src) {
      try { image.src = new URL(src, doc.baseURI || url).href; } catch { image.removeAttribute("src"); }
    }
    image.removeAttribute("srcset");
    image.removeAttribute("loading");
  });
  const base = copy.createElement("base");
  base.href = doc.baseURI || url;
  copy.head.prepend(base);
  const parsed = new Readability(copy).parse();
  if (!parsed?.content || (parsed.textContent?.trim().length ?? 0) < 20) throw new Error("未找到可保存的文章正文");
  const html = sanitizeArticle(parsed.content, doc.baseURI || url, doc);
  if (new TextEncoder().encode(html).length > MAX_RESOURCE_BYTES) throw new Error("文章正文超过 8 MB，无法保存");
  const holder = doc.createElement("template");
  holder.innerHTML = html;
  const urls = [...new Set([...holder.content.querySelectorAll("img")].map(img => img.getAttribute("src")!).filter(Boolean))];
  return {
    articleId: normalizeUrl(url), url, title: (parsed.title || doc.title || url).slice(0, 2000), html,
    resources: urls.slice(0, MAX_ARCHIVE_IMAGES).map(url => ({ url })),
    missingResources: urls.slice(MAX_ARCHIVE_IMAGES), createdTs: Date.now(),
  };
}

export async function captureCurrentArticle(): Promise<unknown> {
  if (window.top !== window || document.contentType !== "text/html") throw new Error("只能保存顶层网页文章");
  const payload = extractArchive(document, location.href);
  // Same-origin requests can reuse the current page's authenticated session.
  // Cross-origin resources are fetched by the extension background without cookies.
  const queue = [...payload.resources];
  let transferredBytes = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const resource = queue.shift()!;
      if (!resource.url.startsWith("data:") && new URL(resource.url).origin !== location.origin) continue;
      try {
        const response = await fetch(resource.url, { credentials: "same-origin", signal: AbortSignal.timeout(12_000) });
        if (!response.ok) continue;
        const mime = imageMime(response.headers.get("content-type") ?? "");
        if (!mime) continue;
        const size = Number(response.headers.get("content-length"));
        if (size > MAX_RESOURCE_BYTES) continue;
        const bytes = await readArchiveBytes(response);
        // Chrome runtime messages have a finite size; remaining images use the
        // background's URL fetch instead of adding another large base64 payload.
        if (transferredBytes + bytes.byteLength > 24 * 1024 * 1024) continue;
        transferredBytes += bytes.byteLength;
        resource.mime = mime;
        resource.base64 = base64(bytes);
      } catch { /* Background gets a second chance; otherwise recorded as missing. */ }
    }
  }));
  return chrome.runtime.sendMessage({ type: "archive:save", payload });
}
