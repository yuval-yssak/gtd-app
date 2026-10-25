import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { CompletionCelebration } from './CompletionCelebration';
import { buildStageQueue, REVIEW_STAGES, type ReviewFlowState, type StageQueue } from './reviewFlowState';

/** A finished stage queue holding `count` decisions. */
const decidedQueue = (count: number): StageQueue => ({
    ...buildStageQueue([]),
    decisions: Array.from({ length: count }, (_, index) => ({ itemId: `item-${index}` })),
});

const finishedFlow: ReviewFlowState = {
    stageIndex: REVIEW_STAGES.length,
    tickedInboxIds: [],
    queues: { clarify: decidedQueue(4), calendar: decidedQueue(2), nextActions: decidedQueue(7) },
    skippedStageIds: ['somedayMaybe'],
    startedTs: '2026-10-25T08:00:00.000Z',
};

const meta = {
    title: 'Weekly Review/CompletionCelebration',
    component: CompletionCelebration,
    parameters: { layout: 'fullscreen' },
    args: { flow: finishedFlow, onFinish: fn() },
} satisfies Meta<typeof CompletionCelebration>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The payoff with per-stage stats — reviewed counts, plus the stage skipped wholesale. */
export const WithStats: Story = {};

/** Every stage was empty — the message and Done, no stats block. */
export const NothingProcessed: Story = {
    args: { flow: { ...finishedFlow, queues: {}, skippedStageIds: [] } },
};
