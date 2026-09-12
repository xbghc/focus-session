import type { Meta, StoryObj } from '@storybook/html-vite';
import { controls, renderPage, type PageArgs } from './render.ts';
export default {
  title: '安卓/页面', render: renderPage, argTypes: controls,
  args: { page: 'app', state: 'populated', tab: 'articles', width: 390, height: 844 },
} satisfies Meta<PageArgs>;
type Story = StoryObj<PageArgs>;
export const Home: Story = { name: '首页 · 文章' };
export const EmptyHome: Story = { name: '首页 · 空状态', args: { state: 'empty' } };
export const Words: Story = { name: '生词本', args: { tab: 'words' } };
export const Review: Story = { name: '文章回顾', args: { tab: 'articleReview' } };
export const Reader: Story = { name: '阅读器', args: { page: 'reader' } };
export const ReaderLoading: Story = { name: '阅读器 · 判别中', args: { page: 'reader', state: 'loading' } };
export const ReaderError: Story = { name: '阅读器 · 抓取失败', args: { page: 'reader', state: 'empty' } };
export const Settings: Story = { name: '设置', args: { page: 'appOptions' } };

export const Classification: Story = { name: 'LLM 文章筛选', args: { tab: 'classification' } };
