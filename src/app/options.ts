import "./boot.ts";
import "../options/index.ts";
import type { ExportBundle } from "../types.ts";
import { native } from "./native.ts";

/**
 * App 的设置页就是扩展的设置页，只多两样：回首页的入口（手机上没有标签栏可以关），
 * 以及「分享导出文件」——「导出 JSON」写进下载目录，要把它弄到电脑上还得再开一个文件管理器；
 * 分享面板一步到位（发给自己的聊天窗口、存网盘、AirDrop 一类都从这里走）。
 */

const bar = document.createElement("div");
bar.className = "topnav";
const back = document.createElement("a");
back.href = "index.html";
back.textContent = "‹ 返回";
bar.append(back);
document.body.prepend(bar);

const bridge = native();
const exportBtn = document.getElementById("export");
if (bridge?.shareFile && exportBtn) {
  const share = document.createElement("button");
  share.type = "button";
  share.textContent = "分享导出文件…";
  share.addEventListener("click", async () => {
    const bundle = (await chrome.runtime.sendMessage({ type: "data:export" })) as ExportBundle;
    bridge.shareFile!(
      `focus-session-${new Date().toISOString().slice(0, 10)}.json`,
      "application/json",
      JSON.stringify(bundle, null, 2),
    );
  });
  exportBtn.after(share);
}
