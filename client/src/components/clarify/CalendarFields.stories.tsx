import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { emptyCalendarState, filledCalendarState } from '../../test-utils/storybookMocks';
import { CalendarFields } from './CalendarFields';
import type { CalendarFormState } from './types';

const meta = {
    title: 'Components/CalendarFields',
    component: CalendarFields,
    parameters: { layout: 'centered' },
    tags: ['autodocs'],
    // Required by StoryObj type even when `render` overrides the component entirely.
    args: { value: emptyCalendarState, onChange: fn() },
} satisfies Meta<typeof CalendarFields>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledCalendarFields({ initial }: { initial: CalendarFormState }) {
    const [value, setValue] = useState<CalendarFormState>(initial);
    return <CalendarFields value={value} onChange={(patch) => setValue((prev) => ({ ...prev, ...patch }))} />;
}

/** All fields empty — initial state before the user fills anything in. */
export const Empty: Story = {
    render: () => <ControlledCalendarFields initial={emptyCalendarState} />,
};

/** Only the date is set — start and end times still empty. */
export const DateOnly: Story = {
    render: () => <ControlledCalendarFields initial={{ ...emptyCalendarState, date: '2024-04-15' }} />,
};

/** All-day single-day event — toggle on, end date empty. */
export const AllDaySingle: Story = {
    render: () => <ControlledCalendarFields initial={{ ...emptyCalendarState, date: '2024-04-15', allDay: true }} />,
};

/** All-day multi-day event — toggle on with explicit inclusive end date. */
export const AllDayMulti: Story = {
    render: () => <ControlledCalendarFields initial={{ ...emptyCalendarState, date: '2024-04-15', endDate: '2024-04-17', allDay: true }} />,
};

/** All fields filled — a complete calendar event time block. */
export const Filled: Story = {
    render: () => <ControlledCalendarFields initial={filledCalendarState} />,
};
