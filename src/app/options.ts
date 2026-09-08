import "./boot.ts";
import { fetchLog } from "../options/index.ts";
import { native } from "./native.ts";

/**
 * App 的设置页就是扩展的设置页，只多两样：回首页的入口（手机上没有标签栏可以关），
 * 以及两个「分享…」——「导出 JSON」和「下载 JSON」都只是写进下载目录，要把文件弄到
 * 电脑上还得再开一个文件管理器；分享面板一步到位（发给自己的聊天窗口、存网盘、
 * AirDrop 一类都从这里走）。
 *
 * 页面本身的手机适配在 options/options.html 的那段媒体查询里，两端共用。
 */

const bar = document.createElement("div");
bar.className = "topnav";
const back = document.createElement("a");
back.href = "index.html";
back.textContent = "‹ 返回";
bar.append(back);
document.body.prepend(bar);

const bridge = native();
const stamp = (): string => new Date().toISOString().slice(0, 10);

/**
 * 在某个按钮后面补一个「分享…」。宿主没提供分享桥（普通浏览器里调试）时什么都不加。
 * 文件名跟着旁边那个下载按钮走：同一份东西，分享出去和存下来该叫同一个名字。
 */
function addShare(afterId: string, label: string, filename: () => string, load: () => Promise<unknown>): void {
  const anchor = document.getElementById(afterId);
  const shareFile = bridge?.shareFile;
  if (!shareFile || !anchor) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", () => {
    void (async () => {
      const data = await load();
      shareFile(filename(), "application/json", JSON.stringify(data, null, 2));
    })();
  });
  anchor.after(btn);
}

addShare("export", "分享导出文件…", () => `focus-session-${stamp()}.json`, () =>
  chrome.runtime.sendMessage({ type: "data:export" }),
);
addShare("log-download", "分享日志…", () => `focus-session-llm-log-${stamp()}.json`, fetchLog);
