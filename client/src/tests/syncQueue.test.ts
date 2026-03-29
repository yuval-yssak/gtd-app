import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queueSyncOp } from '../db/syncHelpers';
import type { MyDB, StoredItem } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function makeItem(id: string): StoredItem {
    return {
        _id: id,
        userId: USER_ID,
        status: 'inbox',
        title: 'Test item',
        createdTs: '2025-01-01T00:00:00.000Z',
        updatedTs: '2025-01-01T00:00:00.000Z',
    };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(() => {
    db.close();
});

describe('queueSyncOp coalescing', () => {
    it('create then update collapses into a single create carrying the latest snapshot', async () => {
        const id = 'item-a';
        const original = makeItem(id);
        const updated = { ...original, title: 'Updated title' };

        await queueSyncOp(db, { opType: 'create', entityType: 'item', entityId: id, snapshot: original });
        await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: id, snapshot: updated });

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('create');
        expect((ops[0]?.snapshot as StoredItem | null)?.title).toBe('Updated title');
    });

    it('create then delete drops everything (item never reached the server)', async () => {
        const id = 'item-b';

        await queueSyncOp(db, { opType: 'create', entityType: 'item', entityId: id, snapshot: makeItem(id) });
        await queueSyncOp(db, { opType: 'delete', entityType: 'item', entityId: id, snapshot: null });

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(0);
    });

    it('update then delete collapses into a single delete op', async () => {
        const id = 'item-c';

        await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: id, snapshot: makeItem(id) });
        await queueSyncOp(db, { opType: 'delete', entityType: 'item', entityId: id, snapshot: null });

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('delete');
        expect(ops[0]?.entityId).toBe(id);
    });

    it('two update ops on the same entity are NOT coalesced — each op carries its own snapshot', async () => {
        const id = 'item-d';
        const v1 = makeItem(id);
        const v2 = { ...v1, title: 'v2' };

        await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: id, snapshot: v1 });
        await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: id, snapshot: v2 });

        // update+update coalescing is intentionally skipped: both snapshots are kept
        // so the server always sees the intermediate state if needed.
        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(2);
        expect(ops.every((op) => op.opType === 'update')).toBe(true);
    });

    it('ops on different entities are not coalesced', async () => {
        const itemA = makeItem('item-e');
        const itemB = makeItem('item-f');

        await queueSyncOp(db, { opType: 'create', entityType: 'item', entityId: itemA._id, snapshot: itemA });
        await queueSyncOp(db, { opType: 'create', entityType: 'item', entityId: itemB._id, snapshot: itemB });

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(2);
    });
});
