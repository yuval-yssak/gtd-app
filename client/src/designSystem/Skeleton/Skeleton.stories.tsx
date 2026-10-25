import type { Meta, StoryObj } from '@storybook/react';
import { Skeleton } from './Skeleton';

const meta = {
    title: 'Design System/Skeleton',
    component: Skeleton,
    parameters: { layout: 'padded' },
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

// The caller sizes a skeleton from its own class; inline sizes stand in for that here.
export const TextLine: Story = { args: { style: { inlineSize: '60%' } } };
export const Rect: Story = { args: { shape: 'rect', style: { blockSize: '4rem' } } };
export const Circle: Story = { args: { shape: 'circle', style: { inlineSize: '2.5rem', blockSize: '2.5rem' } } };
