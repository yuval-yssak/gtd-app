import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { sampleCalendarItem } from '../test-utils/storybookMocks';
import { FutureDoneConfirmDialog } from './FutureDoneConfirmDialog';

const meta = {
    title: 'Components/FutureDoneConfirmDialog',
    component: FutureDoneConfirmDialog,
    args: {
        open: true,
        item: { ...sampleCalendarItem, timeStart: '2026-11-03T09:30:00', timeEnd: '2026-11-03T10:00:00' },
        onCancel: fn(),
        onConfirm: fn(),
    },
} satisfies Meta<typeof FutureDoneConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A timed event on a later day: the date line carries its start time. */
export const TimedEvent: Story = {};

/** An all-day event: the date line names the day only. */
export const AllDayEvent: Story = { args: { item: { ...sampleCalendarItem, allDay: true, timeStart: '2026-11-03', timeEnd: '2026-11-04' } } };
