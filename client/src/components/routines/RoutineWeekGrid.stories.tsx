import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { sampleCalendarRoutine, sampleRoutine } from '../../test-utils/storybookMocks';
import type { StoredRoutine } from '../../types/MyDB';
import { RoutineWeekGrid } from './RoutineWeekGrid';

const meta = {
    title: 'Routines/RoutineWeekGrid',
    component: RoutineWeekGrid,
    parameters: { layout: 'padded' },
    args: { routines: [], onRoutineSelected: fn() },
} satisfies Meta<typeof RoutineWeekGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

const monthlyReview: StoredRoutine = { ...sampleRoutine, _id: 'routine-monthly', title: 'Monthly budget review', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' };

/** Nothing scheduled: seven empty day columns. */
export const Empty: Story = {};

/** Weekly rhythms fill their day columns; a timed calendar routine leads with its time. */
export const WeeklyRoutines: Story = {
    args: { routines: [sampleRoutine, sampleCalendarRoutine] },
};

/** Less frequent routines list below the grid with their schedule. */
export const WithLessFrequent: Story = {
    args: { routines: [sampleRoutine, sampleCalendarRoutine, monthlyReview] },
};
