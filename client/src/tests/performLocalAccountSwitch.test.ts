import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setActiveAccount } from '../db/accountHelpers';
import { withSessionGate } from '../db/syncHelpers';
import { performLocalAccountSwitch } from '../hooks/useAccounts';
import { readFreshListScrollEntry, resetListScrollMemory, saveListScrollEntry } from '../lib/listScrollMemory';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

// Pins the local-first switch core: the only remaining failure mode of switchToAccount is an IDB
// write rejection, and it MUST propagate so withPending's catch can clear the blocking backdrop
// and surface the "Couldn't switch" error. Swallowing it would strand the user behind the backdrop.

let db: IDBPDatabase<MyDB>;

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
});

afterEach(() => {
    db.close();
    resetListScrollMemory();
});

describe('performLocalAccountSwitch', () => {
    it('persists the chosen account to IDB and returns the reload URL for the current route', async () => {
        const url = await performLocalAccountSwitch(db, 'user-b', { pathname: '/settings', search: '?tab=devices' });

        expect(url).toBe('/settings?tab=devices');
        const active = await db.get('activeAccount', 'active');
        expect(active?.userId).toBe('user-b');
    });

    it('clears the saved scroll positions — they belong to the previous account and the switch reloads the same URL', async () => {
        saveListScrollEntry('/next-actions', { scrollTop: 700, anchors: [{ id: 'prev-account-item', offset: 10 }], savedAtMs: 1_000 });

        await performLocalAccountSwitch(db, 'user-b', { pathname: '/next-actions', search: '' });

        expect(readFreshListScrollEntry('/next-actions', 1_000)).toBeNull();
    });

    // A sync pass pivots the active pointer to each account it syncs and, in its finally, restores
    // the account that was active when it STARTED. A switch landing mid-pass must win over that restore.
    it('a switch made while a sync pass is in flight survives the pass restoring its starting account', async () => {
        await setActiveAccount('user-a', db);
        const passReachedPivot = deferred();
        const releasePass = deferred();
        const pass = withSessionGate(async () => {
            await setActiveAccount('user-b', db); // the pass pivots to sync B…
            passReachedPivot.resolve();
            await releasePass.promise;
            await setActiveAccount('user-a', db); // …and restores A, the account it started on.
        });
        await passReachedPivot.promise;

        const switched = performLocalAccountSwitch(db, 'user-c', { pathname: '/inbox', search: '' });
        releasePass.resolve();
        await Promise.all([pass, switched]);

        expect((await db.get('activeAccount', 'active'))?.userId).toBe('user-c');
    });

    it('propagates an IDB write failure so withPending can clear the backdrop and surface the error', async () => {
        // A closed connection makes every transaction throw — the closest simulation of a real
        // IDB failure (quota exceeded, closing connection) without patching internals.
        db.close();

        await expect(performLocalAccountSwitch(db, 'user-b', { pathname: '/inbox', search: '' })).rejects.toThrow();
    });
});
