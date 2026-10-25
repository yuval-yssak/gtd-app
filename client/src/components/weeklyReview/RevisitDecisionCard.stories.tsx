import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
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

/** A collapsed calendar-routine entry — a read-only summary with its schedule. */
export const RoutineEntry: Story = {
    args: { decision: { itemId: routineEntryId(sampleCalendarRoutine._id), undo: {} } },
};

/** The decided item was hard-deleted since — a notice, with the arrows still in the bar. */
export const MissingItem: Story = {
    args: { decision: { itemId: 'item-gone' } },
};
