import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted before imports by Vitest's transformer, so syncHelpers.ts's own
// import of '#api/syncClient' is also intercepted — no resolve.conditions config needed.
vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import dayjs from 'dayjs';
import { fetchBootstrap, fetchSyncOps, pushSyncOps } from '#api/syncClient';
import {
    bootstrapFromServer,
    flushSyncQueue,
    pullFromServer,
    queueSyncOp,
    setSessionGateTimeoutMs,
    waitForPendingFlush,
    withSessionGate,
} from '../db/syncHelpers';
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
    // Seed deviceMeta so flushSyncQueue can read the deviceId + acquire/release the flush lock,
    // plus a per-user cursor so pullFromServer has a value to read/advance.
    await db.put('deviceMeta', { _id: 'local', deviceId: 'device-test', flushingTs: null });
    await db.put('syncCursors', { userId: USER_ID, lastSyncedTs: '1970-01-01T00:00:00.000Z' });
    // Seed the active account matching USER_ID so `assertActiveSessionMatches` (the guard inside
    // doPull/bootstrap) lets these tests through without each one having to set it up.
    await db.put('accounts', { id: USER_ID, email: 'u@example.com', name: 'U', image: null, provider: 'google', addedAt: 1 });
    await db.put('activeAccount', { userId: USER_ID }, 'active');
});

afterEach(() => {
    // clearAllMocks resets call history on vi.fn() instances while preserving their default
    // implementations (unlike restoreAllMocks which is for vi.spyOn() spies).
    vi.clearAllMocks();
    db.close();
});

// ── queueSyncOp ────────────────────────────────────────────────────────────────

