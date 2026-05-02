import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { openAppDB } from '../db/indexedDB';
import type { MyDB } from '../types/MyDB';

// Boots a v2-shape gtd-app DB on whichever IDBFactory is currently installed on globalThis,
// seeds it as the upgrade path expects, then runs `openAppDB` (v3) so we can assert the migration
// touched only the rows it should.
async function bootV2DBWithFixtures(opts: { activeUserId: string | null; legacyOpsEntityIds: string[] }): Promise<void> {
    const v2 = await openDB('gtd-app', 2, {
        upgrade(db) {
            const accounts = db.createObjectStore('accounts', { keyPath: 'id' });
            accounts.createIndex('email', 'email', { unique: true });
            db.createObjectStore('activeAccount');
            const items = db.createObjectStore('items', { keyPath: '_id' });
            items.createIndex('userId', 'userId', { unique: false });
            db.createObjectStore('syncOperations', { autoIncrement: true, keyPath: 'id' });
            db.createObjectStore('deviceSyncState', { keyPath: '_id' });
            const routines = db.createObjectStore('routines', { keyPath: '_id' });
            routines.createIndex('userId', 'userId', { unique: false });
            const people = db.createObjectStore('people', { keyPath: '_id' });
            people.createIndex('userId', 'userId', { unique: false });
            const workContexts = db.createObjectStore('workContexts', { keyPath: '_id' });
            workContexts.createIndex('userId', 'userId', { unique: false });
        },
    });
    if (opts.activeUserId) {
        await v2.put('activeAccount', { userId: opts.activeUserId }, 'active');
    }
    for (const entityId of opts.legacyOpsEntityIds) {
        // Cast to any-equivalent — the v3 type requires `userId`, but here we're seeding the v2
        // shape that the migration will fix. This is the only legitimate use of the cast.
        await v2.add('syncOperations', {
            opType: 'create',
            entityType: 'item',
            entityId,
            queuedAt: '2025-01-01T00:00:00.000Z',
            snapshot: null,
        } as unknown as MyDB['syncOperations']['value']);
    }
    v2.close();
}

async function withFreshIDB<T>(fn: () => Promise<T>): Promise<T> {
    const prev = globalThis.indexedDB;
    globalThis.indexedDB = new IDBFactory();
    try {
        return await fn();
    } finally {
        globalThis.indexedDB = prev;
    }
}

/** Boots a v3-shape DB seeded with a legacy `deviceSyncState` singleton and an active account. */
async function bootV3DBWithDeviceSyncState(opts: {
    activeUserId: string | null;
    legacy: { deviceId: string; lastSyncedTs: string; flushingTs: string | null } | null;
}): Promise<void> {
    const v3 = await openDB('gtd-app', 3, {
        upgrade(db) {
            const accounts = db.createObjectStore('accounts', { keyPath: 'id' });
            accounts.createIndex('email', 'email', { unique: true });
            db.createObjectStore('activeAccount');
            const items = db.createObjectStore('items', { keyPath: '_id' });
            items.createIndex('userId', 'userId', { unique: false });
            db.createObjectStore('syncOperations', { autoIncrement: true, keyPath: 'id' });
            db.createObjectStore('deviceSyncState', { keyPath: '_id' });
            const routines = db.createObjectStore('routines', { keyPath: '_id' });
            routines.createIndex('userId', 'userId', { unique: false });
            const people = db.createObjectStore('people', { keyPath: '_id' });
            people.createIndex('userId', 'userId', { unique: false });
            const workContexts = db.createObjectStore('workContexts', { keyPath: '_id' });
            workContexts.createIndex('userId', 'userId', { unique: false });
        },
    });
    if (opts.activeUserId) {
        await v3.put('activeAccount', { userId: opts.activeUserId }, 'active');
    }
    if (opts.legacy) {
        await v3.put(
            'deviceSyncState' as unknown as Parameters<typeof v3.put>[0],
            { _id: 'local', deviceId: opts.legacy.deviceId, lastSyncedTs: opts.legacy.lastSyncedTs, flushingTs: opts.legacy.flushingTs } as never,
        );
    }
    v3.close();
}

describe('indexedDB v2 → current chained migration', () => {
    // v3 backfilled userId onto legacy ops; v5 then clears the queue entirely. Either way, after a
    // full chain upgrade the queue must be empty — assert the post-state of the chain rather than
    // the intermediate v3 state, which is no longer observable through openAppDB.
    it('ends with an empty syncOperations queue regardless of pre-upgrade contents', async () => {
        await withFreshIDB(async () => {
            await bootV2DBWithFixtures({ activeUserId: 'active-user', legacyOpsEntityIds: ['legacy-a', 'legacy-b'] });

            const upgraded = await openAppDB();
            expect(await upgraded.getAll('syncOperations')).toHaveLength(0);
            upgraded.close();
        });
    });

    it('migrates cleanly when the user has no queued ops and no active account', async () => {
        await withFreshIDB(async () => {
            await bootV2DBWithFixtures({ activeUserId: null, legacyOpsEntityIds: [] });

            const upgraded = await openAppDB();
            expect(await upgraded.getAll('syncOperations')).toHaveLength(0);
            upgraded.close();
        });
    });
});

