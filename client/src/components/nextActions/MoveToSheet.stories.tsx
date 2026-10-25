import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { StoredItem } from '../../types/MyDB';
import { MoveToSheet } from './MoveToSheet';

const sectionRow = (id: string, title: string, rank: string): StoredItem => ({
    _id: id,
    userId: 'user-1',
    status: 'nextAction',
    title,
    rank,
    createdTs: '2026-10-01T09:00:00.000Z',
    updatedTs: '2026-10-01T09:00:00.000Z',
});

const sectionItems = [
    sectionRow('na-1', 'Email the landlord about the lease', 'a0'),
    sectionRow('na-2', 'Draft the project proposal', 'a1'),
    sectionRow('na-3', 'Book flights for the offsite', 'a2'),
    sectionRow('na-4', 'Renew the passport', 'a3'),
];
const [, movingItem] = sectionItems;

const openPicker = async () => {
    const sheet = await within(document.body).findByTestId('nextActionMoveToSheet');
    await userEvent.click(within(sheet).getByTestId('nextActionMoveToAbove'));
    await waitFor(() => expect(within(sheet).getByTestId('nextActionMoveToSearch')).toBeVisible());
    return sheet;
};

const meta = {
    title: 'Components/NextActions/MoveToSheet',
    component: MoveToSheet,
    args: { item: movingItem ?? null, sectionItems, sectionLabel: 'Today', onClose: fn(), onMove: fn() },
} satisfies Meta<typeof MoveToSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Opened on an item — the four placements plus Cancel. */
export const Actions: Story = {
    play: async () => {
        await waitFor(() => expect(within(document.body).getByTestId('nextActionMoveToTop')).toBeVisible());
    },
};

/** The item is alone in its section — every placement is disabled. */
export const AloneInSection: Story = {
    args: { sectionItems: movingItem ? [movingItem] : [] },
    play: async () => {
        await waitFor(() => expect(within(document.body).getByTestId('nextActionMoveToTop')).toBeDisabled());
    },
};

/** "Above…" picked — the searchable list of the section's other rows. */
export const Picker: Story = {
    play: async () => {
        await openPicker();
    },
};

/** The picker's search matches nothing. */
export const NoMatches: Story = {
    play: async () => {
        const sheet = await openPicker();
        await userEvent.type(within(sheet).getByTestId('nextActionMoveToSearch'), 'zzz');
        await waitFor(() => expect(within(sheet).getByText('No items match.')).toBeVisible());
    },
};
