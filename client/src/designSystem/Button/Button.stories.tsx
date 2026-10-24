import type { Meta, StoryObj } from '@storybook/react';
import { Plus, Trash2 } from 'lucide-react';
import { fn, userEvent, within } from 'storybook/test';
import { Button } from './Button';

const meta = {
    title: 'Design System/Button',
    component: Button,
    args: { children: 'Save', onClick: fn() },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ghost: Story = {};
export const Solid: Story = { args: { variant: 'solid' } };
export const Outline: Story = { args: { variant: 'outline' } };
export const Small: Story = { args: { variant: 'outline', size: 'sm' } };
export const Large: Story = { args: { variant: 'solid', size: 'lg' } };
export const WithStartIcon: Story = { args: { variant: 'solid', startIcon: <Plus />, children: 'Add person' } };
export const Danger: Story = { args: { variant: 'solid', tone: 'danger', startIcon: <Trash2 />, children: 'Delete' } };
export const DangerGhost: Story = { args: { tone: 'danger', children: 'Discard' } };
export const Neutral: Story = { args: { variant: 'outline', tone: 'neutral', children: 'Cancel' } };
export const Disabled: Story = { args: { variant: 'solid', disabled: true } };
export const Loading: Story = { args: { variant: 'solid', loading: true } };
export const FullWidth: Story = { args: { variant: 'solid', fullWidth: true }, parameters: { layout: 'padded' } };

export const Focused: Story = {
    args: { variant: 'solid' },
    play: async ({ canvasElement }) => {
        await userEvent.tab();
        await within(canvasElement).findByRole('button');
    },
};