describe('queueSyncOp — userId field', () => {
    afterEach(async () => {
        // queueSyncOp fire-and-forgets a flush — wait so the in-flight network mock settles
        // before we close the DB and other tests start.
        await waitForPendingFlush();
    });

    it('writes an explicitly-passed userId onto the queued row', async () => {
        await queueSyncOp(db, {
            opType: 'create',
            entityType: 'item',
            entityId: 'q-item',
            snapshot: makeItem('q-item'),
            userId: 'explicit-user',
        });

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.userId).toBe('explicit-user');
    });

    it('falls back to the active account when no userId is passed', async () => {
        await db.put('accounts', {
            id: 'fallback-user',
            email: 'a@example.com',
            name: 'A',
            image: null,
            provider: 'google',
            addedAt: 1,
        });
        await db.put('activeAccount', { userId: 'fallback-user' }, 'active');

        await queueSyncOp(db, {
            opType: 'create',
            entityType: 'item',
            entityId: 'q-item-2',
            snapshot: makeItem('q-item-2'),
        });

        const ops = await db.getAll('syncOperations');
        expect(ops[0]?.userId).toBe('fallback-user');
    });

    it('throws when no userId is passed and no active account exists', async () => {
        // The global beforeEach seeds an active account for the rest of the file; clear it here
        // to assert the no-active-account error path of `queueSyncOp.resolveQueueUserId`.
        await db.delete('activeAccount', 'active');
        await expect(
            queueSyncOp(db, {
                opType: 'create',
                entityType: 'item',
                entityId: 'q-item-3',
                snapshot: makeItem('q-item-3'),
            }),
        ).rejects.toThrow('no active account');
    });
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
            userId: USER_ID,
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

    it('userIdFilter sends only ops belonging to that user; other users stay queued', async () => {
        await db.add('syncOperations', {
            userId: 'user-a',
            opType: 'create',
            entityType: 'item',
            entityId: 'a-item',
            queuedAt: dayjs().toISOString(),
            snapshot: makeItem('a-item'),
        });
        await db.add('syncOperations', {
            userId: 'user-b',
            opType: 'create',
            entityType: 'item',
            entityId: 'b-item',
            queuedAt: dayjs().toISOString(),
            snapshot: makeItem('b-item'),
        });

        await flushSyncQueue(db, { userIdFilter: 'user-a' });

        // Only user-a's op was pushed.
        const calls = vi.mocked(pushSyncOps).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0]?.[1].map((op) => op.entityId)).toEqual(['a-item']);

        // user-b's op is still queued.
        const remaining = await db.getAll('syncOperations');
        expect(remaining.map((op) => op.entityId)).toEqual(['b-item']);
    });

    it('omitted userIdFilter flushes every queued op (back-compat)', async () => {
        await db.add('syncOperations', {
            userId: 'user-a',
            opType: 'create',
            entityType: 'item',
            entityId: 'a-item',
            queuedAt: dayjs().toISOString(),
            snapshot: makeItem('a-item'),
        });
        await db.add('syncOperations', {
            userId: 'user-b',
            opType: 'create',
            entityType: 'item',
            entityId: 'b-item',
            queuedAt: dayjs().toISOString(),
            snapshot: makeItem('b-item'),
        });

        await flushSyncQueue(db);

        // Both ops were pushed (in a single batch in this case).
        const sent = vi.mocked(pushSyncOps).mock.calls.flatMap(([, ops]) => ops.map((op) => op.entityId));
        expect(sent.sort()).toEqual(['a-item', 'b-item']);
        expect(await db.getAll('syncOperations')).toHaveLength(0);
    });

    it('preserves the queue when the server returns an error', async () => {
        // Seed IDB directly (avoid queueSyncOp's fire-and-forget racing with the mock rejection).
        // Configure rejection before seeding so the fire-and-forget also uses the rejecting mock.
        vi.mocked(pushSyncOps).mockRejectedValueOnce(new Error('POST /sync/push 500'));
        await db.add('syncOperations', {
            userId: USER_ID,
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

        await pullFromServer(db, USER_ID);

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

        await pullFromServer(db, USER_ID);

        const item = await db.get('items', 'item-11');
        expect(item?.updatedTs).toBe('2025-06-01T00:00:00.000Z');
    });

    it('update op with older updatedTs keeps the local version (last-write-wins)', async () => {
        await db.put('items', makeItem('item-12', '2025-06-01T00:00:00.000Z'));

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'item', entityId: 'item-12', opType: 'update', snapshot: serverItem('item-12', '2025-01-01T00:00:00.000Z') }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db, USER_ID);

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

        await pullFromServer(db, USER_ID);

        const item = await db.get('items', 'item-13');
        expect(item).toBeUndefined();
    });

    // Regression: cross-account reassign emits a `delete` op under the source user. If the
    // orchestrator pulls the target user first, the local row already carries the new userId by
    // the time the source's delete arrives. Without the owner check, deleteItemById would blow
    // away the post-move row by `_id` and the entity would disappear from both views.
    it('delete op skips when local row belongs to a different user (post-reassign safety)', async () => {
        const reassignedItem = { ...makeItem('item-reassigned'), userId: 'user-target' };
        await db.put('items', reassignedItem);

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            // The source user (USER_ID) pulls the delete op, but the row has already moved to user-target.
            ops: [{ entityType: 'item', entityId: 'item-reassigned', opType: 'delete', snapshot: null }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db, USER_ID);

        const item = await db.get('items', 'item-reassigned');
        expect(item).toBeDefined();
        expect(item?.userId).toBe('user-target');
    });

    it('updates the per-user cursor to serverTs after a successful pull', async () => {
        const serverTs = '2025-09-01T12:00:00.000Z';
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs });

        await pullFromServer(db, USER_ID);

        const cursor = await db.get('syncCursors', USER_ID);
        expect(cursor?.lastSyncedTs).toBe(serverTs);
    });

    it('throws and does not update the per-user cursor when server returns non-200', async () => {
        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new Error('GET /sync/pull 503'));

        await expect(pullFromServer(db, USER_ID)).rejects.toThrow('GET /sync/pull 503');

        const cursor = await db.get('syncCursors', USER_ID);
        expect(cursor?.lastSyncedTs).toBe('1970-01-01T00:00:00.000Z');
    });

    it('per-user cursor independence: pulling for user A does not move user B’s cursor', async () => {
        await db.put('syncCursors', { userId: 'user-b', lastSyncedTs: '2024-01-01T00:00:00.000Z' });
        const serverTs = '2025-09-01T12:00:00.000Z';
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs });

        await pullFromServer(db, USER_ID);

        const cursorA = await db.get('syncCursors', USER_ID);
        const cursorB = await db.get('syncCursors', 'user-b');
        expect(cursorA?.lastSyncedTs).toBe(serverTs);
        expect(cursorB?.lastSyncedTs).toBe('2024-01-01T00:00:00.000Z');
    });

    it('same-user dedup: two simultaneous pullFromServer calls for the same user collapse into one fetch', async () => {
        // The session gate's job is to serialize *across* users. Same-user dedup is a separate
        // property — two SSE events arriving for the same user shouldn't fire two fetches.
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs: '2025-09-01T12:00:00.000Z' });
        const a = pullFromServer(db, USER_ID);
        const b = pullFromServer(db, USER_ID);
        await Promise.all([a, b]);
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(1);
    });

    it('bootstrap rejects when the active Better Auth session does not match the requested userId', async () => {
        // Symmetric guard for bootstrap: if a user has no cursor row, `pullOrBootstrap` reaches
        // for bootstrap, and that path must also refuse if the active session doesn't match.
        await expect(bootstrapFromServer(db, 'user-not-active')).rejects.toThrow(/active Better Auth session is/);
    });

    it('rejects when the active Better Auth session does not match the requested userId', async () => {
        // The IDB active account is USER_ID, but we ask for a pull on user-b. The guard must
        // refuse — pulling under the wrong session would attribute USER_ID's data to user-b.
        await db.put('syncCursors', { userId: 'user-b', lastSyncedTs: '1970-01-01T00:00:00.000Z' });
        await expect(pullFromServer(db, 'user-b')).rejects.toThrow(/active Better Auth session is/);
    });

    it('boundary-op regression: a pull for user B picks up an op at ts=T even if user A’s cursor was already at T', async () => {
        // Repro of the cross-account move bug at the helper level: two users on the same device,
        // user A's cursor is already at T (the server timestamp of the op user B is about to pull).
        // Under the old shared cursor + strict-$gt filter, user B would get nothing. Per-user
        // cursors mean user B pulls from user B's cursor (here epoch), independent of user A.
        const sharedTs = '2026-04-30T19:38:54.754Z';
        await db.put('syncCursors', { userId: USER_ID, lastSyncedTs: sharedTs });
        await db.put('syncCursors', { userId: 'user-b', lastSyncedTs: '1970-01-01T00:00:00.000Z' });
        // The pull-for-user-B requires the active session to be user-b — pivot IDB activeAccount
        // (in real flow `multiUserSync.syncOneUser` does this after `multiSession.setActive`).
        await db.put('accounts', { id: 'user-b', email: 'b@example.com', name: 'B', image: null, provider: 'google', addedAt: 1 });
        await db.put('activeAccount', { userId: 'user-b' }, 'active');

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [
                {
                    entityType: 'item',
                    entityId: 'b-boundary-item',
                    opType: 'create',
                    snapshot: { ...serverItem('b-boundary-item'), user: 'user-b', updatedTs: sharedTs },
                },
            ],
            serverTs: sharedTs,
        });

        await pullFromServer(db, 'user-b');

        // user-b picked up its boundary op despite user-a's cursor already being at sharedTs.
        expect(await db.get('items', 'b-boundary-item')).toBeDefined();
        const cursorB = await db.get('syncCursors', 'user-b');
        expect(cursorB?.lastSyncedTs).toBe(sharedTs);
    });
});

