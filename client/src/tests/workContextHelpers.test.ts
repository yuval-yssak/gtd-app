import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteWorkContextById, getWorkContextsByUser, putWorkContext } from '../db/workContextHelpers';
import type { MyDB, StoredWorkContext } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function makeWorkContext(id: string, overrides: Partial<StoredWorkContext> = {}): StoredWorkContext {
    return {
        _id: id,
        userId: USER_ID,
        name: `Context ${id}`,
        createdTs: '2025-01-01T00:00:00.000Z',
        updatedTs: '2025-01-01T00:00:00.000Z',
        ...overrides,
    };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(() => {
    db.close();
});

describe('getWorkContextsByUser', () => {
    it('returns only work contexts for the given userId', async () => {
        await db.put('workContexts', makeWorkContext('wc1'));
        await db.put('workContexts', makeWorkContext('wc2', { userId: 'other-user' }));
        await db.put('workContexts', makeWorkContext('wc3'));

        const result = await getWorkContextsByUser(db, USER_ID);
        expect(result).toHaveLength(2);
        expect(result.map((wc) => wc._id).sort()).toEqual(['wc1', 'wc3']);
    });

    it('returns empty array when no work contexts exist', async () => {
        expect(await getWorkContextsByUser(db, USER_ID)).toEqual([]);
    });
});

describe('putWorkContext', () => {
    it('stores a work context in the database', async () => {
        const wc = makeWorkContext('wc1');
        await putWorkContext(db, wc);

        expect(await db.get('workContexts', 'wc1')).toEqual(wc);
    });
});

describe('deleteWorkContextById', () => {
    it('removes a work context from the database', async () => {
        await db.put('workContexts', makeWorkContext('wc1'));
        await deleteWorkContextById(db, 'wc1');

        expect(await db.get('workContexts', 'wc1')).toBeUndefined();
    });
});
