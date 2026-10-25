import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { mockDb } from '../../test-utils/storybookMocks';
import type { StoredItem } from '../../types/MyDB';
import { NextActionPositionRow } from './NextActionPositionRow';

// Undated next actions share one rank section, so their order is the rank order below.
const undatedAction = (id: string, title: string, rank: string): StoredItem => ({
    _id: id,
    userId: 'user-1',
    status: 'nextAction',
    title,
    rank,
    createdTs: '2026-10-01T09:00:00.000Z',
    updatedTs: '2026-10-01T09:00:00.000Z',
});

const firstAction = undatedAction('na-1', 'Email the landlord about the lease', 'a0');
const secondAction = undatedAction('na-2', 'Draft the project proposal', 'a1');
const sectionItems = [
    firstAction,
    secondAction,
    undatedAction('na-3', 'Book flights for the offsite', 'a2'),
    undatedAction('na-4', 'Renew the passport', 'a3'),
];

const meta = {
    title: 'Components/NextActions/NextActionPositionRow',
    component: NextActionPositionRow,
    parameters: { layout: 'padded' },
    decorators: [editorProvidersDecorator({ items: sectionItems, allItems: sectionItems })],
    args: { db: mockDb, item: secondAction, onBeforeMove: fn().mockResolvedValue(undefined) },
} satisfies Meta<typeof NextActionPositionRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mid-section ("2 of 4") — every move is available. */
export const MidSection: Story = {};

/** Already first — Top and Up are disabled. */
export const AtTop: Story = {
    args: { item: firstAction },
};

/** Alone in its section — nothing to move past, every control is disabled. */
export const AloneInSection: Story = {
    decorators: [editorProvidersDecorator({ items: [secondAction], allItems: [secondAction] })],
};

/** "Move to…" pressed — the bottom sheet opens over the row. */
export const MoveToSheetOpen: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.click(await within(canvasElement).findByTestId('nextActionPositionMoveTo'));
        await waitFor(() => expect(within(document.body).getByTestId('nextActionMoveToSheet')).toBeVisible());
    },
};
