import type { Meta, StoryObj } from '@storybook/react';
import { Pencil, Trash2 } from 'lucide-react';
import { fn, userEvent } from 'storybook/test';
import { IconButton } from './IconButton';

const meta = {
    title: 'Design System/IconButton',
    component: IconButton,
    args: { 'aria-label': 'Edit', children: <Pencil />, onClick: fn() },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Medium: Story = {};
export const Small: Story = { args: { size: 'sm' } };
export const Accent: Story = { args: { tone: 'accent' } };
export const Danger: Story = { args: { tone: 'danger', 'aria-label': 'Delete', children: <Trash2 /> } };
export const Selected: Story = { args: { selected: true } };
export const Disabled: Story = { args: { disabled: true } };

export const Focused: Story = {
    play: async () => {
        await userEvent.tab();
    },
};
