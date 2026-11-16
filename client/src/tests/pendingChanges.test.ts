import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasPendingChanges } from '../db/pendingChanges';
import type { MyDB, SyncOperation } from '../types/MyDB';
import { openTestDB } from './openTestDB';

function queuedOp(entityType: SyncOperation['entityType'], entityId: string): SyncOperation {
    return { userId: 'user-A', entityType, entityId, opType: 'update', queuedAt: '2026-11-16T10:00:00.000Z', snapshot: null };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(() => {
    db.close();
});

describe('hasPendingChanges', () => {
    it('is false when nothing is queued for the entity', async () => {
        await db.add('syncOperations', queuedOp('item', 'other-item'));

        expect(await hasPendingChanges(db, { entityType: 'item', entityId: 'item-1' })).toBe(false);
    });

    it('is true while a change to the entity waits in the sync queue', async () => {
        await db.add('syncOperations', queuedOp('item', 'item-1'));

        expect(await hasPendingChanges(db, { entityType: 'item', entityId: 'item-1' })).toBe(true);
    });

    it('matches the entity type too — a brief borrows its item id', async () => {
        await db.add('syncOperations', queuedOp('itemBrief', 'item-1'));

        expect(await hasPendingChanges(db, { entityType: 'item', entityId: 'item-1' })).toBe(false);
    });
});
