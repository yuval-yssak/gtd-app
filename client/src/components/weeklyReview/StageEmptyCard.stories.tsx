import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { StageEmptyCard } from './StageEmptyCard';

const meta = {
    title: 'Weekly Review/StageEmptyCard',
    component: StageEmptyCard,
    parameters: { layout: 'fullscreen' },
    args: {
        title: 'All reviewed!',
        onContinue: fn(),
        travel: { onPrevStage: fn(), onNextStage: fn(), prevDisabled: false, nextDisabled: false },
    },
} satisfies Meta<typeof StageEmptyCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The stage's queue is exhausted — Continue plus the back arrow into this stage's decisions. */
export const AllReviewed: Story = {
    args: { onBack: fn() },
};

/** The stage had nothing to review — no decisions to go back to, so only Continue. */
export const NothingToReview: Story = {
    args: { title: 'Nothing waiting on anyone' },
};

/** The last stage — the forward travel arrow is disabled; finishing goes through Continue. */
export const LastStage: Story = {
    args: { onBack: fn(), travel: { onPrevStage: fn(), onNextStage: fn(), prevDisabled: false, nextDisabled: true } },
};
