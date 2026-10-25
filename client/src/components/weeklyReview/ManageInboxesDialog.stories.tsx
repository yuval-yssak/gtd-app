import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { mockDb } from '../../test-utils/storybookMocks';
import type { StoredAccount, StoredReviewInbox } from '../../types/MyDB';
import { ManageInboxesDialog } from './ManageInboxesDialog';

const account: StoredAccount = { id: 'user-1', email: 'me@example.com', name: 'Me', image: null, provider: 'google', addedAt: 1 };

const reviewInbox = (id: string, name: string, order: number): StoredReviewInbox => ({
    _id: id,
    userId: account.id,
    name,
    order,
    createdTs: '2026-09-01T09:00:00.000Z',
    updatedTs: '2026-09-01T09:00:00.000Z',
});

const inboxes = [reviewInbox('ri-1', 'Email', 0), reviewInbox('ri-2', 'Paper tray', 1), reviewInbox('ri-3', 'WhatsApp starred', 2)];

const meta = {
    title: 'Weekly Review/ManageInboxesDialog',
    component: ManageInboxesDialog,
    decorators: [editorProvidersDecorator({ account, allReviewInboxes: inboxes, reviewInboxes: inboxes })],
    args: { db: mockDb, onClose: fn() },
} satisfies Meta<typeof ManageInboxesDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three buckets — rename inline, reorder (first can't move up, last can't move down), remove. */
export const WithInboxes: Story = {};

/** No buckets yet — only the add row. */
export const Empty: Story = {
    decorators: [editorProvidersDecorator({ account })],
};
