import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { createPerson, removePerson, updatePerson } from '../db/personMutations';
import { waitForPendingFlush } from '../db/syncHelpers';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(async () => {
    await waitForPendingFlush().catch(() => {});
    db.close();
    vi.clearAllMocks();
});

describe('createPerson', () => {
    it('writes a person to IDB and queues a create op', async () => {
        const person = await createPerson(db, { userId: USER_ID, name: 'Alice' });

        expect(person.name).toBe('Alice');
        expect(person.userId).toBe(USER_ID);
        expect(person._id).toBeTruthy();
        expect(person.createdTs).toBeTruthy();
        expect(person.updatedTs).toBe(person.createdTs);

        const stored = await db.get('people', person._id);
        expect(stored).toEqual(person);

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('create');
        expect(ops[0]?.entityType).toBe('person');
        expect(ops[0]?.entityId).toBe(person._id);
        expect(ops[0]?.snapshot).toEqual(person);
    });
});

describe('updatePerson', () => {
    it('updates the person and queues an update op', async () => {
        const person = await createPerson(db, { userId: USER_ID, name: 'Alice' });
        // Simulate the entity already being on the server so the update op is distinct
        await db.clear('syncOperations');

        const withPastTs = { ...person, updatedTs: '2020-01-01T00:00:00.000Z' };
        const updated = await updatePerson(db, { ...withPastTs, name: 'Bob' });

        expect(updated.name).toBe('Bob');
        expect(updated.updatedTs).not.toBe('2020-01-01T00:00:00.000Z');

        const stored = await db.get('people', person._id);
        expect(stored?.name).toBe('Bob');

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('update');
        expect(ops[0]?.entityType).toBe('person');
        expect(ops[0]?.snapshot).toEqual(updated);
    });
});

describe('removePerson', () => {
    it('deletes the person from IDB and queues a delete op', async () => {
        const person = await createPerson(db, { userId: USER_ID, name: 'Alice' });
        // Simulate the entity already being on the server
        await db.clear('syncOperations');

        await removePerson(db, person._id);

        expect(await db.get('people', person._id)).toBeUndefined();

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('delete');
        expect(ops[0]?.entityType).toBe('person');
        expect(ops[0]?.snapshot).toBeNull();
    });
});
