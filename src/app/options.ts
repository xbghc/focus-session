import "./boot.ts";
import { fetchLog } from "../options/index.ts";
import { native } from "./native.ts";
import type { Update } from "../lib/update.ts";
import {
  RELEASES_PAGE,
  autoCheckEnabled,
  canSelfUpdate,
  checkForUpdate,
  currentVersion,
  downloadAndInstall,
  isDebugBuild,
  markChecked,
  setAutoCheck,
  skipVersion,
} from "./update.ts";

/**
 * App 的设置页就是扩展的设置页，只多三样：回首页的入口（手机上没有标签栏可以关）、
 * 两个「分享…」——「导出 JSON」和「下载 JSON」都只是写进下载目录，要把文件弄到
 * 电脑上还得再开一个文件管理器；分享面板一步到位（发给自己的聊天窗口、存网盘、
 * AirDrop 一类都从这里走）——以及末尾那个「更新」。
 *
 * 「更新」只在 App 里出现：扩展有应用商店管升级，App 是自己装的 APK，
 * 不自己问一声就没人告诉它有新版本。
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

/* ==================== 更新 ==================== */

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;

/**
 * 页面末尾那个「更新」。不在宿主里（用普通浏览器打开 www/ 调试）时整块不出现——
 * 那种情形下既问不到装的是哪个版本，也没人能把包装上去。
 */
function addUpdateSection(): void {
  if (!native()) return;

  const box = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "更新";
  box.append(legend);

  const selfUpdate = canSelfUpdate();
  const debug = isDebugBuild();

  const check = document.createElement("div");
  check.className = "field check";
  const autoLabel = document.createElement("label");
  autoLabel.htmlFor = "update-auto";
  autoLabel.textContent = "每天检查一次新版本";
  const auto = document.createElement("input");
  auto.id = "update-auto";
  auto.type = "checkbox";
  auto.style.width = "auto";
  auto.checked = autoCheckEnabled();
  auto.addEventListener("change", () => setAutoCheck(auto.checked));
  const autoHint = document.createElement("span");
  autoHint.className = "hint";
  autoHint.textContent = "只问 GitHub「最新的一次发布是哪个版本」，不带阅读记录，也不带当前版本号";
  check.append(autoLabel, auto, autoHint);
  box.append(check);

  const row = document.createElement("div");
  row.className = "row";
  const checkBtn = document.createElement("button");
  checkBtn.type = "button";
  checkBtn.textContent = "检查更新";
  const installBtn = document.createElement("button");
  installBtn.type = "button";
  installBtn.className = "primary";
  installBtn.textContent = "下载并安装";
  installBtn.hidden = true;
  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.textContent = "跳过这个版本";
  skipBtn.hidden = true;
  const status = document.createElement("span");
  status.className = "muted small";
  status.textContent = `当前版本 ${currentVersion()}`;
  row.append(checkBtn, installBtn, skipBtn, status);
  box.append(row);

  // Release 的说明是 markdown 原文，一律按纯文本渲染：这个页面和阅读器同源，
  // 手里攥着全部记录和宿主桥，不给远端的字符串任何变成标记的机会
  const notes = document.createElement("pre");
  notes.className = "update-notes muted small";
  notes.hidden = true;
  box.append(notes);

  const foot = document.createElement("p");
  foot.className = "muted small";
  box.append(foot);
  if (debug) {
    // 系统装不上签名不一致的包，会甩一句没头没尾的「应用未安装」，
    // 与其让人对着它猜，不如提前说清楚
    foot.textContent =
      "装着的是 debug 签名的包（自己构建或从 CI 的 Artifacts 下的），" +
      "覆盖不上正式签名的发布版。要换过去：先在上面导出数据，卸载，装新包，再导入回来。";
    installBtn.remove();
  } else if (!selfUpdate) {
    foot.textContent = "这个版本的 App 还不会自己下载升级包，去 Releases 页面手动下一个。";
    installBtn.remove();
  } else {
    foot.textContent =
      "App 不走应用商店，升级包来自 GitHub Releases，下好之后由系统的安装器接手" +
      "（第一次会问要不要允许「安装未知应用」）。数据存在 App 自己的存储里，覆盖安装不动它。";
  }

  /*
   * 地址写成可以选中的文字，不做成链接：App 里点站外链接一律进阅读器（见 boot.ts），
   * 而 Releases 是个用来下文件的页面，进了阅读器就是条死路。长按复制，去浏览器开。
   */
  const linkLine = document.createElement("p");
  linkLine.className = "update-link muted small";
  linkLine.textContent = `自己下的话：${RELEASES_PAGE}`;
  box.append(linkLine);

  let found: Update | null = null;

  const show = (update: Update | null): void => {
    found = update;
    installBtn.hidden = !update || debug || !selfUpdate;
    skipBtn.hidden = !update;
    notes.hidden = !update?.notes;
    notes.textContent = update?.notes ?? "";
  };

  checkBtn.addEventListener("click", () => {
    void (async () => {
      checkBtn.disabled = true;
      status.textContent = "正在检查…";
      show(null);
      try {
        markChecked();
        const update = await checkForUpdate();
        if (!update) {
          status.textContent = `已经是最新的（${currentVersion()}）`;
          return;
        }
        show(update);
        status.textContent = `有新版本 ${update.version}（${mb(update.apk.size)}），当前 ${currentVersion()}`;
      } catch (err) {
        status.textContent = `检查失败：${err instanceof Error ? err.message : String(err)}`;
      } finally {
        checkBtn.disabled = false;
      }
    })();
  });

  installBtn.addEventListener("click", () => {
    const update = found;
    if (!update) return;
    void (async () => {
      installBtn.disabled = true;
      checkBtn.disabled = true;
      status.textContent = "正在下载…";
      try {
        await downloadAndInstall(update, (received, total) => {
          // 对方没报长度时 total 是 0，只报已下多少
          status.textContent = total
            ? `正在下载 ${mb(received)} / ${mb(total)}`
            : `正在下载 ${mb(received)}`;
        });
        status.textContent = "下载完成，按系统提示完成安装";
      } catch (err) {
        status.textContent = `下载失败：${err instanceof Error ? err.message : String(err)}`;
        installBtn.disabled = false;
      } finally {
        checkBtn.disabled = false;
      }
    })();
  });

  skipBtn.addEventListener("click", () => {
    if (found) skipVersion(found.version);
    status.textContent = "这个版本不再提示了，下一个版本照常提示";
    show(null);
  });

  document.body.append(box);

  // 从首页那条提示点进来的：直接滚到这儿，并且顺手查一次
  if (location.hash === "#update") {
    box.scrollIntoView({ block: "center" });
    checkBtn.click();
  }
}

addUpdateSection();
