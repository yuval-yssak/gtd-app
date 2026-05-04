import type { IDBPDatabase } from 'idb';
import { getActiveAccount, getLoggedInAccounts } from '../db/accountHelpers';
import type { MyDB, StoredAccount } from '../types/MyDB';

export interface InitialAuthBundle {
    account: StoredAccount | null;
    loggedInAccounts: StoredAccount[];
    loggedInUserIds: string[];
}

/**
 * Cached promise of the auth state read from IDB at boot. Mounted once per `db` so two `use()`
 * calls suspend on the same promise and resolve in lockstep — keeps the first-paint userIds set
 * stable, otherwise the resource snapshot would briefly build for `[]` (showing empty arrays)
 * before swapping in the real userIds.
 */
const cache = new Map<IDBPDatabase<MyDB>, Promise<InitialAuthBundle>>();

async function read(db: IDBPDatabase<MyDB>): Promise<InitialAuthBundle> {
    const [account, loggedInAccounts] = await Promise.all([getActiveAccount(db), getLoggedInAccounts(db)]);
    return {
        account: account ?? null,
        loggedInAccounts,
        loggedInUserIds: loggedInAccounts.map((a) => a.id),
    };
}

export function getInitialAuthBundle(db: IDBPDatabase<MyDB>): Promise<InitialAuthBundle> {
    const existing = cache.get(db);
    if (existing) {
        return existing;
    }
    const promise = read(db);
    cache.set(db, promise);
    return promise;
}

/** Test-only — drops the per-db cache so unit tests can re-seed. */
export function _resetInitialAuthBundleCacheForTests(): void {
    cache.clear();
}
