import type { RuleApplyReply, RuleChange, RuleChatReply, RuleChatTurn } from "../types.ts";
import { reasonOf } from "../lib/reason.ts";
import { el } from "./dom.ts";

/**
 * 名单对话的对话框：弹出面板和设置页共用（样式在 popup.css，所有页面都引它）。
 *
 * 说一句 → 模型把话翻成改动清单 → 列出来、每条一个勾（默认勾上）→ 点「确认」才写。
 * 没过规矩的那几条另列一行说明为什么，不给勾。对话记录只活在这个框里：关掉弹出面板就没了，
 * 名单本身才是要留下的东西。
 */

export interface RuleChatOptions {
  /** 弹出面板所在的那一页。「这个站」「这一页」指它；设置页不传。 */
  pageUrl?: () => Promise<string | undefined>;
  /** 写进去之后：设置页要把名单框跟上，弹出面板要重画当前页的状态。 */
  onApplied?: (applied: RuleChange[]) => void | Promise<void>;
  placeholder?: string;
}

const verb = (c: RuleChange): string => (c.op === "add" ? `加进${c.label}` : `从${c.label}移出`);

/** 一句话说清写进去了什么，也是补进对话记录里的那句，下一轮模型据此知道改没改成。 */
export function appliedSummary(applied: readonly RuleChange[]): string {
  return applied.length ? `已写入：${applied.map((c) => `${verb(c)} ${c.rule}`).join("；")}` : "没有写入任何改动";
}

export function ruleChatBox(opts: RuleChatOptions = {}): HTMLElement {
  const turns: RuleChatTurn[] = [];
  const log = el("div", { class: "rc-log", "aria-live": "polite" });
  const plan = el("div", { class: "rc-plan" });
  const input = el("input", { type: "text", class: "rc-input", placeholder: opts.placeholder ?? "比如：知乎以后别记了；GitHub 上自动开翻译", "aria-label": "要怎么改名单" });
  const sendBtn = el("button", { type: "submit", class: "btn" }, ["发送"]);
  const form = el("form", { class: "rc-ask" }, [input, sendBtn]);
  const root = el("div", { class: "rulechat" }, [log, plan, form]);

  const say = (role: RuleChatTurn["role"], text: string, cls = ""): void => {
    turns.push({ role, text });
    log.append(el("div", { class: `rc-turn rc-${role} ${cls}`.trim() }, [text]));
  };
  const note = (text: string, cls = "muted"): HTMLElement => {
    const n = el("div", { class: `rc-note small ${cls}` }, [text]);
    log.append(n);
    return n;
  };
  const busy = (on: boolean): void => {
    input.disabled = on;
    sendBtn.disabled = on;
  };

  const showPlan = (reply: Extract<RuleChatReply, { ok: true }>): void => {
    plan.replaceChildren();
    for (const r of reply.rejected) plan.append(el("div", { class: "rc-rejected small muted" }, [`没采用 ${r.rule}：${r.why}`]));
    if (reply.changes.length === 0) return;
    const boxes = reply.changes.map((c) => {
      const box = el("input", { type: "checkbox" });
      box.checked = true;
      const detail = [c.reason, c.op === "add" && c.hits !== undefined ? `命中 ${c.hits} 篇已有记录` : ""].filter(Boolean).join(" · ");
      plan.append(el("label", { class: `rc-change rc-${c.op}` }, [
        box,
        el("span", {}, [el("span", { class: "rc-what" }, [`${verb(c)}：`]), el("code", {}, [c.rule]), ...(detail ? [el("span", { class: "rc-why small muted" }, [detail])] : [])]),
      ]));
      return { box, change: c };
    });
    const ok = el("button", { type: "button", class: "btn rc-confirm" }, ["确认"]);
    const no = el("button", { type: "button", class: "btn rc-cancel" }, ["不改了"]);
    plan.append(el("div", { class: "rc-actions" }, [ok, no]));

    no.addEventListener("click", () => {
      plan.replaceChildren();
      say("assistant", "（这次的改动没有采用）", "muted small");
      input.focus();
    });
    ok.addEventListener("click", () => {
      const picked = boxes.filter((b) => b.box.checked).map((b) => b.change);
      if (picked.length === 0) {
        no.click();
        return;
      }
      ok.disabled = no.disabled = true;
      void (async () => {
        let res: RuleApplyReply;
        try {
          res = (await chrome.runtime.sendMessage({ type: "rules:apply", changes: picked })) as RuleApplyReply;
        } catch (err) {
          res = { ok: false, error: reasonOf(err) };
        }
        if (!res?.ok) {
          ok.disabled = no.disabled = false;
          plan.append(el("div", { class: "rc-error small" }, [`没写进去：${res?.error ?? "后台没有应答"}`]));
          return;
        }
        plan.replaceChildren();
        say("assistant", appliedSummary(res.applied), "rc-done");
        for (const r of res.rejected) note(`没写入 ${r.rule}：${r.why}`);
        await opts.onApplied?.(res.applied);
        input.focus();
      })();
    });
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || input.disabled) return;
    plan.replaceChildren();
    say("user", text);
    input.value = "";
    busy(true);
    const waiting = note("正在理解…");
    void (async () => {
      let res: RuleChatReply;
      try {
        const pageUrl = await opts.pageUrl?.();
        res = (await chrome.runtime.sendMessage({ type: "rules:chat", turns, ...(pageUrl ? { pageUrl } : {}) })) as RuleChatReply;
      } catch (err) {
        res = { ok: false, error: reasonOf(err) };
      }
      waiting.remove();
      busy(false);
      if (!res?.ok) {
        // 这一句没说成：从记录里拿掉，字放回输入框，改一改再发
        turns.pop();
        log.lastElementChild?.remove();
        input.value = text;
        note(`没理解成：${res?.error ?? "后台没有应答"}`, "rc-error");
        input.focus();
        return;
      }
      say("assistant", res.reply);
      showPlan(res);
      if (res.changes.length === 0) input.focus();
    })();
  });

  return root;
}
