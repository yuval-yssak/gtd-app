import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Network boundaries: the device-row drop and Better Auth's sign-out.
vi.mock('../api/pushApi', () => ({ signOutDevice: vi.fn(async () => undefined) }));
vi.mock('../lib/authClient', () => ({ authClient: { signOut: vi.fn(async () => undefined) } }));

import { setActiveAccount, upsertAccount } from '../db/accountHelpers';
import { putItem } from '../db/itemHelpers';
import { withSessionGate } from '../db/syncHelpers';
import { performSignOutAll } from '../hooks/useAccounts';
import type { MyDB, StoredItem } from '../types/MyDB';
import { openTestDB } from './openTestDB';

let db: IDBPDatabase<MyDB>;

function inboxItem(userId: string): StoredItem {
    return { _id: `item-${userId}`, userId, status: 'inbox', title: userId, createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z' };
}

/** A promise the test settles by hand, to hold a gated task at a chosen point. */
function deferred() {
    // let: the executor is the only place the resolver is handed out (Promise.withResolvers is ES2024).
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

beforeEach(async () => {
    db = await openTestDB();
    await upsertAccount({ id: 'user-a', email: 'a@example.com', name: 'A', image: null, provider: 'google', addedAt: 0 }, db);
    await setActiveAccount('user-a', db);
});

afterEach(() => db.close());

describe('performSignOutAll', () => {
    // A sync pass in flight pulls rows for the account; a sign-out interleaved with it would wipe
    // first and let the pass write the user's rows back afterwards.
    it('waits for a sync pass in flight, so nothing the pass writes survives the wipe', async () => {
        const releasePass = deferred();
        const pass = withSessionGate(async () => {
            await releasePass.promise;
            await putItem(db, inboxItem('user-a'));
        });

        const signOut = performSignOutAll(db);
        // Let the sign-out run as far as it can before the pass writes: an ungated sign-out
        // finishes in this window, and the pass's late write would then survive it.
        await Promise.race([signOut, new Promise((settle) => setTimeout(settle, 100))]);
        releasePass.resolve();
        await Promise.all([pass, signOut]);

        expect(await db.getAll('items')).toEqual([]);
        expect(await db.getAll('accounts')).toEqual([]);
    });
});