describe('indexedDB v3 → v4 migration (per-user cursors)', () => {
    it('preserves deviceMeta from the legacy singleton (cursor is wiped by v5 — covered separately)', async () => {
        await withFreshIDB(async () => {
            await bootV3DBWithDeviceSyncState({
                activeUserId: 'active-user',
                legacy: { deviceId: 'dev-1', lastSyncedTs: '2025-04-30T19:38:54.754Z', flushingTs: null },
            });

            const upgraded = await openAppDB();
            const meta = await upgraded.get('deviceMeta', 'local');
            expect(meta?.deviceId).toBe('dev-1');
            expect(meta?.flushingTs).toBeNull();

            // syncCursors gets cleared by the v5 wipe; the per-user cursor row is no longer
            // observable through the full chain. The v3→v4 split itself still runs (no errors),
            // and the next bootstrap re-creates the cursor at serverTs.
            expect(await upgraded.getAll('syncCursors')).toHaveLength(0);
            upgraded.close();
        });
    });

    it('clears any legacy flush lock through the chain (v4 forwards it; v5 then resets it to null)', async () => {
        await withFreshIDB(async () => {
            const lockTs = '2026-04-30T19:00:00.000Z';
            await bootV3DBWithDeviceSyncState({
                activeUserId: 'active-user',
                legacy: { deviceId: 'dev-1', lastSyncedTs: '2025-01-01T00:00:00.000Z', flushingTs: lockTs },
            });

            const upgraded = await openAppDB();
            const meta = await upgraded.get('deviceMeta', 'local');
            expect(meta?.flushingTs).toBeNull();
            upgraded.close();
        });
    });

    it('skips writing a cursor when no active account exists at migration time', async () => {
        await withFreshIDB(async () => {
            // Pre-login state with a populated legacy cursor — unusual but defensible.
            await bootV3DBWithDeviceSyncState({
                activeUserId: null,
                legacy: { deviceId: 'dev-1', lastSyncedTs: '2025-04-30T00:00:00.000Z', flushingTs: null },
            });

            const upgraded = await openAppDB();
            const meta = await upgraded.get('deviceMeta', 'local');
            expect(meta?.deviceId).toBe('dev-1');
            expect(await upgraded.getAll('syncCursors')).toHaveLength(0);
            upgraded.close();
        });
    });

    it('initializes empty stores cleanly when the legacy deviceSyncState row is absent', async () => {
        await withFreshIDB(async () => {
            // Brand-new pre-v4 install never wrote a cursor singleton.
            await bootV3DBWithDeviceSyncState({ activeUserId: 'active-user', legacy: null });

            const upgraded = await openAppDB();
            expect(await upgraded.get('deviceMeta', 'local')).toBeUndefined();
            expect(await upgraded.getAll('syncCursors')).toHaveLength(0);
            upgraded.close();
        });
    });
});

/**
 * Boots a v4-shape DB and seeds every entity store + sync bookkeeping store. Lets v4→v5 tests
 * assert that the wipe migration touches only the stores it should.
 */
