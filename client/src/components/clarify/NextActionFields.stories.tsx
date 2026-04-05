import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { emptyNextActionState, filledNextActionState, samplePeople, sampleWorkContexts } from '../../test-utils/storybookMocks';
import { NextActionFields } from './NextActionFields';
import type { NextActionFormState } from './types';

const meta = {
    title: 'Components/NextActionFields',
    component: NextActionFields,
    parameters: { layout: 'centered' },
    tags: ['autodocs'],
    // Required by StoryObj type even when `render` overrides the component entirely.
    args: { value: emptyNextActionState, onChange: fn(), workContexts: [], people: [] },
} satisfies Meta<typeof NextActionFields>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledNextActionFields({
    initial,
    workContexts = [],
    people = [],
}: {
    initial: NextActionFormState;
    workContexts?: (typeof sampleWorkContexts)[number][];
    people?: (typeof samplePeople)[number][];
}) {
    const [value, setValue] = useState<NextActionFormState>(initial);
    return <NextActionFields value={value} onChange={(patch) => setValue((prev) => ({ ...prev, ...patch }))} workContexts={workContexts} people={people} />;
}

/** All fields empty, no people or contexts configured. */
export const AllEmpty: Story = {
    render: () => <ControlledNextActionFields initial={emptyNextActionState} />,
};

/** Work contexts available but no people. */
export const WithContextsOnly: Story = {
    render: () => <ControlledNextActionFields initial={{ ...emptyNextActionState, workContextIds: ['ctx-1'] }} workContexts={sampleWorkContexts} />,
};

/** People available but no work contexts. */
export const WithPeopleOnly: Story = {
    render: () => <ControlledNextActionFields initial={{ ...emptyNextActionState, peopleIds: ['person-1'] }} people={samplePeople} />,
};

/** All metadata fields filled in — energy high, time 45 min, urgent + focus, dates set. */
export const FullyFilled: Story = {
    render: () => <ControlledNextActionFields initial={filledNextActionState} workContexts={sampleWorkContexts} people={samplePeople} />,
};

/** Low energy, no other fields — illustrates the energy button group in its low state. */
export const LowEnergy: Story = {
    render: () => <ControlledNextActionFields initial={{ ...emptyNextActionState, energy: 'low' }} workContexts={sampleWorkContexts} />,
};

/** Tickler date set — the ignoreBefore field visible with a future date. */
export const WithTickler: Story = {
    render: () => (
        <ControlledNextActionFields initial={{ ...emptyNextActionState, ignoreBefore: '2024-05-01' }} workContexts={sampleWorkContexts} people={samplePeople} />
    ),
};
