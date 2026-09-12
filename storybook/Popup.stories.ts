import type { Meta, StoryObj } from '@storybook/html-vite';
import { controls, renderPage, type PageArgs } from './render.ts';
export default {
  title: '扩展/弹出面板', render: renderPage, argTypes: controls,
  args: { page: 'popup', state: 'populated', tab: 'current', width: 380, height: 760 },
} satisfies Meta<PageArgs>;
type Story = StoryObj<PageArgs>;
export const Current: Story = { name: '当前阅读' };
export const History: Story = { name: '历史记录', args: { tab: 'history' } };
export const Overview: Story = { name: '阅读概览', args: { tab: 'overview' } };
export const NonArticle: Story = { name: '非文章 · 翻译可用', args: { state: 'nonArticle' } };
export const Classifying: Story = { name: 'LLM 判别中', args: { state: 'loading' } };
export const Failed: Story = { name: 'LLM 判别失败', args: { state: 'error' } };
export const EmptyHistory: Story = { name: '空历史', args: { state: 'empty', tab: 'history' } };
