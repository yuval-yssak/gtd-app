import type { Meta, StoryObj } from '@storybook/react';
import dayjs from 'dayjs';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { RouterDecorator } from '../../../.storybook/RouterDecorator';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { mockDb, sampleCalendarRoutine, samplePeople, sampleWorkContexts } from '../../test-utils/storybookMocks';
import type { StoredItem } from '../../types/MyDB';
import { RoutineReviewCard } from './RoutineReviewCard';

// Routine-generated rows store a FLOATING wall-clock timeStart; relative to "now" so the card's
// upcoming / overdue reading holds whenever the story is rendered.
const floating = (daysFromToday: number, hour: number) => dayjs().startOf('day').add(daysFromToday, 'day').hour(hour).format('YYYY-MM-DDTHH:mm:ss');

const occurrence = (id: string, daysFromToday: number): StoredItem => ({
    _id: id,
    userId: 'user-1',
    status: 'calendar',
    title: sampleCalendarRoutine.title,
    routineId: sampleCalendarRoutine._id,
    timeStart: floating(daysFromToday, 9),
    timeEnd: dayjs(floating(daysFromToday, 9)).add(15, 'minute').format('YYYY-MM-DDTHH:mm:ss'),
    createdTs: '2026-10-01T09:00:00.000Z',
    updatedTs: '2026-10-01T09:00:00.000Z',
});

const upcomingOccurrences = [occurrence('occ-1', 1), occurrence('occ-2', 2), occurrence('occ-3', 3)];
const overdueOccurrences = [occurrence('occ-past', -2), ...upcomingOccurrences];

const routineWithNotes = {
    ...sampleCalendarRoutine,
    template: { notes: 'Agenda:\n\n1. **Blockers** first\n2. Yesterday / today\n3. Parking lot' },
};

const nav = {
    recordDecision: fn(),
    liveNavProps: (isSaving: boolean) => ({
        onBack: fn(),
        backDisabled: true,
        forward: { onForward: fn(), disabled: isSaving, label: 'Skip for now' },
    }),
};

const withOccurrences = (allItems: StoredItem[]) =>
    editorProvidersDecorator({
        allItems,
        items: allItems,
        allPeople: samplePeople,
        allWorkContexts: sampleWorkContexts,
        people: samplePeople,
        workContexts: sampleWorkContexts,
    });

const meta = {
    title: 'Weekly Review/RoutineReviewCard',
    component: RoutineReviewCard,
    parameters: { layout: 'fullscreen' },
    decorators: [withOccurrences(upcomingOccurrences), RouterDecorator],
    args: {
        routine: sampleCalendarRoutine,
        db: mockDb,
        nav,
        travel: { onPrevStage: fn(), onNextStage: fn(), prevDisabled: false, nextDisabled: false },
    },
} satisfies Meta<typeof RoutineReviewCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A live series collapsed to one card — led by its next occurrence, with Pause / Edit / Mark done / Looks good. */
export const Upcoming: Story = {};

/** The earliest open occurrence already passed — flagged Overdue, and Done reads "Mark overdue done". */
export const Overdue: Story = {
    decorators: [withOccurrences(overdueOccurrences)],
};

/** The routine template carries Markdown notes — rendered under the occurrence summary. */
export const WithNotes: Story = {
    args: { routine: routineWithNotes },
};

/** A paused routine — no Pause button. */
export const Paused: Story = {
    args: { routine: { ...sampleCalendarRoutine, active: false } },
};

/** Edit pressed — the routine editor opens inside the card and stage travel locks. */
export const EditorOpen: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.click(await within(canvasElement).findByTestId('routineCardEdit'));
        await waitFor(() => expect(within(canvasElement).queryByTestId('routineCardTitle')).not.toBeInTheDocument());
    },
};

/** Pause pressed — the confirmation dialog over the card. */
export const PauseConfirm: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.click(await within(canvasElement).findByTestId('routineCardPause'));
        await within(document.body).findByRole('alertdialog');
    },
};
