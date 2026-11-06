import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, within } from 'storybook/test';
import { RouterDecorator } from '../../../.storybook/RouterDecorator';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { mockDb, sampleCalendarRoutine, sampleNextActionItem, samplePeople, sampleWorkContexts } from '../../test-utils/storybookMocks';
import { RevisitDecisionCard } from './RevisitDecisionCard';
import { routineEntryId } from './reviewFlowState';

const meta = {
    title: 'Weekly Review/RevisitDecisionCard',
    component: RevisitDecisionCard,
    parameters: { layout: 'fullscreen' },
    decorators: [
        editorProvidersDecorator({
            allItems: [sampleNextActionItem],
            items: [sampleNextActionItem],
            routines: [sampleCalendarRoutine],
            allRoutines: [sampleCalendarRoutine],
            people: samplePeople,
            workContexts: sampleWorkContexts,
            allPeople: samplePeople,
            allWorkContexts: sampleWorkContexts,
        }),
        RouterDecorator,
    ],
    args: {
        decision: { itemId: sampleNextActionItem._id, undo: { snapshot: sampleNextActionItem } },
        db: mockDb,
        position: { index: 2, total: 3 },
        canGoBack: true,
        onGoBack: fn(),
        onGoForward: fn(),
        onUndoDecision: fn(),
        isUndoing: false,
        onExit: fn(),
        travel: { onPrevStage: fn(), onNextStage: fn(), prevDisabled: false, nextDisabled: false },
        hasPositionRow: true,
    },
} satisfies Meta<typeof RevisitDecisionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A reversible past decision — the full editor on the item, with "Undo decision" enabled. */
export const Reversible: Story = {};

/** A decision that recorded no undo (e.g. a routine-generated item) — Undo stays visible but disabled. */
export const NotReversible: Story = {
    args: { decision: { itemId: sampleNextActionItem._id } },
};

/** The oldest decision — the back arrow has nowhere further to go. */
export const OldestDecision: Story = {
    args: { position: { index: 1, total: 3 }, canGoBack: false },
};

/** An undo is in flight — the Undo button is disabled until it lands. */
export const Undoing: Story = {
    args: { isUndoing: true },
};

/** A collapsed recurring event with no occurrence left on this device — a read-only summary with its schedule. */
export const RoutineEntryWithoutOccurrence: Story = {
    args: { decision: { itemId: routineEntryId(sampleCalendarRoutine._id), undo: {} } },
};

/** The occurrence a recurring-event decision was made over — completed by that decision. */
const decidedOccurrence = {
    ...sampleNextActionItem,
    _id: 'item-standup-occ',
    title: sampleCalendarRoutine.title,
    status: 'done' as const,
    routineId: sampleCalendarRoutine._id,
    timeStart: '2026-11-05T09:00:00',
    timeEnd: '2026-11-05T09:15:00',
};
const routineOccurrenceDecorator = editorProvidersDecorator({
    allItems: [decidedOccurrence],
    items: [decidedOccurrence],
    routines: [sampleCalendarRoutine],
    allRoutines: [sampleCalendarRoutine],
    people: samplePeople,
    workContexts: sampleWorkContexts,
    allPeople: samplePeople,
    allWorkContexts: sampleWorkContexts,
});

/**
 * A recurring event marked Done — the same full editor and routine banner as its live card, on
 * the occurrence it completed. Undo is disabled with the reason (Done advanced the series).
 */
export const RoutineEntryDone: Story = {
    args: { decision: { itemId: routineEntryId(sampleCalendarRoutine._id), occurrenceId: decidedOccurrence._id } },
    decorators: [routineOccurrenceDecorator],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByTestId('reviewRoutineBanner')).toBeVisible();
        await expect(await canvas.findByRole('textbox', { name: 'Title' })).toHaveValue(sampleCalendarRoutine.title);
        await expect(await canvas.findByTestId('revisitUndoDecision')).toBeDisabled();
    },
};

/** A recurring event that got "Looks good" — the same editor, and Undo is a bare requeue. */
export const RoutineEntryLooksGood: Story = {
    args: { decision: { itemId: routineEntryId(sampleCalendarRoutine._id), undo: {}, occurrenceId: decidedOccurrence._id } },
    decorators: [routineOccurrenceDecorator],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByTestId('revisitUndoDecision')).toBeEnabled();
    },
};

/** The decided item was hard-deleted since — a notice, with the arrows still in the bar. */
export const MissingItem: Story = {
    args: { decision: { itemId: 'item-gone' } },
};

/** A second item shares the revisited item's day, so its section has an order to change. */
const sameDayNeighbour = { ...sampleNextActionItem, _id: 'item-na-2', title: 'Book the venue', rank: 'a1' };
const sectionWithNeighbourDecorator = editorProvidersDecorator({
    allItems: [sampleNextActionItem, sameDayNeighbour],
    items: [sampleNextActionItem, sameDayNeighbour],
    people: samplePeople,
    workContexts: sampleWorkContexts,
    allPeople: samplePeople,
    allWorkContexts: sampleWorkContexts,
});

/** A revisited Next Action in a section of two — the compact Position row sits on the meta line, as on the live card. */
export const WithPositionRow: Story = {
    decorators: [sectionWithNeighbourDecorator],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByTestId('nextActionPositionRow')).toBeVisible();
    },
};

/** The tickler stage's revisit — no Position row even with a neighbour, since that stage walks by wake-up date. */
export const TicklerStageNoPositionRow: Story = {
    args: { hasPositionRow: false },
    decorators: [sectionWithNeighbourDecorator],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await canvas.findByTestId('revisitDecisionCard');
        await expect(canvas.queryByTestId('nextActionPositionRow')).toBeNull();
    },
};
