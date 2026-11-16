import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { FreshnessBadge } from './FreshnessBadge';

const meta = {
    title: 'Components/FreshnessBadge',
    component: FreshnessBadge,
    parameters: { layout: 'centered' },
    tags: ['autodocs'],
} satisfies Meta<typeof FreshnessBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The device copy has not been checked with the server yet (lie-fi, offline, or the first pull still running). */
export const NotVerified: Story = {
    args: { freshness: 'unverified' },
    play: async ({ canvasElement }) => {
        const badge = await within(canvasElement).findByTestId('freshnessBadge');
        await expect(badge).toHaveTextContent('Not verified');
    },
};

/** A local change is queued and has not reached the server. */
export const NotSynced: Story = {
    args: { freshness: 'unsynced' },
    play: async ({ canvasElement }) => {
        const badge = await within(canvasElement).findByTestId('freshnessBadge');
        await expect(badge).toHaveTextContent('Not synced');
    },
};

/** Checked with the server and nothing pending — the badge renders nothing. */
export const Current: Story = {
    args: { freshness: 'current' },
    play: async ({ canvasElement }) => {
        await expect(within(canvasElement).queryByTestId('freshnessBadge')).toBeNull();
    },
};
