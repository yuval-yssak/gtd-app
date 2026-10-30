// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { WorkContextEditorBody } from '../components/workContexts/WorkContextEditorBody';
import { AppDataContext } from '../contexts/AppDataProvider';
import { waitForPendingFlush } from '../db/syncHelpers';
import { getCurrentUndo, resetUndoStore, runCurrentUndo } from '../lib/undoStore';
import { buildMockAppData } from '../test-utils/storybookAppData';
import type { MyDB, StoredWorkContext } from '../types/MyDB';
import { openTestDB } from './openTestDB';

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(async () => {
    cleanup();
    await waitForPendingFlush().catch(() => {});
    resetUndoStore();
    db.close();
    vi.clearAllMocks();
});

async function seedWorkContext(): Promise<StoredWorkContext> {
    const now = dayjs().toISOString();
    const workContext: StoredWorkContext = { _id: 'wc-1', userId: 'user-1', name: '@phone', createdTs: now, updatedTs: now };
    await db.put('workContexts', workContext);
    return workContext;
}

/** Renders the page-chrome body over a context the provider still lists, and types a rename into it. */
function renderWithPendingRename(workContext: StoredWorkContext, newName: string) {
    const appData = buildMockAppData({ workContexts: [workContext], allWorkContexts: [workContext] });
    const view = render(
        <AppDataContext.Provider value={appData}>
            <WorkContextEditorBody db={db} workContext={workContext} chrome="page" onClose={() => {}} />
        </AppDataContext.Provider>,
    );
    const nameInput = screen.getByTestId('workContextEditName').querySelector('input');
    if (!nameInput) throw new Error('expected the name input');
    fireEvent.change(nameInput, { target: { value: newName } });
    return view;
}

const settleUnmountFlush = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('WorkContextEditorBody unmount flush', () => {
    it('saves a rename still in the debounce window when the editor unmounts', async () => {
        const workContext = await seedWorkContext();
        const { unmount } = renderWithPendingRename(workContext, '@calls');

        unmount();
        await vi.waitFor(async () => expect((await db.get('workContexts', workContext._id))?.name).toBe('@calls'));
    });

    // The page host unmounts the body in the same commit that drops the row (it swaps to the
    // not-found branch), so the body never re-renders after a remote delete — the commit must
    // consult IDB, not a value captured during render.
    it('does not resurrect a context deleted underneath it before the unmount flush', async () => {
        const workContext = await seedWorkContext();
        const { unmount } = renderWithPendingRename(workContext, '@calls');

        await db.delete('workContexts', workContext._id);
        unmount();
        await settleUnmountFlush();

        expect(await db.get('workContexts', workContext._id)).toBeUndefined();
    });

    // The "Context saved — UNDO" snackbar outlives the editor (the undo store is global), so UNDO
    // can fire after a remote delete removed the row — it must not write the row back either.
    it('an UNDO pressed after the context was deleted does not resurrect it', async () => {
        const workContext = await seedWorkContext();
        const { unmount } = renderWithPendingRename(workContext, '@calls');
        unmount();
        await vi.waitFor(() => expect(getCurrentUndo()).not.toBeNull());

        await db.delete('workContexts', workContext._id);
        await runCurrentUndo();

        expect(await db.get('workContexts', workContext._id)).toBeUndefined();
    });
});
