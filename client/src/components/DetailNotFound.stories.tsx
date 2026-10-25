import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { DetailNotFound } from './DetailNotFound';

const meta = {
    title: 'Components/DetailNotFound',
    component: DetailNotFound,
    parameters: { layout: 'padded' },
    args: { onAction: fn() },
} satisfies Meta<typeof DetailNotFound>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A deep link to an entity that no longer exists. */
export const PersonGone: Story = {
    args: { message: 'Person not found — they may have been deleted.', actionLabel: 'Back to People' },
};
