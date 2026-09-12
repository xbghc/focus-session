import { pagePreviewPlugin } from './pages-plugin.mjs';
export default {
  framework: '@storybook/html-vite',
  stories: ['../storybook/**/*.stories.ts'],
  addons: [],
  core: { disableTelemetry: true },
  async viteFinal(config) {
    return { ...config, plugins: [...(config.plugins ?? []), pagePreviewPlugin()] };
  },
};
