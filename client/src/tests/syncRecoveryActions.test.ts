import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

vi.mock('../lib/authClient', () => {
    const setActive = vi.fn(async () => undefined);
    const listDeviceSessions = vi.fn(async () => ({
        data: [
            { user: { id: 'user-a' }, session: { token: 'token-a' } },
            { user: { id: 'user-b' }, session: { token: 'token-b' } },
        ],
    }));
    return {
        authClient: {
            multiSession: { setActive, listDeviceSessions },
        },
    };
});

import dayjs from 'dayjs';
import { fetchBootstrap, pushSyncOps } from '#api/syncClient';
import { getSyncRecoveryState, resetSyncRecoveryStoreForTests, setSyncRecoveryState } from '../contexts/syncRecoveryStore';
import { discardQueuedChangesAndBootstrap, pushQueuedChangesAndBootstrap, retryBootstrap } from '../db/syncRecoveryActions';
import { authClient } from '../lib/authClient';
import type { MyDB, StoredItem, SyncOperation } from '../types/MyDB';
import { openTestDB } from './openTestDB';

let db: IDBPDatabase<MyDB>;

function makeItem(id: string, userId: string, title: string): StoredItem {
    return { _id: id, userId, status: 'inbox', title, createdTs: '2025-01-01T00:00:00.000Z', updatedTs: '2025-01-01T00:00:00.000Z' };
}

function makeQueuedOp(entityId: string, userId: string, title: string): SyncOperation {
    return {
        userId,
        opType: 'create',
        entityType: 'item',
        entityId,
        queuedAt: dayjs().toISOString(),
        snapshot: makeItem(entityId, userId, title),
    };
}

const EMPTY_BOOTSTRAP = {
    items: [],
    routines: [],
    people: [],
    workContexts: [],
    serverTs: '2025-06-01T00:00:00.000Z',
    serverId: '',
};

beforeEach(async () => {
    db = await openTestDB();
    await db.put('deviceMeta', { _id: 'local', deviceId: 'dev-test', flushingTs: null });
    await db.put('accounts', { id: 'user-a', email: 'a@example.com', name: 'A', image: null, provider: 'google', addedAt: 1 });
    await db.put('accounts', { id: 'user-b', email: 'b@example.com', name: 'B', image: null, provider: 'google', addedAt: 2 });
    await db.put('activeAccount', { userId: 'user-a' }, 'active');
    vi.mocked(fetchBootstrap).mockResolvedValue(EMPTY_BOOTSTRAP);
});

afterEach(() => {
    vi.clearAllMocks();
    resetSyncRecoveryStoreForTests();
    db.close();
});

