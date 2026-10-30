// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { PersonEditorBody } from '../components/people/PersonEditorBody';
import { AppDataContext } from '../contexts/AppDataProvider';
import { waitForPendingFlush } from '../db/syncHelpers';
import { getCurrentUndo, resetUndoStore, runCurrentUndo } from '../lib/undoStore';
import { buildMockAppData } from '../test-utils/storybookAppData';
import type { MyDB, StoredPerson } from '../types/MyDB';
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

async function seedPerson(): Promise<StoredPerson> {
    const now = dayjs().toISOString();
    const person: StoredPerson = { _id: 'person-1', userId: 'user-1', name: 'Dana', email: 'dana@example.com', createdTs: now, updatedTs: now };
    await db.put('people', person);
    return person;
}

/** Renders the page-chrome body over a person the provider still lists, and types a rename into it. */
function renderWithPendingRename(person: StoredPerson, newName: string) {
    const appData = buildMockAppData({ people: [person], allPeople: [person] });
    const view = render(
        <AppDataContext.Provider value={appData}>
            <PersonEditorBody db={db} person={person} chrome="page" onClose={() => {}} />
        </AppDataContext.Provider>,
    );
    const nameInput = screen.getByTestId('personEditName').querySelector('input');
    if (!nameInput) throw new Error('expected the name input');
    fireEvent.change(nameInput, { target: { value: newName } });
    return view;
}

const settleUnmountFlush = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('PersonEditorBody unmount flush', () => {
    it('saves an edit still in the debounce window when the editor unmounts, keeping the other fields', async () => {
        const person = await seedPerson();
        const { unmount } = renderWithPendingRename(person, 'Dana Levi');

        unmount();
        await vi.waitFor(async () => expect((await db.get('people', person._id))?.name).toBe('Dana Levi'));
        expect((await db.get('people', person._id))?.email).toBe('dana@example.com');
    });

    // The /person page unmounts the body in the same commit that drops the row (it swaps to the
    // not-found branch), so the body never re-renders after a remote delete — the commit must
    // consult IDB, not a value captured during render.
    it('does not resurrect a person deleted underneath it before the unmount flush', async () => {
        const person = await seedPerson();
        const { unmount } = renderWithPendingRename(person, 'Dana Levi');

        await db.delete('people', person._id);
        unmount();
        await settleUnmountFlush();

        expect(await db.get('people', person._id)).toBeUndefined();
    });

    // The "Person saved — UNDO" snackbar outlives the editor (the undo store is global).
    it('an UNDO pressed after the person was deleted does not resurrect them', async () => {
        const person = await seedPerson();
        const { unmount } = renderWithPendingRename(person, 'Dana Levi');
        unmount();
        await vi.waitFor(() => expect(getCurrentUndo()).not.toBeNull());

        await db.delete('people', person._id);
        await runCurrentUndo();

        expect(await db.get('people', person._id)).toBeUndefined();
    });
});
