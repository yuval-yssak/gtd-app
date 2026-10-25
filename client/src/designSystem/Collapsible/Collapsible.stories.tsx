import type { Meta, StoryObj } from '@storybook/react';
import { Collapsible } from './Collapsible';

const meta = {
    title: 'Design System/Collapsible',
    component: Collapsible,
    args: { open: false, children: <p>Collapsible content that animates its height.</p> },
    parameters: { layout: 'padded' },
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {};
export const Expanded: Story = { args: { open: true } };
