import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted before imports by Vitest's transformer, so syncHelpers.ts's own
// import of '#api/syncClient' is also intercepted — no resolve.conditions config needed.
vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

// Mock the multiUserSync module so the cross-account dispatch tests can observe whether
// `syncSingleUser` was called without driving the real Better Auth multi-session pivot.
vi.mock('../db/multiUserSync', () => ({
    syncSingleUser: vi.fn().mockResolvedValue(undefined),
}));

import dayjs from 'dayjs';
import { fetchBootstrap, fetchSyncOps, pushSyncOps } from '#api/syncClient';
import { SYNC_APPLY_LOCK } from '../db/crossContextLock';
import { syncSingleUser } from '../db/multiUserSync';
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
    await db.put('syncCursors', { userId: USER_ID, lastSyncedTs: '1970-01-01T00:00:00.000Z', lastSyncedId: '' });
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

/**
 * Polls until `predicate()` returns true, with a small timeout. Used by the dispatch tests below
 * to wait on the fire-and-forget `dispatchOpFlush` chain without exposing internal promise hooks
 * — we observe the side effects (syncSingleUser called, pushSyncOps called) instead.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('waitFor: predicate did not become true before deadline');
        }
        await new Promise((r) => setTimeout(r, 5));
    }
}

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

// ── queueSyncOp — immediate flush dispatch (cross-account routing) ─────────────
// Ops queued under a userId that differs from the currently-active Better Auth session must
// route through `syncSingleUser`, which pivots the cookie before flushing — otherwise the
// server's misroute guard rejects the push with a 400.

describe('queueSyncOp — immediate flush dispatch', () => {
    afterEach(async () => {
        await waitForPendingFlush();
    });

    it('queues an op and immediately flushes via flushSyncQueue with userIdFilter when the op userId matches the active account', async () => {
        // Active account is USER_ID (seeded in the global beforeEach). Pre-seed a second user's
        // queued op so we can assert the dispatch's `userIdFilter` actually scoped the flush —
        // otherwise the test would still pass even if a future regression dropped the filter.
        await db.add('syncOperations', {
            userId: 'user-other',
            opType: 'create',
            entityType: 'item',
            entityId: 'other-op',
            queuedAt: dayjs().toISOString(),
            snapshot: { ...makeItem('other-op'), userId: 'user-other' },
        });

        await queueSyncOp(db, {
            opType: 'update',
            entityType: 'item',
            entityId: 'i-1',
            snapshot: makeItem('i-1'),
            userId: USER_ID,
        });

        await waitFor(() => vi.mocked(pushSyncOps).mock.calls.length > 0);

        const calls = vi.mocked(pushSyncOps).mock.calls;
        expect(calls).toHaveLength(1);
        // Only the active user's op landed on the wire — `user-other`'s op was filtered out by the
        // `userIdFilter` arg `dispatchOpFlush` passes on the same-account branch. Without that
        // filter, the unscoped flush would have pushed both ops under USER_ID's session and
        // tripped the server's misroute guard.
        expect(calls[0]?.[1].map((op) => op.entityId)).toEqual(['i-1']);
        // The `user-other` op is still queued, untouched.
        const remaining = await db.getAll('syncOperations');
        expect(remaining.map((op) => op.entityId)).toContain('other-op');
        // Same-account fast path must not detour through the multi-session orchestrator —
        // that would acquire the gate unnecessarily and serialize ops behind any in-flight pivot.
        expect(vi.mocked(syncSingleUser)).not.toHaveBeenCalled();
    });

    it('routes the immediate flush through syncSingleUser when the op userId differs from the active account', async () => {
        // Active account is USER_ID; queue an op for user-b.
        await queueSyncOp(db, {
            opType: 'update',
            entityType: 'item',
            entityId: 'i-cross',
            snapshot: { ...makeItem('i-cross'), userId: 'user-b' },
            userId: 'user-b',
        });

        await waitFor(() => vi.mocked(syncSingleUser).mock.calls.length > 0);

        expect(vi.mocked(syncSingleUser)).toHaveBeenCalledWith(db, 'user-b');
        // The mocked syncSingleUser resolves without ever calling pushSyncOps. The unscoped
        // flushSyncQueue path also must not fire — that would attempt the push under USER_ID's
        // session and trip the server's misroute guard.
        expect(vi.mocked(pushSyncOps)).not.toHaveBeenCalled();
    });

    it('routes through syncSingleUser when no active account exists', async () => {
        // Drop the active-account row but keep the explicit userId on the queued op. A null
        // active account is treated like a mismatch — same conservative dispatch.
        await db.delete('activeAccount', 'active');

        await queueSyncOp(db, {
            opType: 'update',
            entityType: 'item',
            entityId: 'i-no-active',
            snapshot: { ...makeItem('i-no-active'), userId: 'user-b' },
            userId: 'user-b',
        });

        await waitFor(() => vi.mocked(syncSingleUser).mock.calls.length > 0);

        expect(vi.mocked(syncSingleUser)).toHaveBeenCalledWith(db, 'user-b');
        expect(vi.mocked(pushSyncOps)).not.toHaveBeenCalled();
    });

    it('swallows dispatch rejection with a console.warn — queueSyncOp resolves regardless', async () => {
        // The fire-and-forget `void dispatchOpFlush(...).catch(...)` contract: if the dispatch
        // rejects (e.g. `syncSingleUser` throwing because no multi-session entry exists for the
        // queued userId), the rejection is logged and swallowed — `queueSyncOp` itself must not
        // throw, because callers (UI mutations) would surface the error to the user even though
        // the op is safely persisted in IDB and will retry on the next mount.
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(syncSingleUser).mockRejectedValueOnce(new Error('pivot failed'));

        await expect(
            queueSyncOp(db, {
                opType: 'update',
                entityType: 'item',
                entityId: 'i-reject',
                snapshot: { ...makeItem('i-reject'), userId: 'user-b' },
                userId: 'user-b',
            }),
        ).resolves.toBeUndefined();

        await waitFor(() => warnSpy.mock.calls.length > 0);
        expect(warnSpy).toHaveBeenCalledWith('Failed to flush sync queue after adding op', expect.any(Error));
        warnSpy.mockRestore();
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
            serverId: '',
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
            serverId: '',
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
            serverId: '',
        });

        await pullFromServer(db, USER_ID);

        const item = await db.get('items', 'item-12');
        // Local is newer — must not be overwritten
        expect(item?.updatedTs).toBe('2025-06-01T00:00:00.000Z');
    });

    it('update op with EQUAL updatedTs replaces the local version (tie goes to the incoming snapshot)', async () => {
        // Pins the `<=` in incomingWinsLww (mirrored server-side in applyEntityOp.ts): ties
        // converge across devices because every device replays the same ordered op log, so the
        // final op of a tie group wins everywhere.
        const tieTs = '2025-06-01T00:00:00.000Z';
        await db.put('items', { ...makeItem('item-tie', tieTs), title: 'local copy' });

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'item', entityId: 'item-tie', opType: 'update', snapshot: { ...serverItem('item-tie', tieTs), title: 'server copy' } }],
            serverTs: tieTs,
            serverId: '',
        });

        await pullFromServer(db, USER_ID);

        const item = await db.get('items', 'item-tie');
        expect(item?.title).toBe('server copy');
    });

    it('delete op removes the item from IndexedDB', async () => {
        await db.put('items', makeItem('item-13'));

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'item', entityId: 'item-13', opType: 'delete', snapshot: null }],
            serverTs: '2025-06-01T00:00:00.000Z',
            serverId: '',
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
            serverId: '',
        });

        await pullFromServer(db, USER_ID);

        const item = await db.get('items', 'item-reassigned');
        expect(item).toBeDefined();
        expect(item?.userId).toBe('user-target');
    });

    // Pins the transactional-apply layer itself (the Web Lock tests below pin the OTHER layer).
    // IDB only guarantees the owner/LWW check is atomic with the write it guards when both run in
    // the SAME readwrite transaction — a regression to separate get-then-write calls necessarily
    // opens more than one items transaction per op (idb's db.get/db.put route through
    // db.transaction too), which is exactly what this counts.
    describe('apply atomicity — one readwrite transaction per op', () => {
        function countItemsTransactions(): { calls: Array<{ store: unknown; mode: unknown }> } {
            const recorded: Array<{ store: unknown; mode: unknown }> = [];
            const originalTransaction = db.transaction.bind(db);
            vi.spyOn(db, 'transaction').mockImplementation(((...args: Parameters<typeof db.transaction>) => {
                const [store, mode] = args;
                if (store === 'items' || (Array.isArray(store) && store.includes('items'))) {
                    recorded.push({ store, mode });
                }
                return originalTransaction(...args);
            }) as typeof db.transaction);
            return { calls: recorded };
        }

        it('a delete op does its owner check and delete in one readwrite items transaction', async () => {
            await db.put('items', makeItem('item-atomic-delete'));
            const counter = countItemsTransactions();
            vi.mocked(fetchSyncOps).mockResolvedValueOnce({
                ops: [{ entityType: 'item', entityId: 'item-atomic-delete', opType: 'delete', snapshot: null }],
                serverTs: '2025-06-01T00:00:00.000Z',
                serverId: '',
            });

            await pullFromServer(db, USER_ID);

            // Snapshot before the verification reads below add their own (readonly) transactions.
            const applyCalls = [...counter.calls];
            expect(await db.get('items', 'item-atomic-delete')).toBeUndefined();
            expect(applyCalls).toEqual([{ store: 'items', mode: 'readwrite' }]);
        });

        it('an update op does its LWW check and put in one readwrite items transaction', async () => {
            await db.put('items', makeItem('item-atomic-update', '2025-01-01T00:00:00.000Z'));
            const counter = countItemsTransactions();
            vi.mocked(fetchSyncOps).mockResolvedValueOnce({
                ops: [
                    {
                        entityType: 'item',
                        entityId: 'item-atomic-update',
                        opType: 'update',
                        snapshot: serverItem('item-atomic-update', '2025-02-01T00:00:00.000Z'),
                    },
                ],
                serverTs: '2025-06-01T00:00:00.000Z',
                serverId: '',
            });

            await pullFromServer(db, USER_ID);

            const applyCalls = [...counter.calls];
            expect((await db.get('items', 'item-atomic-update'))?.updatedTs).toBe('2025-02-01T00:00:00.000Z');
            expect(applyCalls).toEqual([{ store: 'items', mode: 'readwrite' }]);
        });
    });

    // The server clamps future updatedTs on write, but its correcting echo is OLDER than the
    // poisoned local row — plain LWW can never repair the device that created the poison. These
    // pin the client-side escape hatch (and its tolerance, so normal skew never trips it).
    describe('poisoned-watermark self-heal', () => {
        it('an older inbound snapshot replaces a local row stamped far in the future', async () => {
            const poisonedTs = dayjs().add(2, 'hour').toISOString();
            await db.put('items', { ...makeItem('item-poisoned', poisonedTs), title: 'stale poisoned state' });
            const correctedTs = dayjs().toISOString();
            vi.mocked(fetchSyncOps).mockResolvedValueOnce({
                ops: [{ entityType: 'item', entityId: 'item-poisoned', opType: 'update', snapshot: serverItem('item-poisoned', correctedTs) }],
                serverTs: '2025-06-01T00:00:00.000Z',
                serverId: '',
            });

            await pullFromServer(db, USER_ID);

            const item = await db.get('items', 'item-poisoned');
            expect(item?.updatedTs).toBe(correctedTs);
            expect(item?.title).toBe('Item');
        });

        it('ordinary clock skew within the tolerance still loses LWW (no false self-heal)', async () => {
            const slightlyAheadTs = dayjs().add(1, 'minute').toISOString();
            await db.put('items', { ...makeItem('item-skewed', slightlyAheadTs), title: 'newer local edit' });
            vi.mocked(fetchSyncOps).mockResolvedValueOnce({
                ops: [
                    {
                        entityType: 'item',
                        entityId: 'item-skewed',
                        opType: 'update',
                        snapshot: serverItem('item-skewed', dayjs().subtract(1, 'hour').toISOString()),
                    },
                ],
                serverTs: '2025-06-01T00:00:00.000Z',
                serverId: '',
            });

            await pullFromServer(db, USER_ID);

            const item = await db.get('items', 'item-skewed');
            expect(item?.title).toBe('newer local edit');
            expect(item?.updatedTs).toBe(slightlyAheadTs);
        });
    });

    it('never rewinds the cursor when the response boundary is older than the stored cursor', async () => {
        // The fetch runs outside the cross-context apply lock, so another context pulling the SAME
        // user can advance the cursor while this response is in flight. Re-applying the older op
        // range is harmless (idempotent LWW), but writing its boundary would rewind the cursor and
        // re-fetch that range on every later pull. Simulate the other context inside the fetch mock.
        await db.put('syncCursors', { userId: USER_ID, lastSyncedTs: '2025-01-01T00:00:00.000Z', lastSyncedId: '' });
        vi.mocked(fetchSyncOps).mockImplementationOnce(async () => {
            await db.put('syncCursors', { userId: USER_ID, lastSyncedTs: '2025-09-01T00:00:00.000Z', lastSyncedId: 'op-newer' });
            return { ops: [], serverTs: '2025-03-01T00:00:00.000Z', serverId: 'op-older' };
        });

        await pullFromServer(db, USER_ID);

        const cursor = await db.get('syncCursors', USER_ID);
        expect(cursor?.lastSyncedTs).toBe('2025-09-01T00:00:00.000Z');
        expect(cursor?.lastSyncedId).toBe('op-newer');
    });

    // The Web Lock is the cross-context half of the apply-race fix (module guards don't reach the
    // Service Worker); these wiring tests pin that pull AND bootstrap actually request it, since a
    // silently-unwrapped path would revert to unserialized applies with no test noticing.
    describe('cross-context apply lock wiring', () => {
        function installRecordingLocks(): string[] {
            const names: string[] = [];
            const request = vi.fn((name: string, cb: () => Promise<unknown>) => {
                names.push(name);
                return cb();
            });
            Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
            return names;
        }

        afterEach(() => {
            Reflect.deleteProperty(navigator, 'locks');
        });

        it('doPull runs under the gtd-sync-apply Web Lock', async () => {
            const names = installRecordingLocks();
            vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs: '2025-06-01T00:00:00.000Z', serverId: '' });

            await pullFromServer(db, USER_ID);

            expect(names).toContain(SYNC_APPLY_LOCK);
        });

        it('bootstrap runs under the gtd-sync-apply Web Lock', async () => {
            const names = installRecordingLocks();
            vi.mocked(fetchBootstrap).mockResolvedValueOnce({
                items: [],
                routines: [],
                people: [],
                workContexts: [],
                serverTs: '2025-06-01T00:00:00.000Z',
                serverId: '',
            });

            await bootstrapFromServer(db, USER_ID);

            expect(names).toContain(SYNC_APPLY_LOCK);
        });
    });

    it('advances the per-user compound cursor to (serverTs, serverId) after a successful pull', async () => {
        const serverTs = '2025-09-01T12:00:00.000Z';
        const serverId = 'op-9f29';
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs, serverId });

        await pullFromServer(db, USER_ID);

        const cursor = await db.get('syncCursors', USER_ID);
        expect(cursor?.lastSyncedTs).toBe(serverTs);
        // The id component must advance too — otherwise the next pull's sinceId would stay '' and
        // re-fetch the whole serverTs ms on every pull.
        expect(cursor?.lastSyncedId).toBe(serverId);
    });

    it('round-trip: the next pull sends the previously-stored serverId as sinceId', async () => {
        // Closes the client cursor loop: after a pull advances to (T1, id1), the *following* pull must
        // pass id1 as sinceId/ackedId so the server resumes strictly after that op — not re-scan T1's ms.
        const t1 = '2025-09-01T12:00:00.000Z';
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs: t1, serverId: 'op-1' });
        await pullFromServer(db, USER_ID);

        const t2 = '2025-09-02T12:00:00.000Z';
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs: t2, serverId: 'op-2' });
        await pullFromServer(db, USER_ID);

        // Second call resumes from the first pull's (t1, op-1) for both the since and ack pairs.
        expect(vi.mocked(fetchSyncOps)).toHaveBeenLastCalledWith(t1, 'op-1', t1, 'op-1', expect.any(String));
    });

    it('empty-id boundary re-delivery is idempotent: re-applying ops creates no duplicate', async () => {
        // After migration/old-server fallback the cursor id is '', so the server re-delivers ops at
        // the boundary ms. Re-applying a create the device already has must be a no-op (LWW), not a
        // duplicate row. This guards the safety of leaning to '' over the MAX_OP_ID sentinel.
        const updatedTs = '2025-05-01T00:00:00.000Z';
        const op = { entityType: 'item' as const, entityId: 'dup-item', opType: 'create' as const, snapshot: serverItem('dup-item', updatedTs) };
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [op], serverTs: updatedTs, serverId: 'op-a' });
        await pullFromServer(db, USER_ID);

        // Re-deliver the same op (boundary re-check) — LWW keeps a single row, unchanged.
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [op], serverTs: updatedTs, serverId: 'op-a' });
        await pullFromServer(db, USER_ID);

        const all = await db.getAll('items');
        const matching = all.filter((i) => i._id === 'dup-item');
        expect(matching).toHaveLength(1);
        const [only] = matching;
        if (!only) throw new Error('expected the re-delivered item to be present');
        expect(only.updatedTs).toBe(updatedTs);
    });

    it('throws and does not update the per-user cursor when server returns non-200', async () => {
        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new Error('GET /sync/pull 503'));

        await expect(pullFromServer(db, USER_ID)).rejects.toThrow('GET /sync/pull 503');

        const cursor = await db.get('syncCursors', USER_ID);
        expect(cursor?.lastSyncedTs).toBe('1970-01-01T00:00:00.000Z');
    });

    it('per-user cursor independence: pulling for user A does not move user B’s cursor', async () => {
        await db.put('syncCursors', { userId: 'user-b', lastSyncedTs: '2024-01-01T00:00:00.000Z', lastSyncedId: '' });
        const serverTs = '2025-09-01T12:00:00.000Z';
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs, serverId: '' });

        await pullFromServer(db, USER_ID);

        const cursorA = await db.get('syncCursors', USER_ID);
        const cursorB = await db.get('syncCursors', 'user-b');
        expect(cursorA?.lastSyncedTs).toBe(serverTs);
        expect(cursorB?.lastSyncedTs).toBe('2024-01-01T00:00:00.000Z');
    });

    it('same-user dedup: two simultaneous pullFromServer calls for the same user collapse into one fetch', async () => {
        // The session gate's job is to serialize *across* users. Same-user dedup is a separate
        // property — two SSE events arriving for the same user shouldn't fire two fetches.
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs: '2025-09-01T12:00:00.000Z', serverId: '' });
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
        await db.put('syncCursors', { userId: 'user-b', lastSyncedTs: '1970-01-01T00:00:00.000Z', lastSyncedId: '' });
        await expect(pullFromServer(db, 'user-b')).rejects.toThrow(/active Better Auth session is/);
    });

    it('boundary-op regression: a pull for user B picks up an op at ts=T even if user A’s cursor was already at T', async () => {
        // Repro of the cross-account move bug at the helper level: two users on the same device,
        // user A's cursor is already at T (the server timestamp of the op user B is about to pull).
        // Under the old shared cursor + strict-$gt filter, user B would get nothing. Per-user
        // cursors mean user B pulls from user B's cursor (here epoch), independent of user A.
        const sharedTs = '2026-04-30T19:38:54.754Z';
        await db.put('syncCursors', { userId: USER_ID, lastSyncedTs: sharedTs, lastSyncedId: '' });
        await db.put('syncCursors', { userId: 'user-b', lastSyncedTs: '1970-01-01T00:00:00.000Z', lastSyncedId: '' });
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
            serverId: '',
        });

        await pullFromServer(db, 'user-b');

        // user-b picked up its boundary op despite user-a's cursor already being at sharedTs.
        expect(await db.get('items', 'b-boundary-item')).toBeDefined();
        const cursorB = await db.get('syncCursors', 'user-b');
        expect(cursorB?.lastSyncedTs).toBe(sharedTs);
    });

    // Documents the invariant from the explicit-ack protocol (plans/write-up-a-plan-zesty-pebble.md):
    // the IDB cursor doubles as both `since` (what ops to fetch) and `ackedTs` (what the device has
    // durably committed). Together they prevent the server from purging ops the client never wrote.
    it('passes the IDB cursor as both since and ackedTs (explicit-ack protocol)', async () => {
        const cursor = '2026-01-15T00:00:00.000Z';
        await db.put('syncCursors', { userId: USER_ID, lastSyncedTs: cursor, lastSyncedId: '' });

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs: cursor, serverId: '' });

        await pullFromServer(db, USER_ID);

        // (since, sinceId, ackedTs, ackedId, deviceId) — the since pair and ack pair are equal in
        // steady state. sinceId/ackedId are '' here because the seeded cursor has no id component.
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledWith(cursor, '', cursor, '', expect.any(String));
    });

    it('lost-response replay: a retry after a failed pull re-sends the same ackedTs (cursor never advanced)', async () => {
        // Pre-fix: the server would have set lastSyncedTs := serverTs on the first call, purged
        // the op, and the retry would return zero rows. Under explicit-ack the client keeps sending
        // ackedTs = its IDB cursor; the floor never advances past unacknowledged ops.
        const initialCursor = '1970-01-01T00:00:00.000Z';
        await db.put('syncCursors', { userId: USER_ID, lastSyncedTs: initialCursor, lastSyncedId: '' });

        // First call: server returns ops but applyServerOp throws — cursor stays at epoch.
        const op = { entityType: 'item' as const, entityId: 'lost-item', opType: 'create' as const, snapshot: serverItem('lost-item') };
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [op], serverTs: '2026-02-01T00:00:00.000Z', serverId: '' });
        // Force the first items-store APPLY to fail so setSyncCursor never runs. applyEntityOp
        // opens one readwrite transaction per op (the atomic read-check-write), so the injection
        // point is db.transaction — after the once-mock is consumed the spy falls back to the real
        // implementation, letting the retry and the cursor write succeed.
        // Flag rather than mockImplementationOnce: idb's convenience helpers (db.get etc.) also
        // route through db.transaction, so a once-mock would be consumed by an earlier unrelated
        // store before the items apply ever runs.
        const originalTransaction = db.transaction.bind(db);
        let injectedFailure = false;
        vi.spyOn(db, 'transaction').mockImplementation(((...args: Parameters<typeof db.transaction>) => {
            if (!injectedFailure && args[0] === 'items') {
                injectedFailure = true;
                throw new Error('IDB transaction aborted');
            }
            return originalTransaction(...args);
        }) as typeof db.transaction);

        await expect(pullFromServer(db, USER_ID)).rejects.toThrow('IDB transaction aborted');

        const cursorAfterFailure = await db.get('syncCursors', USER_ID);
        expect(cursorAfterFailure?.lastSyncedTs).toBe(initialCursor);

        // Retry: the same op is still in the server's log; the client sends ackedTs=epoch again.
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [op], serverTs: '2026-02-01T00:00:00.000Z', serverId: '' });
        await pullFromServer(db, USER_ID);

        expect(vi.mocked(fetchSyncOps)).toHaveBeenLastCalledWith(initialCursor, '', initialCursor, '', expect.any(String));
        expect(await db.get('items', 'lost-item')).toBeDefined();
    });
});

describe('pullFromServer — routine/person/workContext ops', () => {
    it('routine create op writes to IndexedDB', async () => {
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'routine', entityId: 'routine-1', opType: 'create', snapshot: serverRoutine('routine-1') }],
            serverTs: '2025-06-01T00:00:00.000Z',
            serverId: '',
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
            serverId: '',
        });

        await pullFromServer(db, USER_ID);

        expect(await db.get('routines', 'routine-2')).toBeUndefined();
    });

    it('person create op writes to IndexedDB', async () => {
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'person', entityId: 'person-1', opType: 'create', snapshot: serverPerson('person-1') }],
            serverTs: '2025-06-01T00:00:00.000Z',
            serverId: '',
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
            serverId: '',
        });

        await pullFromServer(db, USER_ID);

        expect(await db.get('people', 'person-2')).toBeUndefined();
    });

    it('workContext create op writes to IndexedDB', async () => {
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'workContext', entityId: 'wc-1', opType: 'create', snapshot: serverWorkContext('wc-1') }],
            serverTs: '2025-06-01T00:00:00.000Z',
            serverId: '',
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
            serverId: '',
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
            serverId: '',
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
            serverId: '',
        });

        await pullFromServer(db, USER_ID);

        const items = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-r2');
        expect(items).toHaveLength(0);
    });
});

// ── bootstrapFromServer ────────────────────────────────────────────────────────

describe('bootstrapFromServer', () => {
    it('writes all entity types and sets the per-user compound cursor (ts + serverId)', async () => {
        // Current servers return a held-back boundary with serverId '' (re-check the boundary ms on
        // the first pull) — the cursor must store '' verbatim, never widen it to a skip-the-ms
        // sentinel like the legacy MAX_OP_ID.
        const serverTs = '2025-07-01T00:00:00.000Z';
        vi.mocked(fetchBootstrap).mockResolvedValueOnce({
            items: [serverItem('item-b1')],
            routines: [serverRoutine('routine-b1')],
            people: [serverPerson('person-b1')],
            workContexts: [serverWorkContext('wc-b1')],
            serverTs,
            serverId: '',
        });

        await bootstrapFromServer(db, USER_ID);

        expect(await db.get('items', 'item-b1')).toBeDefined();
        expect(await db.get('routines', 'routine-b1')).toBeDefined();
        expect(await db.get('people', 'person-b1')).toBeDefined();
        expect(await db.get('workContexts', 'wc-b1')).toBeDefined();

        const cursor = await db.get('syncCursors', USER_ID);
        expect(cursor?.lastSyncedTs).toBe(serverTs);
        // The '' id is stored verbatim so the first incremental pull re-checks the boundary ms
        // (idempotent re-delivery) instead of skipping late-committing ops there.
        expect(cursor?.lastSyncedId).toBe('');
    });

    it('remaps user → userId on all entities', async () => {
        vi.mocked(fetchBootstrap).mockResolvedValueOnce({
            items: [serverItem('item-b2')],
            routines: [],
            people: [],
            workContexts: [],
            serverTs: '2025-07-01T00:00:00.000Z',
            serverId: '',
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
