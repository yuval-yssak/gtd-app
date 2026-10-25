import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getActiveAccount, setActiveAccount, upsertAccount } from '../db/accountHelpers';
import { readSettledActiveAccount, withSessionGate } from '../db/syncHelpers';
import type { MyDB, StoredAccount } from '../types/MyDB';
import { openTestDB } from './openTestDB';

let db: IDBPDatabase<MyDB>;

function account(id: string): StoredAccount {
    return { id, email: `${id}@example.com`, name: id, image: null, provider: 'google', addedAt: 0 };
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

/** Starts a sync-pass stand-in that pivots the active pointer to `syncedId` and waits to be released. */
async function startPassPivotedTo(syncedId: string, restoreId: string) {
    const pivoted = deferred();
    const release = deferred();
    const pass = withSessionGate(async () => {
        await setActiveAccount(syncedId, db);
        pivoted.resolve();
        await release.promise;
        await setActiveAccount(restoreId, db);
    });
    await pivoted.promise;
    return { pass, release: release.resolve };
}

beforeEach(async () => {
    db = await openTestDB();
    await upsertAccount(account('user-a'), db);
    await upsertAccount(account('user-b'), db);
    await setActiveAccount('user-a', db);
});

afterEach(() => db.close());

describe('readSettledActiveAccount', () => {
    it('returns the user-selected account even while a sync pass has the pointer on another one', async () => {
        const { pass, release } = await startPassPivotedTo('user-b', 'user-a');
        // The hazard: a bare read mid-pass sees the account being synced.
        expect((await getActiveAccount(db))?.id).toBe('user-b');

        const settled = readSettledActiveAccount(db);
        release();
        await pass;

        expect((await settled)?.id).toBe('user-a');
    });

    it('reads straight through when no pass is running', async () => {
        expect((await readSettledActiveAccount(db))?.id).toBe('user-a');
    });
});
