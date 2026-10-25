import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent } from 'storybook/test';
import { Checkbox } from './Checkbox';

const meta = {
    title: 'Design System/Checkbox',
    component: Checkbox,
    args: { checked: false, onCheckedChange: fn(), label: 'Sync Primary' },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {};
export const Checked: Story = { args: { checked: true } };
/** Some, not all, of what it stands for is selected. */
export const Indeterminate: Story = { args: { checked: true, indeterminate: true, label: 'All calendars' } };
export const Small: Story = { args: { checked: true, size: 'sm' } };
export const WithDescription: Story = { args: { description: 'Events from this calendar appear in the app' } };
export const Disabled: Story = { args: { disabled: true } };
export const DisabledChecked: Story = { args: { checked: true, disabled: true } };
export const Focused: Story = {
    play: async () => {
        await userEvent.tab();
    },
};
