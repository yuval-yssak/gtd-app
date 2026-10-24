import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { sampleCalendarRoutine, sampleRoutine } from '../../test-utils/storybookMocks';
import { PauseRoutineConfirmDialog } from './PauseRoutineConfirmDialog';

const meta = {
    title: 'Routines/PauseRoutineConfirmDialog',
    component: PauseRoutineConfirmDialog,
    args: { routine: sampleRoutine, onCancel: fn(), onConfirm: fn() },
} satisfies Meta<typeof PauseRoutineConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A next-action routine: future open items are trashed. */
export const NextActionRoutine: Story = {};

/** A calendar routine also caps its Google Calendar series. */
export const CalendarRoutine: Story = { args: { routine: sampleCalendarRoutine } };
