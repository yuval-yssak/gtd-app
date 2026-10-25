import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent } from 'storybook/test';
import { Tabs } from './Tabs';

const meta = {
    title: 'Design System/Tabs',
    component: Tabs<'nextAction' | 'calendar'>,
    args: {
        'aria-label': 'Routine type',
        value: 'nextAction',
        onValueChange: fn(),
        tabs: [
            { value: 'nextAction', label: 'Next Action (4)' },
            { value: 'calendar', label: 'Calendar (2)' },
        ],
    },
} satisfies Meta<typeof Tabs<'nextAction' | 'calendar'>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FirstSelected: Story = {};
export const SecondSelected: Story = { args: { value: 'calendar' } };
export const Focused: Story = {
    play: async () => {
        await userEvent.tab();
    },
};
