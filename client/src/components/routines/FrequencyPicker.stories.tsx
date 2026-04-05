import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';
import { useState } from 'react';
import { FrequencyPicker } from './FrequencyPicker';

const meta = {
    title: 'Components/FrequencyPicker',
    component: FrequencyPicker,
    parameters: { layout: 'centered' },
    tags: ['autodocs'],
    // Required by StoryObj type even when `render` overrides the component entirely.
    args: { value: 'FREQ=DAILY;INTERVAL=1', onChange: fn() },
} satisfies Meta<typeof FrequencyPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Wrapper that holds local state so the picker is interactive in the canvas. */
function ControlledFrequencyPicker({ initialRrule }: { initialRrule: string }) {
    const [rrule, setRrule] = useState(initialRrule);
    return <FrequencyPicker value={rrule} onChange={setRrule} />;
}

/** Every day. */
export const Daily: Story = {
    render: () => <ControlledFrequencyPicker initialRrule="FREQ=DAILY;INTERVAL=1" />,
};

/** Every 3 days. */
export const EveryThreeDays: Story = {
    render: () => <ControlledFrequencyPicker initialRrule="FREQ=DAILY;INTERVAL=3" />,
};

/** Weekly on Monday, Wednesday, and Friday. */
export const WeeklyOnMonWedFri: Story = {
    render: () => <ControlledFrequencyPicker initialRrule="FREQ=WEEKLY;BYDAY=MO,WE,FR" />,
};

/** Bi-weekly on Monday. */
export const BiWeekly: Story = {
    render: () => <ControlledFrequencyPicker initialRrule="FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" />,
};

/** Monthly on the 15th. */
export const MonthlyByDayOfMonth: Story = {
    render: () => <ControlledFrequencyPicker initialRrule="FREQ=MONTHLY;BYMONTHDAY=15" />,
};

/** Yearly. */
export const Yearly: Story = {
    render: () => <ControlledFrequencyPicker initialRrule="FREQ=YEARLY" />,
};
