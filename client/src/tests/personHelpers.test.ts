import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deletePersonById, getPeopleByUser, putPerson } from '../db/personHelpers';
import type { MyDB, StoredPerson } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function makePerson(id: string, overrides: Partial<StoredPerson> = {}): StoredPerson {
    return {
        _id: id,
        userId: USER_ID,
        name: `Person ${id}`,
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

describe('getPeopleByUser', () => {
    it('returns only people for the given userId', async () => {
        await db.put('people', makePerson('p1'));
        await db.put('people', makePerson('p2', { userId: 'other-user' }));
        await db.put('people', makePerson('p3'));

        const result = await getPeopleByUser(db, USER_ID);
        expect(result).toHaveLength(2);
        expect(result.map((p) => p._id).sort()).toEqual(['p1', 'p3']);
    });

    it('returns empty array when no people exist', async () => {
        expect(await getPeopleByUser(db, USER_ID)).toEqual([]);
    });
});

describe('putPerson', () => {
    it('stores a person in the database', async () => {
        const person = makePerson('p1');
        await putPerson(db, person);

        const stored = await db.get('people', 'p1');
        expect(stored).toEqual(person);
    });
});

describe('deletePersonById', () => {
    it('removes a person from the database', async () => {
        await db.put('people', makePerson('p1'));
        await deletePersonById(db, 'p1');

        expect(await db.get('people', 'p1')).toBeUndefined();
    });
});
