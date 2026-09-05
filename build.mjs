import { build, context } from "esbuild";
import { rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, watch as watchFs } from "node:fs";
import { join } from "node:path";

/*
 * 两个产物，同一份源码：
 *   node build.mjs          → dist/                           浏览器扩展
 *   node build.mjs --app    → android/app/src/main/assets/www  安卓 App 的网页部分
 *
 * App 的三个页面（首页 / 阅读器 / 设置）各自的入口在 src/app/ 下，第一件事都是装上
 * chrome.* 的垫片（src/app/boot.ts），之后引用的就是扩展那几个页面自己的代码。
 *
 * 只打包拉丁字形（约 60KB）。中文不打包：界面里的中文全部来自 LLM 输出，
 * 是任意的，子集必然漏字，漏掉的那个字跳成系统宋体反而比整体用系统宋体更难看；
 * 全量中文衬线又是 10MB 起。系统宋体（SimSun / Songti SC / Noto Serif CJK）
 * 到处都有，交给它。
 */
const FONT_DIR = "node_modules/@fontsource/source-serif-4/files";
const FONTS = [
  "source-serif-4-latin-400-normal.woff2",
  "source-serif-4-latin-600-normal.woff2",
  "source-serif-4-latin-400-italic.woff2",
];

const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");
const app = process.argv.includes("--app");
const OUT = app ? "android/app/src/main/assets/www" : "dist";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function copyFonts() {
  mkdirSync(join(OUT, "fonts"), { recursive: true });
  for (const f of FONTS) copyFileSync(join(FONT_DIR, f), join(OUT, "fonts", f));
}

/** 扩展的静态资源：manifest 从 package.json 取版本号，html/css 原样拷贝。 */
function copyStaticExtension() {
  mkdirSync(OUT, { recursive: true });
  const manifest = JSON.parse(readFileSync("src/manifest.json", "utf8"));
  manifest.version = pkg.version;
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  copyFonts();
  for (const [from, to] of [
    ["src/popup/popup.html", "popup.html"],
    ["src/popup/popup.css", "popup.css"],
    ["src/options/options.html", "options.html"],
    ["src/dashboard/dashboard.html", "dashboard.html"],
    ["src/dashboard/dashboard.css", "dashboard.css"],
    ["src/sidepanel/sidepanel.html", "sidepanel.html"],
  ]) {
    copyFileSync(from, join(OUT, to));
  }
}

/**
 * App 的静态资源。设置页和扩展共用同一份 options.html，拷进 App 时补上手机的 viewport
 * 和 App 的样式——这两行放进源文件的话扩展那边会多一个 404 的样式表。
 */
function copyStaticApp() {
  mkdirSync(OUT, { recursive: true });
  copyFonts();
  for (const [from, to] of [
    ["src/popup/popup.css", "popup.css"],
    ["src/dashboard/dashboard.css", "dashboard.css"],
    ["src/app/app.css", "app.css"],
    ["src/app/index.html", "index.html"],
    ["src/app/read.html", "read.html"],
  ]) {
    copyFileSync(from, join(OUT, to));
  }
  const options = readFileSync("src/options/options.html", "utf8").replace(
    '<meta charset="utf-8" />',
    '<meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n    <meta name="color-scheme" content="light dark" />\n    <link rel="stylesheet" href="app.css" />',
  );
  writeFileSync(join(OUT, "options.html"), options);
}

const copyStatic = app ? copyStaticApp : copyStaticExtension;

const options = app
  ? {
      entryPoints: {
        index: "src/app/index.ts",
        read: "src/app/read.ts",
        options: "src/app/options.ts",
      },
      outdir: OUT,
      bundle: true,
      format: "iife",
      // Android 8 以上的 WebView 随 Play 更新，都是近两年的 Chromium
      target: ["chrome100"],
      platform: "browser",
      minify: !dev,
      sourcemap: dev ? "inline" : false,
      legalComments: "none",
      logLevel: "info",
      // 产物里保留中文，出问题时在 assets 里能直接搜到
      charset: "utf8",
      define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    }
  : {
      entryPoints: {
        content: "src/content/index.ts",
        background: "src/background/index.ts",
        popup: "src/popup/index.ts",
        options: "src/options/index.ts",
        dashboard: "src/dashboard/index.ts",
        sidepanel: "src/sidepanel/index.ts",
      },
      outdir: OUT,
      bundle: true,
      // content script 必须是非 module 脚本，统一打成 IIFE 最省事
      format: "iife",
      // Side Panel 需要 Chrome 114+，target 跟着抬到那条线
      target: ["chrome114"],
      platform: "browser",
      minify: !dev,
      sourcemap: dev ? "inline" : false,
      legalComments: "none",
      logLevel: "info",
    };

copyStatic();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  // esbuild 只盯 JS 依赖图，html/css/manifest 改动得自己看着
  watchFs("src", { recursive: true }, (_event, file) => {
    if (!file) return;
    if (!/\.(html|css|json)$/.test(file)) return;
    copyStatic();
    console.log(`[focus-session] 已同步静态资源（${file}）`);
  });
  console.log("[focus-session] watching…");
} else {
  await build(options);
  console.log(`[focus-session] built ${OUT}/ (${app ? "app, " : ""}${dev ? "dev" : "production"})`);
}
