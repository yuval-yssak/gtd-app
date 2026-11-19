import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ItemDetailsSummary } from './ItemDetailsSummary';

const meta = {
    title: 'Item Editor/ItemDetailsSummary',
    component: ItemDetailsSummary,
    parameters: { layout: 'padded' },
    args: { onEditRequested: fn(), facts: [] },
} satisfies Meta<typeof ItemDetailsSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A typical next action in the weekly review: its filled fields on one line. */
export const NextAction: Story = {
    args: {
        facts: [
            { label: 'Contexts', value: 'errands' },
            { label: 'People', value: 'Dana' },
            { label: 'Energy', value: 'Medium' },
            { label: 'Time', value: '20 min' },
        ],
    },
    play: async ({ args, canvasElement }) => {
        await userEvent.click(within(canvasElement).getByRole('button', { name: 'Edit details' }));
        await expect(args.onEditRequested).toHaveBeenCalled();
    },
};

/** Every next-action field filled, on a narrow card: facts wrap as whole label/value pairs. */
export const EveryFieldWrapping: Story = {
    args: {
        facts: [
            { label: 'Contexts', value: 'phone, office, anywhere' },
            { label: 'People', value: 'Dana, Omer' },
            { label: 'Energy', value: 'High' },
            { label: 'Time', value: '45 min' },
            { label: 'Priority', value: 'Urgent' },
            { label: 'Expected by', value: 'Nov 21, 2026' },
            { label: 'Hidden until', value: 'Nov 19, 2026' },
            { label: 'Account', value: 'work@example.com' },
        ],
    },
    decorators: [
        (Story) => (
            <div style={{ inlineSize: '24rem' }}>
                <Story />
            </div>
        ),
    ],
};

/** A calendar event: when it happens and how many guests. */
export const CalendarEvent: Story = {
    args: {
        facts: [
            { label: 'When', value: 'Thu, Nov 19 · 2:00 pm – 3:30 pm' },
            { label: 'Guests', value: '3 guests' },
        ],
    },
};

/** A next action with nothing set — says so instead of rendering an empty row. */
export const NothingSet: Story = {
    play: async ({ canvasElement }) => {
        await expect(within(canvasElement).getByText('No details set')).toBeVisible();
    },
};
