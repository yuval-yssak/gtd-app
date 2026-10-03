import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { DateField } from './DateField';
import { DatePickerPanel } from './DatePickerPopover';

const meta = {
    title: 'Components/DateField',
    component: DateField,
    parameters: { layout: 'centered' },
    tags: ['autodocs'],
    args: { label: 'Expected by', value: '', onChange: fn() },
} satisfies Meta<typeof DateField>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledDateField({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return <DateField label="Expected by" value={value} onChange={setValue} />;
}

function ControlledCaptionOnlyDateField({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return <DateField accessibleName="Tickler date" value={value} onChange={setValue} />;
}

/** Empty — only the calendar button shows; Clear appears once a date is set. */
export const Empty: Story = {
    render: () => <ControlledDateField initial="" />,
};

/** Filled — Clear and Pick side by side. */
export const Filled: Story = {
    render: () => <ControlledDateField initial="2026-10-15" />,
};

/** No floating label (the caller renders its own caption) — the buttons still get a name. */
export const CaptionOnly: Story = {
    render: () => <ControlledCaptionOnlyDateField initial="2026-10-15" />,
};

/** Disabled — no Clear, the Pick button is inert. */
export const Disabled: Story = {
    args: { value: '2026-10-15', disabled: true },
};

/** The popover body on its own, pinned to a fixed "today" so the quick picks are stable. */
export const PickerPanel: Story = {
    render: () => <DatePickerPanel value="2026-10-15" todayIso="2026-10-03" onPick={fn()} />,
};
