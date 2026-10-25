import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent } from 'storybook/test';
import { Switch } from './Switch';

const meta = {
    title: 'Design System/Switch',
    component: Switch,
    args: { checked: false, onCheckedChange: fn(), label: 'Show briefs' },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {};
export const On: Story = { args: { checked: true } };
export const WithDescription: Story = { args: { checked: true, description: 'One-line summaries in the weekly review' } };
export const Disabled: Story = { args: { disabled: true } };
export const DisabledOn: Story = { args: { checked: true, disabled: true } };
/** No visible label: an aria-label names it (a row whose own text labels the switch). */
export const Unlabelled: Story = { args: { label: undefined, 'aria-label': 'Visible' } };
export const Focused: Story = {
    play: async () => {
        await userEvent.tab();
    },
};
