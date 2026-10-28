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

// Generated occurrences carry the routine template's notes — the card's editor shows the occurrence's.
const agendaNotes = 'Agenda:\n\n1. **Blockers** first\n2. Yesterday / today\n3. Parking lot';
const occurrencesWithNotes = upcomingOccurrences.map((item) => ({ ...item, notes: agendaNotes }));

const nav = {
    recordDecision: fn(),
    liveNavProps: (isSaving: boolean) => ({
        onBack: fn(),
        backDisabled: true,
        backLabel: 'Revisit previous decision',
        forward: { onForward: fn(), disabled: isSaving, label: 'Skip for now' },
    }),
    blockedNavProps: (testId: string) => ({
        onBack: fn(),
        backDisabled: true,
        backLabel: 'Revisit previous decision',
        forward: { onForward: fn(), label: 'Skip blocked item', testId },
    }),
    armExplicitSave: fn(),
    markSaveCommitted: fn(),
    closeAsDecisionOrSkip: fn(),
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
        onOccurrenceReviewed: fn(),
    },
} satisfies Meta<typeof RoutineReviewCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A live series collapsed to one card — the review editor on its first open occurrence, with Pause / Edit series / Done / Looks good. */
export const Upcoming: Story = {};

/** The first open occurrence already passed — the editor opens on IT (not the next upcoming one), and Done completes it. */
export const Overdue: Story = {
    decorators: [withOccurrences(overdueOccurrences)],
};

/** The occurrence carries Markdown notes — shown in the editor's notes preview, as on a one-off. */
export const WithNotes: Story = {
    decorators: [withOccurrences(occurrencesWithNotes)],
};

/** A paused routine — no Pause button. */
export const Paused: Story = {
    args: { routine: { ...sampleCalendarRoutine, active: false } },
};

/** The occurrence edited in place — the primary reads "Save & next", and the series actions lock over the unsaved edit. */
export const OccurrenceEdited: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.type(await canvas.findByRole('textbox', { name: 'Title' }), ' (moved)');
        await waitFor(() => expect(canvas.getByTestId('routineCardLooksGood')).toHaveTextContent('Save & next'));
        await waitFor(() => expect(canvas.getByTestId('routineCardEdit')).toBeDisabled());
    },
};

/** No open occurrence left on this device — the banner, a note, and the walk's own controls. */
export const NoOpenOccurrence: Story = {
    decorators: [withOccurrences([])],
};

/** Edit series pressed — the routine editor replaces the occurrence editor inside the card and stage travel locks. */
export const EditorOpen: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.click(await within(canvasElement).findByTestId('routineCardEdit'));
        await within(canvasElement).findByTestId('routineEditorSaveButton');
    },
};

/** Pause pressed — the confirmation dialog over the card. */
export const PauseConfirm: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.click(await within(canvasElement).findByTestId('routineCardPause'));
        await within(document.body).findByRole('alertdialog');
    },
};
