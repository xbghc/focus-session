/** 跟踪参数：去掉后同一篇文章的不同来源链接才能聚合到一起。 */
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|dclid$|msclkid$|mc_cid$|mc_eid$|igshid$|spm$|scm$|share_|ref_src$|_hsenc$|_hsmi$|yclid$|from_source$)/i;

/**
 * 文章标识：去掉 hash 与跟踪参数后的 URL。
 * 解析失败时原样返回，宁可少聚合也不要丢数据。
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    return u.toString();
  } catch {
    return raw;
  }
}

export function hostnameOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "";
  }
}

/**
 * 域名是否命中排除列表。
 * 支持裸域（news.com 同时匹配其子域）与 *.news.com 写法。
 */
export function isExcluded(hostname: string, patterns: string[]): boolean {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase().replace(/^\*\./, "").replace(/^\.+/, "");
    if (!p) return false;
    return host === p || host.endsWith("." + p);
  });
}

/** 域名规则包含子域；完整 URL 按源与路径边界匹配，路径区分大小写。 */
export function matchesUrlRule(rawUrl: string, rule: string): boolean {
  try {
    const url = new URL(rawUrl);
    const value = rule.trim();
    if (!/^https?:\/\//i.test(value)) {
      if (!/^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(value)) return false;
      return isExcluded(url.hostname, [value]);
    }
    const target = new URL(value);
    if (target.username || target.password || target.hash || target.search) return false;
    const path = target.pathname.replace(/\/$/, "");
    return url.origin === target.origin && (url.pathname === path || url.pathname.startsWith(path + "/"));
  } catch { return false; }
}

export const isUrlExcluded = (url: string, rules: string[]): boolean => rules.some(rule => matchesUrlRule(url, rule));
