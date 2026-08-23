import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { performLocalAccountSwitch } from '../hooks/useAccounts';
import { readFreshListScrollEntry, resetListScrollMemory, saveListScrollEntry } from '../lib/listScrollMemory';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

// Pins the local-first switch core: the only remaining failure mode of switchToAccount is an IDB
// write rejection, and it MUST propagate so withPending's catch can clear the blocking backdrop
// and surface the "Couldn't switch" error. Swallowing it would strand the user behind the backdrop.

let db: IDBPDatabase<MyDB>;

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

    it('propagates an IDB write failure so withPending can clear the backdrop and surface the error', async () => {
        // A closed connection makes every transaction throw — the closest simulation of a real
        // IDB failure (quota exceeded, closing connection) without patching internals.
        db.close();

        await expect(performLocalAccountSwitch(db, 'user-b', { pathname: '/inbox', search: '' })).rejects.toThrow();
    });
});