async function bootV4DBWithFullCache(): Promise<void> {
    const v4 = await openDB<MyDB>('gtd-app', 4, {
        upgrade(db) {
            const accounts = db.createObjectStore('accounts', { keyPath: 'id' });
            accounts.createIndex('email', 'email', { unique: true });
            db.createObjectStore('activeAccount');
            const items = db.createObjectStore('items', { keyPath: '_id' });
            items.createIndex('userId', 'userId', { unique: false });
            db.createObjectStore('syncOperations', { autoIncrement: true, keyPath: 'id' });
            const routines = db.createObjectStore('routines', { keyPath: '_id' });
            routines.createIndex('userId', 'userId', { unique: false });
            const people = db.createObjectStore('people', { keyPath: '_id' });
            people.createIndex('userId', 'userId', { unique: false });
            const workContexts = db.createObjectStore('workContexts', { keyPath: '_id' });
            workContexts.createIndex('userId', 'userId', { unique: false });
            db.createObjectStore('deviceMeta', { keyPath: '_id' });
            db.createObjectStore('syncCursors', { keyPath: 'userId' });
        },
    });

    // StoredAccount.id is the Better Auth user ID — so id === userId by design.
    await v4.put('accounts', { id: 'user-1', email: 'user@example.com', name: 'User', image: null, provider: 'google', addedAt: 0 });
    await v4.put('activeAccount', { userId: 'user-1' }, 'active');
    await v4.put('items', {
        _id: 'item-1',
        userId: 'user-1',
        title: 'stale',
        status: 'inbox',
        updatedTs: '2026-04-01T00:00:00.000Z',
        createdTs: '2026-04-01T00:00:00.000Z',
    } as MyDB['items']['value']);
    await v4.put('routines', { _id: 'routine-1', userId: 'user-1', title: 'stale routine' } as unknown as MyDB['routines']['value']);
    await v4.put('people', { _id: 'person-1', userId: 'user-1', name: 'stale person' } as unknown as MyDB['people']['value']);
    await v4.put('workContexts', { _id: 'wc-1', userId: 'user-1', name: 'stale ctx' } as unknown as MyDB['workContexts']['value']);
    await v4.add('syncOperations', {
        userId: 'user-1',
        opType: 'create',
        entityType: 'item',
        entityId: 'item-1',
        queuedAt: '2026-04-01T00:00:00.000Z',
        snapshot: null,
    } as unknown as MyDB['syncOperations']['value']);
    await v4.put('deviceMeta', { _id: 'local', deviceId: 'dev-1', flushingTs: null });
    await v4.put('syncCursors', { userId: 'user-1', lastSyncedTs: '2026-04-30T00:00:00.000Z' });
    v4.close();
}

describe('indexedDB v4 → v5 migration (server-data wipe)', () => {
    it('clears every cached entity store + sync queue + cursors so the next bootstrap rebuilds from server', async () => {
        await withFreshIDB(async () => {
            await bootV4DBWithFullCache();

            const upgraded = await openAppDB();
            expect(await upgraded.getAll('items')).toHaveLength(0);
            expect(await upgraded.getAll('routines')).toHaveLength(0);
            expect(await upgraded.getAll('people')).toHaveLength(0);
            expect(await upgraded.getAll('workContexts')).toHaveLength(0);
            expect(await upgraded.getAll('syncOperations')).toHaveLength(0);
            expect(await upgraded.getAll('syncCursors')).toHaveLength(0);
            upgraded.close();
        });
    });

    it('preserves accounts, activeAccount, and deviceMeta so the user stays logged in and keeps their device identity', async () => {
        await withFreshIDB(async () => {
            await bootV4DBWithFullCache();

            const upgraded = await openAppDB();
            const accounts = await upgraded.getAll('accounts');
            expect(accounts).toHaveLength(1);
            expect(accounts[0]?.id).toBe('user-1');

            const active = await upgraded.get('activeAccount', 'active');
            expect(active?.userId).toBe('user-1');

            const meta = await upgraded.get('deviceMeta', 'local');
            expect(meta?.deviceId).toBe('dev-1');
            upgraded.close();
        });
    });

    it('resets a stale flushingTs so a tab killed mid-flush against the dropped server DB does not wedge sync', async () => {
        await withFreshIDB(async () => {
            // Boot a v4 DB with deviceMeta holding a stale flush lock from a pre-upgrade flush.
            const v4 = await openDB<MyDB>('gtd-app', 4, {
                upgrade(db) {
                    db.createObjectStore('accounts', { keyPath: 'id' }).createIndex('email', 'email', { unique: true });
                    db.createObjectStore('activeAccount');
                    db.createObjectStore('items', { keyPath: '_id' }).createIndex('userId', 'userId', { unique: false });
                    db.createObjectStore('syncOperations', { autoIncrement: true, keyPath: 'id' });
                    db.createObjectStore('routines', { keyPath: '_id' }).createIndex('userId', 'userId', { unique: false });
                    db.createObjectStore('people', { keyPath: '_id' }).createIndex('userId', 'userId', { unique: false });
                    db.createObjectStore('workContexts', { keyPath: '_id' }).createIndex('userId', 'userId', { unique: false });
                    db.createObjectStore('deviceMeta', { keyPath: '_id' });
                    db.createObjectStore('syncCursors', { keyPath: 'userId' });
                },
            });
            await v4.put('deviceMeta', { _id: 'local', deviceId: 'dev-1', flushingTs: '2026-04-30T19:00:00.000Z' });
            v4.close();

            const upgraded = await openAppDB();
            const meta = await upgraded.get('deviceMeta', 'local');
            expect(meta?.deviceId).toBe('dev-1');
            expect(meta?.flushingTs).toBeNull();
            upgraded.close();
        });
    });
});
