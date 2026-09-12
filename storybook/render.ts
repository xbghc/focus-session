import type { Meta } from "@storybook/html-vite";
import pages from 'virtual:focus-pages';
export interface PageArgs {
  page: keyof typeof pages;
  state: 'populated' | 'empty' | 'nonArticle' | 'loading' | 'error';
  tab: string;
  width: number;
  height: number;
}
export function renderPage(args: PageArgs): HTMLElement {
  const frame = document.createElement('iframe');
  frame.title = `Focus Session · ${args.page} · ${args.state}`;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-modals');
  frame.style.cssText = `box-sizing:border-box;display:block;width:min(calc(100% - 32px),${args.width}px);height:${args.height}px;border:1px solid #d8d5ce;margin:16px auto;background:white;border-radius:8px;`;
  const config = JSON.stringify({ state: args.state, tab: args.tab, page: args.page }).replaceAll('<', '\\u003c');
  frame.srcdoc = pages[args.page].replace('<!--PREVIEW_CONFIG-->', `<script>window.__PREVIEW__=${config};</script>`);
  return frame;
}
export const controls: Meta<PageArgs>["argTypes"] = {
  page: { control: false },
  state: { control: 'select', options: ['populated', 'empty', 'nonArticle', 'loading', 'error'] },
  tab: { control: 'select', options: ['current', 'history', 'overview', 'articles', 'words', 'review', 'articleReview', 'classification'] },
  width: { control: { type: 'range', min: 320, max: 1440, step: 10 } },
  height: { control: { type: 'range', min: 400, max: 1200, step: 20 } },
};
