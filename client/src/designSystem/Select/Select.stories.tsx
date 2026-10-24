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
