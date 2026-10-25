import type { Meta, StoryObj } from '@storybook/react';
import { RouterDecorator } from '../../../.storybook/RouterDecorator';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { sampleCalendarItem, sampleInboxItem, sampleNextActionItem, sampleNextActionWithNotes, sampleWaitingForItem } from '../../test-utils/storybookMocks';
import type { StoredAccount } from '../../types/MyDB';
import { SearchResultsList } from './SearchResultsList';

const results = [sampleInboxItem, sampleNextActionItem, sampleNextActionWithNotes, sampleCalendarItem, sampleWaitingForItem];

const twoAccounts: StoredAccount[] = [
    { id: 'user-1', email: 'me@example.com', name: 'Me', image: null, provider: 'google', addedAt: 1 },
    { id: 'user-2', email: 'me@work.example.com', name: 'Me at work', image: null, provider: 'github', addedAt: 2 },
];

const meta = {
    title: 'Search/SearchResultsList',
    component: SearchResultsList,
    parameters: { layout: 'padded' },
    decorators: [editorProvidersDecorator(), RouterDecorator],
    args: { items: results, view: 'grouped' },
} satisfies Meta<typeof SearchResultsList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Grouped by status — one headed, counted section per status. */
export const Grouped: Story = {};

/** One flat list, each row carrying its status chip. */
export const FlatWithStatusChips: Story = {
    args: { view: 'flatChip' },
};

/** One flat list, titles and update times only. */
export const FlatMinimal: Story = {
    args: { view: 'flatMinimal' },
};

/** Two signed-in accounts — every row adds its account chip. */
export const MultiAccount: Story = {
    decorators: [editorProvidersDecorator({ loggedInAccounts: twoAccounts, loggedInUserIds: twoAccounts.map((account) => account.id) })],
    args: { items: [...results, { ...sampleNextActionItem, _id: 'item-na-work', userId: 'user-2', title: 'Prepare the sprint demo' }] },
};

/** Nothing matched. */
export const NoResults: Story = {
    args: { items: [] },
};
