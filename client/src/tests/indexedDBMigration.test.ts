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

describe('indexedDB v2 → v3 migration', () => {
    it('backfills userId on every legacy syncOperations row using the active account', async () => {
        await withFreshIDB(async () => {
            await bootV2DBWithFixtures({ activeUserId: 'active-user', legacyOpsEntityIds: ['legacy-a', 'legacy-b'] });

            const upgraded = await openAppDB();
            const ops = await upgraded.getAll('syncOperations');
            expect(ops).toHaveLength(2);
            expect(ops.every((op) => op.userId === 'active-user')).toBe(true);
            upgraded.close();
        });
    });

    it('leaves the queue empty and migrates cleanly when the user has no queued ops', async () => {
        await withFreshIDB(async () => {
            await bootV2DBWithFixtures({ activeUserId: 'active-user', legacyOpsEntityIds: [] });

            const upgraded = await openAppDB();
            expect(await upgraded.getAll('syncOperations')).toHaveLength(0);
            upgraded.close();
        });
    });

    it('no-ops the backfill when the legacy DB has no active account', async () => {
        await withFreshIDB(async () => {
            // legacyOpsEntityIds intentionally empty — without an active account we can't
            // attribute legacy rows to anyone, so the migration must skip rather than guess.
            await bootV2DBWithFixtures({ activeUserId: null, legacyOpsEntityIds: [] });

            const upgraded = await openAppDB();
            expect(await upgraded.getAll('syncOperations')).toHaveLength(0);
            upgraded.close();
        });
    });
});

describe('indexedDB v3 → v4 migration (per-user cursors)', () => {
    it('splits the legacy deviceSyncState singleton into deviceMeta + a syncCursors row for the active user', async () => {
        await withFreshIDB(async () => {
            await bootV3DBWithDeviceSyncState({
                activeUserId: 'active-user',
                legacy: { deviceId: 'dev-1', lastSyncedTs: '2025-04-30T19:38:54.754Z', flushingTs: null },
            });

            const upgraded = await openAppDB();
            const meta = await upgraded.get('deviceMeta', 'local');
            expect(meta?.deviceId).toBe('dev-1');
            expect(meta?.flushingTs).toBeNull();

            const cursor = await upgraded.get('syncCursors', 'active-user');
            expect(cursor?.lastSyncedTs).toBe('2025-04-30T19:38:54.754Z');

            // Other accounts get no row — they bootstrap or pull from epoch on their first sync.
            expect(await upgraded.getAll('syncCursors')).toHaveLength(1);
            upgraded.close();
        });
    });

    it('preserves the cross-context flush lock through the migration', async () => {
        await withFreshIDB(async () => {
            const lockTs = '2026-04-30T19:00:00.000Z';
            await bootV3DBWithDeviceSyncState({
                activeUserId: 'active-user',
                legacy: { deviceId: 'dev-1', lastSyncedTs: '2025-01-01T00:00:00.000Z', flushingTs: lockTs },
            });

            const upgraded = await openAppDB();
            const meta = await upgraded.get('deviceMeta', 'local');
            expect(meta?.flushingTs).toBe(lockTs);
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
