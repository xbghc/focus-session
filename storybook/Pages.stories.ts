import type { Meta, StoryObj } from '@storybook/html-vite';
import { controls, renderPage, type PageArgs } from './render.ts';
export default {
  title: '扩展/页面', render: renderPage, argTypes: controls,
  args: { page: 'dashboard', state: 'populated', tab: 'articles', width: 1040, height: 860 },
} satisfies Meta<PageArgs>;
type Story = StoryObj<PageArgs>;
export const Articles: Story = { name: '文章 · 筛选与批量操作' };
export const Empty: Story = { name: '文章 · 空状态', args: { state: 'empty' } };
export const Words: Story = { name: '生词本', args: { tab: 'words' } };
export const WordReview: Story = { name: '生词复习', args: { tab: 'review' } };
export const ArticleReview: Story = { name: '文章回顾', args: { tab: 'articleReview' } };
export const EmptyReview: Story = { name: '复习 · 空队列', args: { tab: 'review', state: 'empty' } };
export const Settings: Story = { name: '设置 · 独立黑名单', args: { page: 'options' } };
export const NewSettings: Story = { name: '设置 · 未配置模型', args: { page: 'options', state: 'empty' } };
export const Sidebar: Story = { name: '侧边栏 · 本文生词', args: { page: 'sidepanel', width: 380 } };
export const EmptySidebar: Story = { name: '侧边栏 · 空状态', args: { page: 'sidepanel', width: 380, state: 'empty' } };

export const Classification: Story = { name: 'LLM 文章筛选 · 混合结果', args: { tab: 'classification' } };
export const ClassificationLoading: Story = { name: 'LLM 文章筛选 · 处理中', args: { tab: 'classification', state: 'loading' } };
export const ClassificationFailed: Story = { name: 'LLM 文章筛选 · 失败重试', args: { tab: 'classification', state: 'error' } };
