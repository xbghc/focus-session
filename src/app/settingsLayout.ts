import { sectionName } from "../options/nav.ts";

/** Keep the shared settings controls and handlers, but give the app a compact section index. */
export function setupSettingsLayout(): void {
  document.body.classList.add("mobile-settings");
  const title = document.querySelector("h1");
  if (title) title.textContent = "设置";
  const intro = title?.nextElementSibling;
  if (intro?.tagName === "P") {
    const privacy = document.createElement("details");
    privacy.className = "settings-privacy";
    const summary = document.createElement("summary");
    summary.textContent = "数据存储与隐私说明";
    intro.before(privacy);
    privacy.append(summary, intro);
  }
  const descriptions: Record<string, string> = {
    "设备同步": "服务器连接、同步状态与离线记录",
    "划词翻译": "翻译开关、选区与词汇讲解",
    "读完判定": "调整文章的完成标准",
    "续读位置": "返回上次阅读的段落",
    "文章回顾": "大纲与回想问题",
    "走神阈值": "专注计时与静默时限",
    "段落已读判定": "停留时长与阅读比例",
    "统计口径": "专注片段与阅读统计",
    "文章记录黑名单": "不记录这些页面，仍可翻译",
    "翻译黑名单": "不翻译这些页面，仍可记录",
    "数据": "导入、导出与清理记录",
    "诊断日志": "调用耗时、错误记录与按钮使用统计",
    "更新": "版本信息与应用更新",
  };
  for (const fieldset of document.querySelectorAll<HTMLFieldSetElement>("body > fieldset")) {
    const legend = fieldset.querySelector("legend");
    const name = sectionName(fieldset) || "设置";
    const section = document.createElement("details");
    section.className = "settings-section";
    const summary = document.createElement("summary");
    const heading = document.createElement("strong");
    const llm = !!fieldset.querySelector("#apiKey");
    heading.textContent = llm ? "模型连接" : name;
    const description = document.createElement("span");
    description.textContent = llm ? "API 密钥、模型与连接测试" : descriptions[name] ?? "阅读行为与记录参数";
    summary.append(heading, description);
    fieldset.before(section);
    section.append(summary, fieldset);
    if (name === "更新" && location.hash === "#update") {
      section.open = true;
      requestAnimationFrame(() => section.scrollIntoView({ block: "start" }));
    }
    if (name === "设备同步" && location.hash === "#sync") section.open = true;
    fieldset.setAttribute("aria-label", heading.textContent);
    // 扩展里收在标题旁「i」后面的说明：按钮跟着 legend 一起没了。这里换成分区开头的一行「这是什么」，
    // 点开才铺出来——手机上三段说明先占掉半屏，要填的那两个框就被挤到下面去了
    for (const about of fieldset.querySelectorAll<HTMLElement>(".info-pop")) {
      const fold = document.createElement("details");
      fold.className = "settings-about";
      const what = document.createElement("summary");
      what.textContent = "这是什么";
      about.before(fold);
      about.hidden = false;
      about.className = "muted small";
      fold.append(what, about);
    }
    legend?.remove();
  }
  const save = document.getElementById("save");
  const actions = save?.parentElement;
  if (actions) {
    actions.classList.add("settings-savebar");
    document.body.append(actions);
  }
  const status = document.getElementById("status");
  status?.setAttribute("role", "status");
}
