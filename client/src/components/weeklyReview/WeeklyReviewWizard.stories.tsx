import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { RouterDecorator } from '../../../.storybook/RouterDecorator';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { mockDb, sampleNextActionItem, samplePeople, sampleWorkContexts } from '../../test-utils/storybookMocks';
import type { StoredItem } from '../../types/MyDB';
import { buildStageQueue, type ReviewFlowState, type StageQueue, stageIndexOf } from './reviewFlowState';
import { WeeklyReviewWizard } from './WeeklyReviewWizard';

const nextActions: StoredItem[] = [
    sampleNextActionItem,
    { ...sampleNextActionItem, _id: 'item-na-2', title: 'Book flights for the offsite', rank: 'a1', peopleIds: [] },
    { ...sampleNextActionItem, _id: 'item-na-3', title: 'Renew the passport', rank: 'a2', peopleIds: [], workContextIds: ['ctx-3'] },
];

// Mid-walk through Next Actions: one item already decided (marked done, so no longer eligible)
// and three still pending — the strip reads "2 of 4" (the second entry is on screen).
const midNextActionsFlow: ReviewFlowState = {
    stageIndex: stageIndexOf('nextActions'),
    tickedInboxIds: [],
    queues: {
        nextActions: { ...buildStageQueue(nextActions.map((item) => item._id)), decisions: [{ itemId: 'item-na-done' }] },
    },
    skippedStageIds: [],
    startedTs: '2026-10-25T08:00:00.000Z',
};

/** The route owns the flow; this holds it in state so the wizard's functional updates apply. */
function WizardWithFlowState({ initialFlow }: { initialFlow: ReviewFlowState }) {
    const [flow, setFlow] = useState(initialFlow);
    return <WeeklyReviewWizard db={mockDb} flow={flow} onFlowChange={setFlow} />;
}

const meta = {
    title: 'Weekly Review/WeeklyReviewWizard',
    component: WizardWithFlowState,
    parameters: { layout: 'fullscreen' },
    decorators: [
        editorProvidersDecorator({
            items: nextActions,
            allItems: nextActions,
            people: samplePeople,
            workContexts: sampleWorkContexts,
            allPeople: samplePeople,
            allWorkContexts: sampleWorkContexts,
        }),
        RouterDecorator,
    ],
    args: { initialFlow: midNextActionsFlow },
} satisfies Meta<typeof WizardWithFlowState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Working a stage — the slim strip: stage title, stage counter + bar, and the review-wide stage dots. */
export const CollapsedStrip: Story = {
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(within(canvasElement).getByTestId('reviewHeaderStrip')).toBeVisible());
    },
};

/** The strip clicked — the full header with the stage timeline, guidance and Skip stage. */
export const ExpandedHeader: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.click(await within(canvasElement).findByTestId('reviewHeaderStrip'));
        await waitFor(() => expect(within(canvasElement).getByTestId('reviewStepper')).toBeVisible());
    },
};

const singleItemFlow = (queue: StageQueue): ReviewFlowState => ({ ...midNextActionsFlow, queues: { nextActions: queue } });

/** A one-item stage on its only card — numbered from 1, so the strip reads "1 of 1", never "0 of 1". */
export const SingleItemStage: Story = {
    args: { initialFlow: singleItemFlow(buildStageQueue([sampleNextActionItem._id])) },
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(within(canvasElement).getByTestId('reviewStageCounter')).toHaveTextContent('1 of 1'));
    },
};

/** The card's compact Position row — the walk follows the list's manual order, so the item can be raised or lowered from here. */
export const PositionRowOnCard: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await waitFor(() => expect(canvas.getByTestId('nextActionPositionRow')).toBeVisible());
        await expect(canvas.getByTestId('nextActionPositionBottom')).toBeEnabled();
    },
};

/** The row held while a structural edit is unsaved — a move could swap the card out and drop the edit. */
export const PositionRowLockedByUnsavedEdit: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(await within(await canvas.findByRole('group', { name: 'Energy' })).findByRole('button', { name: 'High' }));
        await waitFor(() => expect(canvas.getByTestId('nextActionPositionRow')).toHaveAttribute('data-locked', 'true'));
        await expect(canvas.getByTestId('nextActionPositionBottom')).toBeDisabled();
    },
};

/** The stage-end card after the only item — no ordinal (it is not an item), the bar full. */
export const StageEndCard: Story = {
    args: { initialFlow: singleItemFlow({ ...buildStageQueue([sampleNextActionItem._id]), cursor: 1 }) },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await waitFor(() => expect(canvas.getByTestId('stageEmptyCard')).toBeVisible());
        await expect(canvas.queryByTestId('reviewStageCounter')).toBeNull();
        await expect(canvas.getByRole('progressbar', { name: 'Stage progress' })).toHaveAttribute('aria-valuenow', '100');
    },
};
