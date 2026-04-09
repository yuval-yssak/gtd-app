import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { createRoutine, removeRoutine, updateRoutine } from '../db/routineMutations';
import { waitForPendingFlush } from '../db/syncHelpers';
import type { MyDB, StoredRoutine } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function routineFields(): Omit<StoredRoutine, '_id' | 'createdTs' | 'updatedTs'> {
    return {
        userId: USER_ID,
        title: 'Weekly review',
        routineType: 'nextAction',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        template: {},
        active: true,
    };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(async () => {
    await waitForPendingFlush().catch(() => {});
    db.close();
    vi.clearAllMocks();
});

describe('createRoutine', () => {
    it('writes a routine to IDB and queues a create op', async () => {
        const routine = await createRoutine(db, routineFields());

        expect(routine.title).toBe('Weekly review');
        expect(routine.userId).toBe(USER_ID);
        expect(routine._id).toBeTruthy();
        expect(routine.createdTs).toBeTruthy();

        const stored = await db.get('routines', routine._id);
        expect(stored).toEqual(routine);

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('create');
        expect(ops[0]?.entityType).toBe('routine');
        expect(ops[0]?.snapshot).toEqual(routine);
    });
});

describe('updateRoutine', () => {
    it('updates the routine and queues an update op', async () => {
        const routine = await createRoutine(db, routineFields());
        // Simulate the entity already being on the server
        await db.clear('syncOperations');

        const withPastTs = { ...routine, updatedTs: '2020-01-01T00:00:00.000Z' };
        const updated = await updateRoutine(db, { ...withPastTs, title: 'Daily standup' });

        expect(updated.title).toBe('Daily standup');
        expect(updated.updatedTs).not.toBe('2020-01-01T00:00:00.000Z');

        const stored = await db.get('routines', routine._id);
        expect(stored?.title).toBe('Daily standup');

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('update');
        expect(ops[0]?.entityType).toBe('routine');
        expect(ops[0]?.snapshot).toEqual(updated);
    });
});

describe('removeRoutine', () => {
    it('deletes the routine from IDB and queues a delete op', async () => {
        const routine = await createRoutine(db, routineFields());
        // Simulate the entity already being on the server
        await db.clear('syncOperations');

        await removeRoutine(db, routine._id);

        expect(await db.get('routines', routine._id)).toBeUndefined();

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('delete');
        expect(ops[0]?.entityType).toBe('routine');
        expect(ops[0]?.snapshot).toBeNull();
    });
});
