import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ReviewOpenElsewhereCard } from './ReviewOpenElsewhereCard';

const meta = {
    title: 'Weekly Review/ReviewOpenElsewhereCard',
    component: ReviewOpenElsewhereCard,
    parameters: { layout: 'fullscreen' },
    args: { onContinueHere: fn() },
} satisfies Meta<typeof ReviewOpenElsewhereCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Another tab runs the review — this one offers to take it over. */
export const OpenElsewhere: Story = {};

/** "Continue here" focused — the keyboard path to taking the review over. */
export const ContinueHereFocused: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.tab();
        await expect(await canvas.findByTestId('continueReviewHereButton')).toHaveFocus();
    },
};
