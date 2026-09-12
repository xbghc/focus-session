import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

export const pages = {
  popup: ['src/popup/popup.html', 'src/popup/index.ts'],
  dashboard: ['src/dashboard/dashboard.html', 'src/dashboard/index.ts'],
  options: ['src/options/options.html', 'src/options/index.ts'],
  sidepanel: ['src/sidepanel/sidepanel.html', 'src/sidepanel/index.ts'],
  app: ['src/app/index.html', 'src/app/index.ts'],
  reader: ['src/app/read.html', 'src/app/read.ts'],
  appOptions: ['src/options/options.html', 'src/app/options.ts'],
};
const root = resolve(import.meta.dirname, '..');
const cssFiles = { 'popup.css': 'src/popup/popup.css', 'dashboard.css': 'src/dashboard/dashboard.css', 'app.css': 'src/app/app.css' };
const script = text => `<script>${text.replace(/<\/script/gi, '<\\/script')}</script>`;

/** Bundle the real page entry; only the platform boot and transport are replaced. */
export async function compilePages() {
  const result = {};
  for (const [name, [template, entry]] of Object.entries(pages)) {
    const bundled = await build({
      stdin: { contents: `import './storybook/runtime.ts'; import './${entry}';`, resolveDir: root, loader: 'ts' },
      bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome114', minify: true,
      define: { __APP_VERSION__: '"storybook"', 'location.search': '"?u=https%3A%2F%2Fexample.com%2Fattention"' },
      plugins: [{ name: 'preview-platform', setup(api) {
        api.onResolve({ filter: /^\.\/boot\.ts$/ }, args => args.importer.replaceAll('\\', '/').includes('/src/app/')
          ? { path: resolve(root, 'storybook/app-boot.ts') } : undefined);
        api.onLoad({ filter: /[\\/]src[\\/]app[\\/]shim\.ts$/ }, async args => ({
          contents: (await readFile(args.path, 'utf8')).replace('new URL(".", location.href).href', 'document.baseURI'), loader: 'ts', resolveDir: dirname(args.path),
        }));
      } }],
    });
    let html = (await readFile(resolve(root, template), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    if (name === 'appOptions') html = html.replace('</head>', '<link rel="stylesheet" href="app.css" /></head>');
    for (const [file, path] of Object.entries(cssFiles)) {
      let css = await readFile(resolve(root, path), 'utf8');
      const fonts = [...css.matchAll(/url\(["']?fonts\/([^"')]+)["']?\)/g)];
      for (const font of fonts) {
        const data = await readFile(resolve(root, 'node_modules/@fontsource/source-serif-4/files', font[1]));
        css = css.replace(font[0], `url(data:font/woff2;base64,${data.toString('base64')})`);
      }
      html = html.replace(new RegExp(`<link[^>]*href="${file.replace('.', '\\.')}"[^>]*>`, 'g'), `<style>${css}</style>`);
    }
    html = html.replace('<head>', '<head><base href="https://preview.invalid/" /><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; font-src data:; img-src data: blob:; connect-src \'none\'; form-action \'none\'" />');
    result[name] = html.replace('</body>', `<!--PREVIEW_CONFIG-->${script(bundled.outputFiles[0].text)}</body>`);
  }
  return result;
}

export function pagePreviewPlugin() {
  const id = '\0virtual:focus-pages';
  return {
    name: 'focus-page-previews',
    resolveId(source) { if (source === 'virtual:focus-pages') return id; },
    async load(source) {
      if (source !== id) return;
      for (const folder of ['src', 'storybook']) {
        for (const file of await readdir(resolve(root, folder), { recursive: true })) {
          if (/\.(ts|html|css)$/.test(file)) this.addWatchFile(resolve(root, folder, file));
        }
      }
      return `export default ${JSON.stringify(await compilePages())};`;
    },
    handleHotUpdate(ctx) {
      if (!/[\\/](src|storybook)[\\/]/.test(ctx.file)) return;
      const module = ctx.server.moduleGraph.getModuleById(id);
      if (module) ctx.server.moduleGraph.invalidateModule(module);
      ctx.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
