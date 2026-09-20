/**
 * The contract the Generate-brief precondition (`flushItemText` in ItemEditorBody) relies on:
 * after `queueSyncOp`, awaiting `dispatchOpFlush` guarantees the op has been POSTed and the queue
 * is empty — whereas `waitForPendingFlush` right after `queueSyncOp` gives no such guarantee,
 * because the fire-and-forget dispatch has not yet started its flush at that point.
 */
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));
vi.mock('../db/multiUserSync', () => ({
    syncSingleUser: vi.fn().mockResolvedValue(undefined),
}));

import { pushSyncOps } from '#api/syncClient';
import { dispatchOpFlush } from '../db/dispatchOpFlush';
import { syncSingleUser } from '../db/multiUserSync';
import { queueSyncOp, waitForPendingFlush } from '../db/syncHelpers';
import type { MyDB, StoredItem } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function makeItem(notes: string): StoredItem {
    return {
        _id: 'item-1',
        userId: USER_ID,
        status: 'inbox',
        title: 'Renew passport',
        notes,
        createdTs: '2026-09-20T10:00:00.000Z',
        updatedTs: '2026-09-20T10:00:00.000Z',
    };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
    await db.put('deviceMeta', { _id: 'local', deviceId: 'device-test', flushingTs: null });
    await db.put('accounts', { id: USER_ID, email: 'u@example.com', name: 'U', image: null, provider: 'google', addedAt: 1 });
    await db.put('activeAccount', { userId: USER_ID }, 'active');
});

afterEach(async () => {
    await waitForPendingFlush().catch(() => {});
    db.close();
    vi.clearAllMocks();
});

describe('flushing the editor text before generating a brief', () => {
    it('queueSyncOp → dispatchOpFlush: the op is pushed and the queue is empty when the await returns', async () => {
        await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: 'item-1', snapshot: makeItem('long notes'), userId: USER_ID });
        await dispatchOpFlush(db, USER_ID);
        expect(vi.mocked(pushSyncOps)).toHaveBeenCalled();
        const [firstCall] = vi.mocked(pushSyncOps).mock.calls;
        if (!firstCall) throw new Error('expected a push');
        const pushedOps = firstCall.find((arg) => Array.isArray(arg));
        expect(pushedOps).toEqual([expect.objectContaining({ entityId: 'item-1' })]);
        expect(await db.getAll('syncOperations')).toEqual([]);
    });

    it('routes a non-active owner through syncSingleUser (the session-pivoting orchestrator)', async () => {
        await queueSyncOp(db, {
            opType: 'update',
            entityType: 'item',
            entityId: 'item-2',
            snapshot: { ...makeItem('x'), _id: 'item-2', userId: 'user-other' },
            userId: 'user-other',
        });
        await dispatchOpFlush(db, 'user-other');
        expect(vi.mocked(syncSingleUser)).toHaveBeenCalledWith(db, 'user-other');
    });
});