describe('pullFromServer — routine/person/workContext ops', () => {
    it('routine create op writes to IndexedDB', async () => {
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'routine', entityId: 'routine-1', opType: 'create', snapshot: serverRoutine('routine-1') }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db, USER_ID);

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

        await pullFromServer(db, USER_ID);

        expect(await db.get('routines', 'routine-2')).toBeUndefined();
    });

    it('person create op writes to IndexedDB', async () => {
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'person', entityId: 'person-1', opType: 'create', snapshot: serverPerson('person-1') }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db, USER_ID);

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

        await pullFromServer(db, USER_ID);

        expect(await db.get('people', 'person-2')).toBeUndefined();
    });

    it('workContext create op writes to IndexedDB', async () => {
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'workContext', entityId: 'wc-1', opType: 'create', snapshot: serverWorkContext('wc-1') }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db, USER_ID);

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

        await pullFromServer(db, USER_ID);

        expect(await db.get('workContexts', 'wc-2')).toBeUndefined();
    });
});

describe('pullFromServer — calendar routine sync', () => {
    function serverCalendarRoutine(id: string, rrule = 'FREQ=DAILY;INTERVAL=1'): Record<string, unknown> & { user: string } {
        return {
            _id: id,
            user: USER_ID,
            userId: USER_ID,
            title: 'Daily standup',
            routineType: 'calendar',
            rrule,
            template: {},
            active: true,
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            createdTs: '2025-01-01T00:00:00.000Z',
            updatedTs: '2025-06-01T00:00:00.000Z',
        };
    }

    // Item generation is owned by the originating device, not by devices receiving the routine
    // via sync. Running it here would race with the originator and produce duplicate items
    // (one set from regen, another from the originator's push).
    it('does NOT generate items when a calendar routine create arrives via sync', async () => {
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'routine', entityId: 'cal-r1', opType: 'create', snapshot: serverCalendarRoutine('cal-r1') }],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await pullFromServer(db, USER_ID);

        const items = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-r1');
        expect(items).toHaveLength(0);
    });

    it('does NOT generate items when a calendar routine update arrives via sync', async () => {
        await db.put('routines', serverCalendarRoutine('cal-r2') as unknown as StoredRoutine);
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'routine', entityId: 'cal-r2', opType: 'update', snapshot: serverCalendarRoutine('cal-r2') }],
            serverTs: '2025-06-02T00:00:00.000Z',
        });

        await pullFromServer(db, USER_ID);

        const items = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-r2');
        expect(items).toHaveLength(0);
    });
});

