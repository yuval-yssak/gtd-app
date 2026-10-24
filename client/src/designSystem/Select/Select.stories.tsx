import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { userEvent, within } from 'storybook/test';
import { Select } from './Select';

const OPTIONS = [
    { value: 'personal', label: 'Personal calendar' },
    { value: 'work', label: 'Work calendar' },
    { value: 'family', label: 'Family', disabled: true },
] as const;

function CalendarSelect({ disabled = false, initial = 'personal' }: { disabled?: boolean; initial?: (typeof OPTIONS)[number]['value'] }) {
    const [value, setValue] = useState(initial);
    return <Select label="Calendar" value={value} onValueChange={setValue} options={OPTIONS} disabled={disabled} />;
}

const meta = {
    title: 'Design System/Select',
    component: CalendarSelect,
} satisfies Meta<typeof CalendarSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};
export const Disabled: Story = { args: { disabled: true } };
export const Open: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.click(within(canvasElement).getByRole('combobox', { name: 'Calendar' }));
        await within(document.body).findByRole('listbox');
    },
};

const ACCOUNT_CALENDARS = [
    { value: '', label: 'Default' },
    { value: 'a-work', label: 'Work', group: 'dana@example.com' },
    { value: 'a-home', label: 'Home', group: 'dana@example.com' },
    { value: 'b-team', label: 'Team', group: 'dana@work.example.com' },
];

function GroupedSelect() {
    const [value, setValue] = useState('');
    return <Select label="Calendar" value={value} onValueChange={setValue} options={ACCOUNT_CALENDARS} />;
}

/** Options grouped under per-account headers, open — the calendar picker on multi-account devices. */
export const GroupedOpen: Story = {
    render: () => <GroupedSelect />,
    play: async ({ canvasElement }) => {
        await userEvent.click(within(canvasElement).getByRole('combobox', { name: 'Calendar' }));
        await within(document.body).findByText('dana@work.example.com');
    },
};
