export { shim } from './runtime.ts';
export const navigation = { beforeLeave: async () => undefined };
export const readerUrl = (url: string) => `read.html?u=${encodeURIComponent(url)}`;
export const isExternal = () => false;
export const go = async (url: string) => { console.info('[Storybook navigation]', url); };
