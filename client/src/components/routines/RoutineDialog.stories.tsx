import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';
import { mockDb, sampleCalendarRoutine, samplePeople, sampleRoutine, sampleWorkContexts } from '../../test-utils/storybookMocks';
import { RoutineDialog } from './RoutineDialog';

const meta = {
    title: 'Components/RoutineDialog',
    component: RoutineDialog,
    parameters: { layout: 'fullscreen' },
    tags: ['autodocs'],
    args: {
        db: mockDb,
        userId: 'user-1',
        workContexts: sampleWorkContexts,
        people: samplePeople,
        onClose: fn(),
        onSaved: fn().mockResolvedValue(undefined),
    },
} satisfies Meta<typeof RoutineDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Create mode for a nextAction routine — no existing routine passed. */
export const CreateNextAction: Story = {};

/** Create mode for a calendar routine — pre-selects the Calendar toggle via a minimal routine stub. */
export const CreateCalendar: Story = {
    args: {
        routine: { ...sampleCalendarRoutine },
    },
};

/** Edit an existing nextAction routine — form is pre-populated. */
export const EditExistingNextAction: Story = {
    args: { routine: sampleRoutine },
};

/** Edit an existing calendar routine. */
export const EditExistingCalendar: Story = {
    args: { routine: sampleCalendarRoutine },
};

/** Create mode with no people or work contexts — context/people selectors render as empty. */
export const NoPeopleOrContexts: Story = {
    args: {
        workContexts: [],
        people: [],
    },
};
