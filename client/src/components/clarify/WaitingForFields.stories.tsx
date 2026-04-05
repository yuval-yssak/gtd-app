import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';
import { useState } from 'react';
import { emptyWaitingForState, filledWaitingForState, samplePeople } from '../../test-utils/storybookMocks';
import type { WaitingForFormState } from './types';
import { WaitingForFields } from './WaitingForFields';

const meta = {
    title: 'Components/WaitingForFields',
    component: WaitingForFields,
    parameters: { layout: 'centered' },
    tags: ['autodocs'],
    // Required by StoryObj type even when `render` overrides the component entirely.
    args: { value: emptyWaitingForState, onChange: fn(), people: [] },
} satisfies Meta<typeof WaitingForFields>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledWaitingForFields({ initial, people }: { initial: WaitingForFormState; people: (typeof samplePeople)[number][] }) {
    const [value, setValue] = useState<WaitingForFormState>(initial);
    return <WaitingForFields value={value} onChange={(patch) => setValue((prev) => ({ ...prev, ...patch }))} people={people} />;
}

/** No people in the system — the person selector shows an informational message. */
export const NoPeople: Story = {
    render: () => <ControlledWaitingForFields initial={emptyWaitingForState} people={[]} />,
};

/** People available but no fields filled yet. */
export const WithPeopleEmpty: Story = {
    render: () => <ControlledWaitingForFields initial={emptyWaitingForState} people={samplePeople} />,
};

/** Person selected with both dates filled in. */
export const WithPeopleFilled: Story = {
    render: () => <ControlledWaitingForFields initial={filledWaitingForState} people={samplePeople} />,
};
