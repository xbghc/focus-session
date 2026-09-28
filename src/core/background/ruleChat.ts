import { callMessages, extractJson } from "../../lib/llm.ts";
import { later, recordCall, recordFailure } from "../../background/llmLog.ts";
import { getArticles, getSettings, updateSettings } from "../../background/store.ts";
import { applyRuleChanges, parseRulePlan, ruleChatInput, ruleChatSystem, type UrlRuleList } from "../../lib/ruleChat.ts";
import { matchesUrlRule } from "../../lib/url.ts";
import { reasonOf } from "../../lib/reason.ts";
import { getLlmConfig } from "./llm.ts";
import type { RuleApplyReply, RuleChange, RuleChatReply, RuleRejected, Settings } from "../../types.ts";
import type { HandlerMap } from "./router.ts";

/*
 * 名单对话的后台一半：一句话 → 模型 → 改动清单（不写）；人确认 → 在最新的名单上再核一遍、写进去。
 *
 * 不认识具体有哪几份名单：各功能插件在自己的 settings.ts 里声明（READING_URL_LISTS 这类），
 * 由 background/handle.ts 组装时交进来。这里只知道它们都是设置里的一个字符串数组。
 */

type Lists = Record<string, string[]>;

function listsOf(settings: Settings, lists: readonly UrlRuleList[]): Lists {
  const flat = settings as unknown as Record<string, unknown>;
  return Object.fromEntries(lists.map((l) => {
    const v = flat[l.key];
    return [l.key, Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : []];
  }));
}

/** 每条「加」的规则命中了多少篇已有的阅读记录。 */
async function withHits(changes: RuleChange[]): Promise<RuleChange[]> {
  if (!changes.some((c) => c.op === "add")) return changes;
  const urls = Object.values(await getArticles()).map((a) => a.url);
  return changes.map((c) => c.op === "add" ? { ...c, hits: urls.filter((u) => matchesUrlRule(u, c.rule)).length } : c);
}

export function ruleChatHandlers(lists: readonly UrlRuleList[]) {
  return {
    "rules:chat": async (m): Promise<RuleChatReply> => {
      const turns = Array.isArray(m.turns) ? m.turns.filter((t) => t && typeof t.text === "string" && t.text.trim()) : [];
      if (turns.at(-1)?.role !== "user") return { ok: false, error: "先说一句要怎么改" };
      const current = listsOf(await getSettings(), lists);
      const pageUrl = typeof m.pageUrl === "string" && /^https?:\/\//i.test(m.pageUrl) ? m.pageUrl : undefined;
      const saved = await getLlmConfig();
      // 名单长了之后输出也不短（每条带一句依据），给足余量
      const config = { ...saved, maxTokens: Math.max(1500, saved.maxTokens) };
      try {
        const result = await callMessages(config, ruleChatSystem(lists, current, pageUrl), ruleChatInput(turns));
        later(() => recordCall("ruleChat", config, result.timing, result.usage));
        if (result.truncated) throw new Error("模型输出被截断，换个短一点的说法试试");
        const plan = parseRulePlan(extractJson(result.text), lists, current);
        return { ok: true, ...plan, changes: await withHits(plan.changes) };
      } catch (err) {
        later(() => recordFailure(err, config, { source: "ruleChat", request: { message: turns.at(-1)!.text, pageUrl: pageUrl ?? null } }));
        return { ok: false, error: reasonOf(err) };
      }
    },

    "rules:apply": async (m): Promise<RuleApplyReply> => {
      const asked = Array.isArray(m.changes) ? m.changes : [];
      let applied: RuleChange[] = [];
      let rejected: RuleRejected[] = [];
      try {
        // 清单出来到人点确认之间，名单可能被设置页、「本站始终开启」改过：在最新的那份上重新核、重新套
        await updateSettings((settings) => {
          const current = listsOf(settings, lists);
          const plan = parseRulePlan({ reply: "", changes: asked }, lists, current);
          applied = plan.changes;
          rejected = plan.rejected;
          return Object.fromEntries(lists
            .filter((l) => applied.some((c) => c.list === l.key))
            .map((l) => [l.key, applyRuleChanges(current[l.key] ?? [], applied.filter((c) => c.list === l.key))])) as Partial<Settings>;
        });
      } catch (err) {
        return { ok: false, error: reasonOf(err) };
      }
      return { ok: true, applied, rejected };
    },
  } satisfies HandlerMap;
}
