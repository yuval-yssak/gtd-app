import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { waitForPendingFlush } from '../db/syncHelpers';
import { createWorkContext, removeWorkContext, updateWorkContext } from '../db/workContextMutations';
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

describe('createWorkContext', () => {
    it('writes a work context to IDB and queues a create op', async () => {
        const wc = await createWorkContext(db, { userId: USER_ID, name: 'At desk' });

        expect(wc.name).toBe('At desk');
        expect(wc.userId).toBe(USER_ID);
        expect(wc._id).toBeTruthy();
        expect(wc.createdTs).toBeTruthy();

        const stored = await db.get('workContexts', wc._id);
        expect(stored).toEqual(wc);

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('create');
        expect(ops[0]?.entityType).toBe('workContext');
        expect(ops[0]?.snapshot).toEqual(wc);
    });
});

describe('updateWorkContext', () => {
    it('updates the work context and queues an update op', async () => {
        const wc = await createWorkContext(db, { userId: USER_ID, name: 'At desk' });
        // Simulate the entity already being on the server
        await db.clear('syncOperations');

        const withPastTs = { ...wc, updatedTs: '2020-01-01T00:00:00.000Z' };
        const updated = await updateWorkContext(db, { ...withPastTs, name: 'On the go' });

        expect(updated.name).toBe('On the go');
        expect(updated.updatedTs).not.toBe('2020-01-01T00:00:00.000Z');

        const stored = await db.get('workContexts', wc._id);
        expect(stored?.name).toBe('On the go');

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('update');
        expect(ops[0]?.entityType).toBe('workContext');
        expect(ops[0]?.snapshot).toEqual(updated);
    });
});

describe('removeWorkContext', () => {
    it('deletes the work context from IDB and queues a delete op', async () => {
        const wc = await createWorkContext(db, { userId: USER_ID, name: 'At desk' });
        // Simulate the entity already being on the server
        await db.clear('syncOperations');

        await removeWorkContext(db, wc._id);

        expect(await db.get('workContexts', wc._id)).toBeUndefined();

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('delete');
        expect(ops[0]?.entityType).toBe('workContext');
        expect(ops[0]?.snapshot).toBeNull();
    });
});
