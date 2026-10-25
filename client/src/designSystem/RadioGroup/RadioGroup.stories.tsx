import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent } from 'storybook/test';
import { RadioGroup } from './RadioGroup';

const meta = {
    title: 'Design System/RadioGroup',
    component: RadioGroup<'system' | 'light' | 'dark'>,
    args: {
        'aria-label': 'Theme',
        value: 'system',
        onValueChange: fn(),
        options: [
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
        ],
    },
} satisfies Meta<typeof RadioGroup<'system' | 'light' | 'dark'>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithDescriptions: Story = {
    args: {
        options: [
            { value: 'system', label: 'System', description: 'Follow the device setting' },
            { value: 'light', label: 'Light', description: 'Always light' },
            { value: 'dark', label: 'Dark', description: 'Always dark' },
        ],
    },
};
export const DisabledOption: Story = {
    args: {
        options: [
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark', disabled: true },
        ],
    },
};
export const Disabled: Story = { args: { disabled: true } };
export const Focused: Story = {
    play: async () => {
        await userEvent.tab();
    },
};