describe('pushQueuedChangesAndBootstrap', () => {
    it('flushes the user queue then bootstraps and unlocks', async () => {
        await db.add('syncOperations', makeQueuedOp('op-1', 'user-a', 'Buy milk'));
        setSyncRecoveryState({ phase: 'case2Choice', userId: 'user-a', queuedOpCount: 1 });

        await pushQueuedChangesAndBootstrap(db, 'user-a');

        expect(vi.mocked(pushSyncOps)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetchBootstrap)).toHaveBeenCalledTimes(1);
        expect(getSyncRecoveryState()).toEqual({ phase: 'idle' });
        expect(await db.getAll('syncOperations')).toHaveLength(0);
        // The bootstrap re-established the per-user cursor.
        const cursor = await db.get('syncCursors', 'user-a');
        expect(cursor?.lastSyncedTs).toBe(EMPTY_BOOTSTRAP.serverTs);
    });

    it('HALTS before bootstrap when the flush fails, reporting which ops were being sent', async () => {
        await db.add('syncOperations', makeQueuedOp('op-1', 'user-a', 'Buy milk'));
        await db.add('syncOperations', makeQueuedOp('op-2', 'user-a', 'Call bank'));
        setSyncRecoveryState({ phase: 'case2Choice', userId: 'user-a', queuedOpCount: 2 });
        vi.mocked(pushSyncOps).mockRejectedValueOnce(new Error('POST /sync/push 400'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await pushQueuedChangesAndBootstrap(db, 'user-a');

        // NEVER auto-proceed past a failed flush — bootstrapping would silently drop local changes.
        expect(vi.mocked(fetchBootstrap)).not.toHaveBeenCalled();
        expect(getSyncRecoveryState()).toEqual({
            phase: 'flushFailed',
            userId: 'user-a',
            queuedOpCount: 2,
            errorMessage: 'POST /sync/push 400',
            failedOpSummaries: ['create item: "Buy milk"', 'create item: "Call bank"'],
        });
        // The queue is intact for retry / export / explicit discard.
        expect(await db.getAll('syncOperations')).toHaveLength(2);
        errorSpy.mockRestore();
    });

    it('retrying after a flush failure completes the push + bootstrap', async () => {
        await db.add('syncOperations', makeQueuedOp('op-1', 'user-a', 'Buy milk'));
        vi.mocked(pushSyncOps).mockRejectedValueOnce(new Error('POST /sync/push 400'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await pushQueuedChangesAndBootstrap(db, 'user-a');
        expect(getSyncRecoveryState().phase).toBe('flushFailed');

        // Retry: the default pushSyncOps mock resolves this time.
        await pushQueuedChangesAndBootstrap(db, 'user-a');

        expect(vi.mocked(fetchBootstrap)).toHaveBeenCalledTimes(1);
        expect(getSyncRecoveryState()).toEqual({ phase: 'idle' });
        expect(await db.getAll('syncOperations')).toHaveLength(0);
        errorSpy.mockRestore();
    });

    it('a bootstrap failure after a successful flush lands in bootstrapFailed', async () => {
        await db.add('syncOperations', makeQueuedOp('op-1', 'user-a', 'Buy milk'));
        vi.mocked(fetchBootstrap).mockRejectedValueOnce(new Error('GET /sync/bootstrap 502'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await pushQueuedChangesAndBootstrap(db, 'user-a');

        expect(getSyncRecoveryState()).toEqual({ phase: 'bootstrapFailed', userId: 'user-a', errorMessage: 'GET /sync/bootstrap 502' });
        errorSpy.mockRestore();
    });
});

describe('discardQueuedChangesAndBootstrap', () => {
    it("deletes exactly the recovering user's queued ops — another user's ops survive — then bootstraps", async () => {
        await db.add('syncOperations', makeQueuedOp('op-a1', 'user-a', 'Buy milk'));
        await db.add('syncOperations', makeQueuedOp('op-a2', 'user-a', 'Call bank'));
        await db.add('syncOperations', makeQueuedOp('op-b1', 'user-b', 'Other account change'));
        setSyncRecoveryState({ phase: 'case2Choice', userId: 'user-a', queuedOpCount: 2 });

        await discardQueuedChangesAndBootstrap(db, 'user-a');

        // Discard means nothing was pushed.
        expect(vi.mocked(pushSyncOps)).not.toHaveBeenCalled();
        expect(vi.mocked(fetchBootstrap)).toHaveBeenCalledTimes(1);
        expect(getSyncRecoveryState()).toEqual({ phase: 'idle' });
        const remaining = await db.getAll('syncOperations');
        expect(remaining.map((op) => op.entityId)).toEqual(['op-b1']);
    });

    it('removes the local entity rows written by discarded create ops — they never reached the server', async () => {
        // Offline-first capture writes the entity row BEFORE queueing the op; discarding only the op
        // would leave the row as a visible-but-unsyncable zombie (bootstrap is put-only).
        await db.put('items', makeItem('item-created-offline', 'user-a', 'Discarded offline item'));
        await db.add('syncOperations', makeQueuedOp('item-created-offline', 'user-a', 'Discarded offline item'));
        // An offline UPDATE to a server-known item must NOT delete the row — bootstrap re-puts the
        // server version; only `create` ops own their entity rows.
        await db.put('items', makeItem('item-known-to-server', 'user-a', 'Edited offline'));
        await db.add('syncOperations', { ...makeQueuedOp('item-known-to-server', 'user-a', 'Edited offline'), opType: 'update' });
        setSyncRecoveryState({ phase: 'case2Choice', userId: 'user-a', queuedOpCount: 2 });

        await discardQueuedChangesAndBootstrap(db, 'user-a');

        expect(await db.get('items', 'item-created-offline')).toBeUndefined();
        expect(await db.get('items', 'item-known-to-server')).toBeDefined();
        expect(await db.getAll('syncOperations')).toHaveLength(0);
        expect(getSyncRecoveryState()).toEqual({ phase: 'idle' });
    });

    it('also removes the row of a create merged with later updates (collapse keeps opType create)', async () => {
        // queueSyncOp's create→update collapse re-queues a SINGLE op with opType 'create' carrying
        // the final snapshot — the discard must still recognize it as a local-only entity.
        await db.put('items', makeItem('item-edited-after-create', 'user-a', 'Renamed offline'));
        await db.add('syncOperations', makeQueuedOp('item-edited-after-create', 'user-a', 'Renamed offline'));
        setSyncRecoveryState({ phase: 'case2Choice', userId: 'user-a', queuedOpCount: 1 });

        await discardQueuedChangesAndBootstrap(db, 'user-a');

        expect(await db.get('items', 'item-edited-after-create')).toBeUndefined();
        expect(await db.getAll('syncOperations')).toHaveLength(0);
    });
});

describe('retryBootstrap', () => {
    it('re-runs only the bootstrap and unlocks on success', async () => {
        setSyncRecoveryState({ phase: 'bootstrapFailed', userId: 'user-a', errorMessage: 'GET /sync/bootstrap 502' });

        await retryBootstrap(db, 'user-a');

        expect(vi.mocked(pushSyncOps)).not.toHaveBeenCalled();
        expect(vi.mocked(fetchBootstrap)).toHaveBeenCalledTimes(1);
        expect(getSyncRecoveryState()).toEqual({ phase: 'idle' });
    });
});

describe('session-pivot failure never strands a buttonless spinner phase', () => {
    // withAccountSession starts with a NETWORK call (multiSession.listDeviceSessions). If it
    // rejects, the action's spinner phase (flushing/bootstrapping — no buttons) must not be the
    // final state: each action has to land in a retryable failure phase or the app locks forever.
    it('pushQueuedChangesAndBootstrap routes a gate-acquisition failure to flushFailed', async () => {
        await db.add('syncOperations', makeQueuedOp('op-1', 'user-a', 'Buy milk'));
        vi.mocked(authClient.multiSession.listDeviceSessions).mockRejectedValueOnce(new Error('network down'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await pushQueuedChangesAndBootstrap(db, 'user-a');

        expect(getSyncRecoveryState()).toEqual({
            phase: 'flushFailed',
            userId: 'user-a',
            queuedOpCount: 1,
            errorMessage: 'network down',
            failedOpSummaries: ['create item: "Buy milk"'],
        });
        // Nothing reached the server and the queue is intact for retry.
        expect(vi.mocked(pushSyncOps)).not.toHaveBeenCalled();
        expect(vi.mocked(fetchBootstrap)).not.toHaveBeenCalled();
        expect(await db.getAll('syncOperations')).toHaveLength(1);
        errorSpy.mockRestore();
    });

    it('discardQueuedChangesAndBootstrap routes a gate-acquisition failure to bootstrapFailed', async () => {
        await db.add('syncOperations', makeQueuedOp('op-1', 'user-a', 'Buy milk'));
        vi.mocked(authClient.multiSession.listDeviceSessions).mockRejectedValueOnce(new Error('network down'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await discardQueuedChangesAndBootstrap(db, 'user-a');

        expect(getSyncRecoveryState()).toEqual({ phase: 'bootstrapFailed', userId: 'user-a', errorMessage: 'network down' });
        // The gate never opened, so the discard never ran — the queue must be untouched.
        expect(await db.getAll('syncOperations')).toHaveLength(1);
        errorSpy.mockRestore();
    });

    it('retryBootstrap routes a gate-acquisition failure to bootstrapFailed', async () => {
        vi.mocked(authClient.multiSession.listDeviceSessions).mockRejectedValueOnce(new Error('network down'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await retryBootstrap(db, 'user-a');

        expect(getSyncRecoveryState()).toEqual({ phase: 'bootstrapFailed', userId: 'user-a', errorMessage: 'network down' });
        errorSpy.mockRestore();
    });
});
