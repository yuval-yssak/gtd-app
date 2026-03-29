import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted before imports by Vitest's transformer, so syncHelpers.ts's own
// import of '#api/syncClient' is also intercepted — no resolve.conditions config needed.
vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { fetchBootstrap, fetchSyncOps, pushSyncOps } from '#api/syncClient';
import { bootstrapFromServer, flushSyncQueue, pullFromServer } from '../db/syncHelpers';
import type { MyDB, StoredItem, StoredPerson, StoredRoutine, StoredWorkContext } from '../types/MyDB';
// StoredPerson/Routine/WorkContext are still needed for the db.put() casts below
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function makeItem(id: string, updatedTs = '2025-01-01T00:00:00.000Z'): StoredItem {
    return { _id: id, userId: USER_ID, status: 'inbox', title: 'Item', createdTs: '2025-01-01T00:00:00.000Z', updatedTs };
}

// Server payloads use `user` instead of `userId` (mirroring the MongoDB field name).
function serverItem(id: string, updatedTs = '2025-01-01T00:00:00.000Z') {
    return { _id: id, user: USER_ID, status: 'inbox', title: 'Item', createdTs: '2025-01-01T00:00:00.000Z', updatedTs };
}

// Return Record<string, unknown> & { user: string } so the objects satisfy the ServerOp.snapshot
// and BootstrapPayload array types — TypeScript doesn't widen named types (StoredPerson, etc.)
// to Record<string, unknown> because they lack an index signature.
function serverPerson(id: string): Record<string, unknown> & { user: string } {
    return { _id: id, user: USER_ID, userId: USER_ID, name: 'Alice', createdTs: '2025-01-01T00:00:00.000Z', updatedTs: '2025-01-01T00:00:00.000Z' };
}

function serverRoutine(id: string): Record<string, unknown> & { user: string } {
    return {
        _id: id,
        user: USER_ID,
        userId: USER_ID,
        title: 'Weekly review',
        triggerMode: 'fixedSchedule',
        template: {},
        active: true,
        createdTs: '2025-01-01T00:00:00.000Z',
        updatedTs: '2025-01-01T00:00:00.000Z',
    };
}

function serverWorkContext(id: string): Record<string, unknown> & { user: string } {
    return { _id: id, user: USER_ID, userId: USER_ID, name: 'At desk', createdTs: '2025-01-01T00:00:00.000Z', updatedTs: '2025-01-01T00:00:00.000Z' };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
    // Seed a deviceSyncState so flushSyncQueue/pullFromServer can read deviceId and lastSyncedTs.
    await db.put('deviceSyncState', { _id: 'local', deviceId: 'device-test', lastSyncedTs: '1970-01-01T00:00:00.000Z' });
});

afterEach(() => {
    // clearAllMocks resets call history on vi.fn() instances while preserving their default
    // implementations (unlike restoreAllMocks which is for vi.spyOn() spies).
    vi.clearAllMocks();
    db.close();
});

// ── flushSyncQueue ─────────────────────────────────────────────────────────────

describe('flushSyncQueue', () => {
    it('does nothing when the queue is empty', async () => {
        await flushSyncQueue(db);

        expect(vi.mocked(pushSyncOps)).not.toHaveBeenCalled();
    });

    it('sends queued ops and clears the queue on success', async () => {
        // Seed IDB directly rather than via queueSyncOp: queueSyncOp fires an immediate
        // fire-and-forget flush that races with mock setup when Node's native fetch is present.
        await db.add('syncOperations', {
            opType: 'create',
            entityType: 'item',
            entityId: 'item-1',
            queuedAt: '2025-01-01T00:00:00.000Z',
            snapshot: makeItem('item-1'),
        });

        await flushSyncQueue(db);

        expect(vi.mocked(pushSyncOps)).toHaveBeenCalledOnce();

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(0);
    });

    it('preserves the queue when the server returns an error', async () => {
        // Seed IDB directly (avoid queueSyncOp's fire-and-forget racing with the mock rejection).
        // Configure rejection before seeding so the fire-and-forget also uses the rejecting mock.
        vi.mocked(pushSyncOps).mockRejectedValueOnce(new Error('POST /sync/push 500'));
        await db.add('syncOperations', {
            opType: 'create',
            entityType: 'item',
            entityId: 'item-2',
            queuedAt: '2025-01-01T00:00:00.000Z',
            snapshot: makeItem('item-2'),
        });

        await expect(flushSyncQueue(db)).rejects.toThrow('POST /sync/push 500');

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
    });
});

// ── pullFromServer / applyServerOp ─────────────────────────────────────────────

