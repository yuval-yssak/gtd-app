import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteRoutineById, getRoutineById, getRoutinesAcrossUsers, getRoutinesByUser, putRoutine } from '../db/routineHelpers';
import type { MyDB, StoredRoutine } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function makeRoutine(id: string, overrides: Partial<StoredRoutine> = {}): StoredRoutine {
    return {
        _id: id,
        userId: USER_ID,
        title: `Routine ${id}`,
        routineType: 'nextAction',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        template: {},
        active: true,
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

describe('getRoutinesByUser', () => {
    it('returns only routines for the given userId', async () => {
        await db.put('routines', makeRoutine('r1'));
        await db.put('routines', makeRoutine('r2', { userId: 'other-user' }));

        const result = await getRoutinesByUser(db, USER_ID);
        expect(result).toHaveLength(1);
        expect(result[0]?._id).toBe('r1');
    });

    it('returns empty array when no routines exist', async () => {
        expect(await getRoutinesByUser(db, USER_ID)).toEqual([]);
    });
});

describe('getRoutineById', () => {
    it('returns the routine when it exists', async () => {
        const routine = makeRoutine('r1');
        await db.put('routines', routine);

        expect(await getRoutineById(db, 'r1')).toEqual(routine);
    });

    it('returns undefined when the routine does not exist', async () => {
        expect(await getRoutineById(db, 'nonexistent')).toBeUndefined();
    });
});

describe('putRoutine', () => {
    it('stores a routine in the database', async () => {
        const routine = makeRoutine('r1');
        await putRoutine(db, routine);

        expect(await db.get('routines', 'r1')).toEqual(routine);
    });
});

describe('deleteRoutineById', () => {
    it('removes a routine from the database', async () => {
        await db.put('routines', makeRoutine('r1'));
        await deleteRoutineById(db, 'r1');

        expect(await db.get('routines', 'r1')).toBeUndefined();
    });
});

describe('getRoutinesAcrossUsers', () => {
    it('returns routines owned by any of the supplied user ids, flattened', async () => {
        await db.put('routines', makeRoutine('r1', { userId: 'user-a' }));
        await db.put('routines', makeRoutine('r2', { userId: 'user-b' }));
        await db.put('routines', makeRoutine('r3', { userId: 'user-c' }));

        const merged = await getRoutinesAcrossUsers(db, ['user-a', 'user-b']);
        expect(merged.map((r) => r._id).sort()).toEqual(['r1', 'r2']);
    });

    it('returns an empty array when no user ids are provided', async () => {
        await db.put('routines', makeRoutine('r1'));
        expect(await getRoutinesAcrossUsers(db, [])).toEqual([]);
    });
});
