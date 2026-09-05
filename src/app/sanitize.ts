/**
 * 把 Readability 吐出来的正文 HTML 洗成只含排版标签的安全片段。
 *
 * 阅读器页面和 App 的其余页面同源，页面里的脚本拥有 IndexedDB（全部记录）和宿主桥
 * （能发任意 HTTP 请求）。正文来自任意网站，直接 innerHTML 等于把网页交给的东西当代码跑。
 * Readability 会去掉 script，但不保证去掉事件属性、javascript: 链接、svg/iframe 这些。
 * 这里按**白名单**重建：认识的标签留下、只保留几个无害属性，其余的连壳带瓤一起去掉
 * 或者只留文字。
 */

/** 留下的标签。都是排版用的，没有一个能执行东西。 */
const KEEP = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "pre", "code", "kbd", "samp",
  "em", "strong", "b", "i", "u", "s", "sup", "sub", "small", "mark", "del", "ins", "abbr", "cite", "q", "time", "wbr",
  "a", "img", "br", "hr",
  "figure", "figcaption",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "div", "section", "article", "aside", "header", "footer", "main", "span",
]);

/** 连内容一起丢掉的标签：要么能执行，要么在阅读器里没意义。 */
const DROP = new Set([
  "script", "style", "iframe", "frame", "object", "embed", "applet",
  "form", "input", "button", "select", "textarea", "option", "label",
  "svg", "math", "canvas", "video", "audio", "source", "track",
  "link", "meta", "noscript", "template", "dialog", "slot",
]);

/** 各标签允许的属性。没列的标签一个属性都不留。 */
const ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "title"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
  ol: new Set(["start"]),
  time: new Set(["datetime"]),
  abbr: new Set(["title"]),
};

/** 链接只认这几种协议；`javascript:`、`data:text/html` 这类一律去掉。 */
const SAFE_HREF = /^(https?:|mailto:|#)/i;
/** 图片允许网络地址和内嵌图片。 */
const SAFE_SRC = /^(https?:|data:image\/(png|jpe?g|gif|webp|avif);base64,)/i;

function resolve(raw: string, base: string): string | null {
  try {
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

/**
 * @param html Readability 的 `content`
 * @param base 文章地址，相对链接按它补全
 * @param doc 用哪个 document 造节点。缺省是当前页面的；测试里传 jsdom 的。
 */
export function sanitizeArticle(html: string, base: string, doc: Document = document): string {
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  const root = tpl.content;

  // 先把整棵树列出来再动手：一边遍历一边改结构会漏节点
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (!root.contains(el)) continue; // 祖先已经被整块丢掉了
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) {
      el.remove();
      continue;
    }
    if (!KEEP.has(tag)) {
      // 不认识的标签（picture、font、center、自定义元素……）：壳去掉，内容留下
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    const allowed = ATTRS[tag];
    for (const name of Array.from(el.getAttributeNames())) {
      const value = el.getAttribute(name) ?? "";
      if (!allowed?.has(name)) {
        el.removeAttribute(name);
        continue;
      }
      if (name === "href") {
        const abs = value.startsWith("#") ? value : resolve(value, base);
        if (!abs || !SAFE_HREF.test(abs)) el.removeAttribute(name);
        else el.setAttribute(name, abs);
      } else if (name === "src") {
        const abs = /^data:/i.test(value) ? value : resolve(value, base);
        if (!abs || !SAFE_SRC.test(abs)) el.removeAttribute(name);
        else el.setAttribute(name, abs);
      }
    }
    if (tag === "a") el.setAttribute("rel", "noreferrer");
    // 没有地址的图片是个空框，去掉
    if (tag === "img" && !el.hasAttribute("src")) el.remove();
  }
  return tpl.innerHTML;
}