describe('pullFromServer — item ops', () => {
    it('create op writes the item to IndexedDB', async () => {
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'item', entityId: 'item-10', opType: 'create', snapshot: serverItem('item-10') }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db);

        const item = await db.get('items', 'item-10');
        expect(item?.userId).toBe(USER_ID);
        // remapUser must have converted `user` → `userId`
        expect((item as unknown as { user?: string } | undefined)?.user).toBeUndefined();
    });

    it('update op with newer updatedTs replaces the local version', async () => {
        await db.put('items', makeItem('item-11', '2025-01-01T00:00:00.000Z'));

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'item', entityId: 'item-11', opType: 'update', snapshot: serverItem('item-11', '2025-06-01T00:00:00.000Z') }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db);

        const item = await db.get('items', 'item-11');
        expect(item?.updatedTs).toBe('2025-06-01T00:00:00.000Z');
    });

    it('update op with older updatedTs keeps the local version (last-write-wins)', async () => {
        await db.put('items', makeItem('item-12', '2025-06-01T00:00:00.000Z'));

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'item', entityId: 'item-12', opType: 'update', snapshot: serverItem('item-12', '2025-01-01T00:00:00.000Z') }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db);

        const item = await db.get('items', 'item-12');
        // Local is newer — must not be overwritten
        expect(item?.updatedTs).toBe('2025-06-01T00:00:00.000Z');
    });

    it('delete op removes the item from IndexedDB', async () => {
        await db.put('items', makeItem('item-13'));

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'item', entityId: 'item-13', opType: 'delete', snapshot: null }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db);

        const item = await db.get('items', 'item-13');
        expect(item).toBeUndefined();
    });

    it('updates lastSyncedTs to serverTs after a successful pull', async () => {
        const serverTs = '2025-09-01T12:00:00.000Z';
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs });

        await pullFromServer(db);

        const state = await db.get('deviceSyncState', 'local');
        expect(state?.lastSyncedTs).toBe(serverTs);
    });

    it('throws and does not update lastSyncedTs when server returns non-200', async () => {
        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new Error('GET /sync/pull 503'));

        await expect(pullFromServer(db)).rejects.toThrow('GET /sync/pull 503');

        const state = await db.get('deviceSyncState', 'local');
        expect(state?.lastSyncedTs).toBe('1970-01-01T00:00:00.000Z');
    });
});

describe('pullFromServer — routine/person/workContext ops', () => {
    it('routine create op writes to IndexedDB', async () => {
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'routine', entityId: 'routine-1', opType: 'create', snapshot: serverRoutine('routine-1') }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db);

        const routine = await db.get('routines', 'routine-1');
        expect(routine?.title).toBe('Weekly review');
        expect(routine?.userId).toBe(USER_ID);
    });

    it('routine delete op removes from IndexedDB', async () => {
        await db.put('routines', serverRoutine('routine-2') as unknown as StoredRoutine);

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'routine', entityId: 'routine-2', opType: 'delete', snapshot: null }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db);

        expect(await db.get('routines', 'routine-2')).toBeUndefined();
    });

    it('person create op writes to IndexedDB', async () => {
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'person', entityId: 'person-1', opType: 'create', snapshot: serverPerson('person-1') }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db);

        const person = await db.get('people', 'person-1');
        expect(person?.name).toBe('Alice');
        expect(person?.userId).toBe(USER_ID);
    });

    it('person delete op removes from IndexedDB', async () => {
        await db.put('people', serverPerson('person-2') as unknown as StoredPerson);

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'person', entityId: 'person-2', opType: 'delete', snapshot: null }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db);

        expect(await db.get('people', 'person-2')).toBeUndefined();
    });

    it('workContext create op writes to IndexedDB', async () => {
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'workContext', entityId: 'wc-1', opType: 'create', snapshot: serverWorkContext('wc-1') }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db);

        const wc = await db.get('workContexts', 'wc-1');
        expect(wc?.name).toBe('At desk');
        expect(wc?.userId).toBe(USER_ID);
    });

    it('workContext delete op removes from IndexedDB', async () => {
        await db.put('workContexts', serverWorkContext('wc-2') as unknown as StoredWorkContext);

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'workContext', entityId: 'wc-2', opType: 'delete', snapshot: null }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db);

        expect(await db.get('workContexts', 'wc-2')).toBeUndefined();
    });
});

// ── bootstrapFromServer ────────────────────────────────────────────────────────

describe('bootstrapFromServer', () => {
    it('writes all entity types and sets lastSyncedTs', async () => {
        const serverTs = '2025-07-01T00:00:00.000Z';
        vi.mocked(fetchBootstrap).mockResolvedValueOnce({
            items: [serverItem('item-b1')],
            routines: [serverRoutine('routine-b1')],
            people: [serverPerson('person-b1')],
            workContexts: [serverWorkContext('wc-b1')],
            serverTs,
        });

        await bootstrapFromServer(db);

        expect(await db.get('items', 'item-b1')).toBeDefined();
        expect(await db.get('routines', 'routine-b1')).toBeDefined();
        expect(await db.get('people', 'person-b1')).toBeDefined();
        expect(await db.get('workContexts', 'wc-b1')).toBeDefined();

        const state = await db.get('deviceSyncState', 'local');
        expect(state?.lastSyncedTs).toBe(serverTs);
    });

    it('remaps user → userId on all entities', async () => {
        vi.mocked(fetchBootstrap).mockResolvedValueOnce({
            items: [serverItem('item-b2')],
            routines: [],
            people: [],
            workContexts: [],
            serverTs: '2025-07-01T00:00:00.000Z',
        });

        await bootstrapFromServer(db);

        const item = await db.get('items', 'item-b2');
        expect(item?.userId).toBe(USER_ID);
        expect((item as unknown as { user?: string } | undefined)?.user).toBeUndefined();
    });

    it('throws when the server returns non-200, writing nothing', async () => {
        vi.mocked(fetchBootstrap).mockRejectedValueOnce(new Error('GET /sync/bootstrap 401'));

        await expect(bootstrapFromServer(db)).rejects.toThrow('GET /sync/bootstrap 401');

        const items = await db.getAll('items');
        expect(items).toHaveLength(0);
    });
});
