import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetAppResourceCacheForTests, getAppResource, invalidateAppResource } from '../data/appResource';
import { putItem } from '../db/itemHelpers';
import type { MyDB, StoredItem } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_A = 'user-A';
const USER_B = 'user-B';

function makeItem(userId: string, idSuffix: string): StoredItem {
    return {
        _id: `item-${userId}-${idSuffix}`,
        userId,
        status: 'inbox',
        title: `Item ${idSuffix} for ${userId}`,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
    };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    _resetAppResourceCacheForTests();
    db = await openTestDB();
    await putItem(db, makeItem(USER_A, '1'));
    await putItem(db, makeItem(USER_B, '1'));
});

afterEach(() => {
    db.close();
});

describe('getAppResource cache identity', () => {
    it('returns the same snapshot for repeat calls with the same (db, userIds)', () => {
        const first = getAppResource(db, [USER_A, USER_B]);
        const second = getAppResource(db, [USER_A, USER_B]);
        expect(second).toBe(first);
        expect(second.items).toBe(first.items);
        expect(second.routines).toBe(first.routines);
    });

    it('treats userId order as insignificant for cache lookup', () => {
        const first = getAppResource(db, [USER_A, USER_B]);
        const reversed = getAppResource(db, [USER_B, USER_A]);
        expect(reversed).toBe(first);
    });

    it('returns a different snapshot when the userIds set changes', () => {
        const single = getAppResource(db, [USER_A]);
        const both = getAppResource(db, [USER_A, USER_B]);
        expect(both).not.toBe(single);
    });
});

describe('invalidateAppResource', () => {
    it('replaces every promise when scope is "all"', () => {
        const before = getAppResource(db, [USER_A]);
        const after = invalidateAppResource(db, [USER_A], 'all');
        expect(after.items).not.toBe(before.items);
        expect(after.routines).not.toBe(before.routines);
        expect(after.people).not.toBe(before.people);
        expect(after.workContexts).not.toBe(before.workContexts);
    });

    it('with scope "items" only replaces the items promise — other fields keep identity', () => {
        const before = getAppResource(db, [USER_A]);
        const after = invalidateAppResource(db, [USER_A], 'items');
        expect(after.items).not.toBe(before.items);
        expect(after.routines).toBe(before.routines);
        expect(after.people).toBe(before.people);
        expect(after.workContexts).toBe(before.workContexts);
    });

    it('the next getAppResource call returns the freshly built snapshot', () => {
        const before = getAppResource(db, [USER_A]);
        const invalidated = invalidateAppResource(db, [USER_A], 'all');
        const after = getAppResource(db, [USER_A]);
        expect(after).toBe(invalidated);
        expect(after).not.toBe(before);
    });

    it('returns fresh data for users whose store changed between calls', async () => {
        const initial = await getAppResource(db, [USER_A]).items;
        expect(initial).toHaveLength(1);
        await putItem(db, makeItem(USER_A, '2'));
        // Without invalidation, the cached promise still resolves to the original snapshot.
        const stale = await getAppResource(db, [USER_A]).items;
        expect(stale).toHaveLength(1);
        // After invalidation, a fresh read sees the new write.
        invalidateAppResource(db, [USER_A], 'items');
        const fresh = await getAppResource(db, [USER_A]).items;
        expect(fresh).toHaveLength(2);
    });
});
