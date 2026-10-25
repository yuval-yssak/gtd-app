import type { Meta, StoryObj } from '@storybook/react';
import type { IDBPDatabase } from 'idb';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { mockDb } from '../../test-utils/storybookMocks';
import type { MyDB, StoredAccount, StoredQuickCaptureDraft } from '../../types/MyDB';
import { QuickCaptureFab } from './QuickCaptureFab';

const account: StoredAccount = { id: 'user-1', email: 'me@example.com', name: 'Me', image: null, provider: 'google', addedAt: 1 };

const leftoverDraft: StoredQuickCaptureDraft = {
    key: `quickCapture:${account.id}`,
    kind: 'quickCapture',
    userId: account.id,
    title: 'Plan the team offsite',
    notes: '- Pick a date in **November**\n- Shortlist three venues\n- Ask Dana about the budget',
    updatedTs: '2026-10-24T18:00:00.000Z',
};

// mockDb with one device-local draft row: reopening the dialog restores leftover text through
// the same IDB read the app does, so the notes panel opens on its own.
const dbWithDraft = { ...mockDb, get: async () => leftoverDraft } as unknown as IDBPDatabase<MyDB>;

const openDialog: Story['play'] = async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByTestId('quickCaptureFab'));
    await waitFor(() => expect(within(document.body).getByTestId('quickCaptureDialog')).toBeVisible());
};

const meta = {
    title: 'Components/QuickCaptureFab',
    component: QuickCaptureFab,
    decorators: [editorProvidersDecorator({ account })],
    args: { db: mockDb },
} satisfies Meta<typeof QuickCaptureFab>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The floating "add to inbox" button, dialog closed. */
export const Closed: Story = {};

/** Opened with nothing typed — Capture stays disabled until there is a title. */
export const DialogOpen: Story = {
    play: openDialog,
};

/** Reopened over a leftover draft — the title and its Markdown note are restored, notes panel open. */
export const DialogOpenWithNotes: Story = {
    args: { db: dbWithDraft },
    play: async (context) => {
        await openDialog(context);
        await waitFor(() => expect(within(document.body).getByTestId('quickCaptureNotes')).toBeVisible());
    },
};
