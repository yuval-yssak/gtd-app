import type { Meta, StoryObj } from '@storybook/react';
import dayjs from 'dayjs';
import { expect, fn, userEvent, within } from 'storybook/test';
import { sampleCalendarRoutine } from '../../test-utils/storybookMocks';
import type { StoredItem } from '../../types/MyDB';
import { OverdueOccurrencesDialog } from './OverdueOccurrencesDialog';

// Relative to "now" so the dates read as past whenever the story is rendered.
const overdueOccurrence = (daysAgo: number): StoredItem => {
    const start = dayjs().startOf('day').subtract(daysAgo, 'day').hour(9);
    return {
        _id: `occ-${daysAgo}`,
        userId: 'user-1',
        status: 'calendar',
        title: sampleCalendarRoutine.title,
        routineId: sampleCalendarRoutine._id,
        timeStart: start.format('YYYY-MM-DDTHH:mm:ss'),
        timeEnd: start.add(15, 'minute').format('YYYY-MM-DDTHH:mm:ss'),
        createdTs: '2026-10-01T09:00:00.000Z',
        updatedTs: '2026-10-01T09:00:00.000Z',
    };
};

const meta = {
    title: 'Weekly Review/OverdueOccurrencesDialog',
    component: OverdueOccurrencesDialog,
    args: {
        routine: sampleCalendarRoutine,
        open: true,
        overdue: [overdueOccurrence(3), overdueOccurrence(2), overdueOccurrence(1)],
        onChoose: fn(),
        onCancel: fn(),
    },
} satisfies Meta<typeof OverdueOccurrencesDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A routine kept only in Done: three overdue occurrences, with no word about Google Calendar. */
export const ThreeOverdue: Story = {
    play: async ({ args }) => {
        const dialog = within(document.body);
        await userEvent.click(await dialog.findByTestId('overdueOccurrencesRestMissed'));
        await expect(args.onChoose).toHaveBeenCalledWith('thisDoneRestMissed');
    },
};

/** A routine linked to Google Calendar: the dialog says missed occurrences stay there. */
export const LinkedToGoogle: Story = {
    args: { routine: { ...sampleCalendarRoutine, calendarEventId: 'gcal-master-1' } },
};

/** A long backlog: the dates are capped with a count of the rest. */
export const LongBacklog: Story = {
    args: { overdue: [9, 8, 7, 6, 5, 4, 3, 2, 1].map(overdueOccurrence) },
};