// ── bootstrapFromServer ────────────────────────────────────────────────────────

describe('bootstrapFromServer', () => {
    it('writes all entity types and sets the per-user cursor', async () => {
        const serverTs = '2025-07-01T00:00:00.000Z';
        vi.mocked(fetchBootstrap).mockResolvedValueOnce({
            items: [serverItem('item-b1')],
            routines: [serverRoutine('routine-b1')],
            people: [serverPerson('person-b1')],
            workContexts: [serverWorkContext('wc-b1')],
            serverTs,
        });

        await bootstrapFromServer(db, USER_ID);

        expect(await db.get('items', 'item-b1')).toBeDefined();
        expect(await db.get('routines', 'routine-b1')).toBeDefined();
        expect(await db.get('people', 'person-b1')).toBeDefined();
        expect(await db.get('workContexts', 'wc-b1')).toBeDefined();

        const cursor = await db.get('syncCursors', USER_ID);
        expect(cursor?.lastSyncedTs).toBe(serverTs);
    });

    it('remaps user → userId on all entities', async () => {
        vi.mocked(fetchBootstrap).mockResolvedValueOnce({
            items: [serverItem('item-b2')],
            routines: [],
            people: [],
            workContexts: [],
            serverTs: '2025-07-01T00:00:00.000Z',
        });

        await bootstrapFromServer(db, USER_ID);

        const item = await db.get('items', 'item-b2');
        expect(item?.userId).toBe(USER_ID);
        expect((item as unknown as { user?: string } | undefined)?.user).toBeUndefined();
    });

    it('throws when the server returns non-200, writing nothing', async () => {
        vi.mocked(fetchBootstrap).mockRejectedValueOnce(new Error('GET /sync/bootstrap 401'));

        await expect(bootstrapFromServer(db, USER_ID)).rejects.toThrow('GET /sync/bootstrap 401');

        const items = await db.getAll('items');
        expect(items).toHaveLength(0);
    });
});

// Regression for the cross-account reassign hang: a stalled gate task (e.g. session pivot
// behind a slow Google API call) used to wedge every queued caller indefinitely. The gate now
// auto-releases after a deadline so queued callers proceed even when one task never settles.
describe('withSessionGate — self-healing timeout', () => {
    afterEach(() => {
        // Reset to production default so cross-test gate state doesn't leak.
        setSessionGateTimeoutMs(10_000);
    });

    it('releases the gate after the deadline so queued tasks proceed even if one hangs', async () => {
        setSessionGateTimeoutMs(20);
        // Hang task: a promise that never settles.
        const hung = withSessionGate(() => new Promise<string>(() => {}));
        // Queued task: should run after the gate auto-releases.
        const queuedRan = vi.fn(() => Promise.resolve('queued-result'));
        const queuedResult = withSessionGate(queuedRan);
        // Wait past the deadline.
        await new Promise((r) => setTimeout(r, 60));
        await expect(queuedResult).resolves.toBe('queued-result');
        expect(queuedRan).toHaveBeenCalledTimes(1);
        // The hung task's promise is still pending — its caller awaits it independently.
        // We don't await it here (it never settles); the test ends fine because it's not the
        // gate's responsibility to settle it.
        void hung;
    });

    it('logs a warning when the gate releases due to timeout', async () => {
        setSessionGateTimeoutMs(20);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const hung = withSessionGate(() => new Promise<string>(() => {}));
        await new Promise((r) => setTimeout(r, 60));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session gate task exceeded'));
        warnSpy.mockRestore();
        void hung;
    });

    it('does not warn or release early when the task settles within the deadline', async () => {
        setSessionGateTimeoutMs(200);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await withSessionGate(() => Promise.resolve('fast'));
        expect(result).toBe('fast');
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('propagates task rejection to the caller without poisoning subsequent gate tasks', async () => {
        setSessionGateTimeoutMs(200);
        const failed = withSessionGate(() => Promise.reject(new Error('task boom')));
        await expect(failed).rejects.toThrow('task boom');
        // Next task should run normally — the rejection released the gate via finally().
        const next = await withSessionGate(() => Promise.resolve('after-reject'));
        expect(next).toBe('after-reject');
    });
});
