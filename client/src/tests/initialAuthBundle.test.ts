import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetInitialAuthBundleCacheForTests, getInitialAuthBundle } from '../data/initialAuthBundle';
import { setActiveAccount, upsertAccount } from '../db/accountHelpers';
import type { MyDB, StoredAccount } from '../types/MyDB';
import { openTestDB } from './openTestDB';

function makeAccount(id: string, addedAt: number): StoredAccount {
    return {
        id,
        email: `${id}@example.com`,
        name: id,
        image: null,
        provider: 'google',
        addedAt,
    };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    _resetInitialAuthBundleCacheForTests();
    db = await openTestDB();
});

afterEach(() => {
    db.close();
});

describe('getInitialAuthBundle', () => {
    it('returns null account and empty arrays when IDB is empty (route guard then redirects to login)', async () => {
        const bundle = await getInitialAuthBundle(db);
        expect(bundle.account).toBeNull();
        expect(bundle.loggedInAccounts).toEqual([]);
        expect(bundle.loggedInUserIds).toEqual([]);
    });

    it('returns the active account and every signed-in account when IDB has them', async () => {
        const a = makeAccount('user-A', 1);
        const b = makeAccount('user-B', 2);
        await upsertAccount(a, db);
        await upsertAccount(b, db);
        await setActiveAccount('user-B', db);

        const bundle = await getInitialAuthBundle(db);
        expect(bundle.account?.id).toBe('user-B');
        // loggedInAccounts is sorted oldest-added first, regardless of which one is active.
        expect(bundle.loggedInUserIds).toEqual(['user-A', 'user-B']);
    });

    it('caches per-db so two callers suspend on the same promise (Suspense de-dupe)', () => {
        const first = getInitialAuthBundle(db);
        const second = getInitialAuthBundle(db);
        expect(second).toBe(first);
    });
});
