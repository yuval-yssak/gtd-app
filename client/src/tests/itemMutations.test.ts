import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    clarifyToCalendar,
    clarifyToDone,
    clarifyToNextAction,
    clarifyToTrash,
    clarifyToWaitingFor,
    collectItem,
    removeItem,
    updateItem,
} from '../db/itemMutations';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(() => {
    db.close();
});

describe('collectItem', () => {
    it('writes an inbox item and queues a create op', async () => {
        const item = await collectItem(db, USER_ID, 'Buy milk');

        expect(item.status).toBe('inbox');
        expect(item.title).toBe('Buy milk');
        expect(item.userId).toBe(USER_ID);
        expect(item._id).toBeTruthy();

        const stored = await db.get('items', item._id);
        expect(stored).toEqual(item);

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('create');
        expect(ops[0]?.entityType).toBe('item');
        expect(ops[0]?.entityId).toBe(item._id);
    });
});

describe('clarifyToNextAction', () => {
    it('updates status, merges meta, strips calendar/waitingFor fields, queues update op', async () => {
        const item = await collectItem(db, USER_ID, 'Process inbox');
        // Use a known past updatedTs so we can detect that clarify refreshed it,
        // regardless of whether the call runs within the same millisecond as collectItem.
        const withCalendarFields = {
            ...item,
            updatedTs: '2020-01-01T00:00:00.000Z',
            timeStart: '2025-01-01T10:00:00Z',
            timeEnd: '2025-01-01T11:00:00Z',
            waitingForPersonId: 'person-1',
        };

        const next = await clarifyToNextAction(db, withCalendarFields, { energy: 'low', urgent: true });

        expect(next.status).toBe('nextAction');
        expect(next.energy).toBe('low');
        expect(next.urgent).toBe(true);
        expect(next.timeStart).toBeUndefined();
        expect(next.timeEnd).toBeUndefined();
        expect(next.waitingForPersonId).toBeUndefined();
        expect(next.updatedTs).not.toBe('2020-01-01T00:00:00.000Z');

        const ops = await db.getAll('syncOperations');
        // create op got merged into the pending create by queueSyncOp coalescing
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('create');
    });

    it('queues update op separately when item was already synced (no pending create)', async () => {
        const item = await collectItem(db, USER_ID, 'Process inbox');
        // Flush the queue manually to simulate item already on the server
        await db.clear('syncOperations');

        const next = await clarifyToNextAction(db, item, { energy: 'high' });

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('update');
        expect(ops[0]?.entityId).toBe(next._id);
    });
});

describe('clarifyToCalendar', () => {
    it('sets timeStart/timeEnd, strips nextAction/waitingFor fields', async () => {
        const item = await collectItem(db, USER_ID, 'Doctor appointment');
        await db.clear('syncOperations');

        const withNextActionFields = { ...item, workContextIds: ['ctx-1'], energy: 'high' as const, waitingForPersonId: 'p-1', ignoreBefore: '2025-06-01' };
        const cal = await clarifyToCalendar(db, withNextActionFields, '2025-07-01T09:00:00Z', '2025-07-01T10:00:00Z');

        expect(cal.status).toBe('calendar');
        expect(cal.timeStart).toBe('2025-07-01T09:00:00Z');
        expect(cal.timeEnd).toBe('2025-07-01T10:00:00Z');
        expect(cal.workContextIds).toBeUndefined();
        expect((cal as { energy?: string }).energy).toBeUndefined();
        expect(cal.waitingForPersonId).toBeUndefined();
        expect(cal.ignoreBefore).toBeUndefined();
    });
});

describe('clarifyToWaitingFor', () => {
    it('sets waitingForPersonId, strips calendar/nextAction fields', async () => {
        const item = await collectItem(db, USER_ID, 'Waiting on report');
        await db.clear('syncOperations');

        const withMixedFields = {
            ...item,
            timeStart: '2025-01-01T10:00:00Z',
            calendarEventId: 'evt-1',
            workContextIds: ['ctx-1'],
            energy: 'high' as const,
        };
        const waiting = await clarifyToWaitingFor(db, withMixedFields, {
            waitingForPersonId: 'person-99',
            expectedBy: '2025-08-01',
        });

        expect(waiting.status).toBe('waitingFor');
        expect(waiting.waitingForPersonId).toBe('person-99');
        expect(waiting.expectedBy).toBe('2025-08-01');
        expect(waiting.timeStart).toBeUndefined();
        expect(waiting.calendarEventId).toBeUndefined();
        expect(waiting.workContextIds).toBeUndefined();
    });
});

describe('clarifyToDone', () => {
    it('sets status to done and refreshes updatedTs', async () => {
        const item = await collectItem(db, USER_ID, 'Finish report');
        await db.clear('syncOperations');

        // Seed a past updatedTs so the assertion detects the refresh even within the same ms.
        const done = await clarifyToDone(db, { ...item, updatedTs: '2020-01-01T00:00:00.000Z' });

        expect(done.status).toBe('done');
        expect(done.updatedTs).not.toBe('2020-01-01T00:00:00.000Z');

        const stored = await db.get('items', done._id);
        expect(stored?.status).toBe('done');
    });
});

describe('clarifyToTrash', () => {
    it('sets status to trash', async () => {
        const item = await collectItem(db, USER_ID, 'Old idea');
        await db.clear('syncOperations');

        const trashed = await clarifyToTrash(db, item);

        expect(trashed.status).toBe('trash');
        const stored = await db.get('items', trashed._id);
        expect(stored?.status).toBe('trash');
    });
});

describe('updateItem', () => {
    it('refreshes updatedTs and queues update op', async () => {
        const item = await collectItem(db, USER_ID, 'Original title');
        await db.clear('syncOperations');

        // Seed a past updatedTs so the assertion detects the refresh even within the same ms.
        const edited = { ...item, title: 'New title', updatedTs: '2020-01-01T00:00:00.000Z' };
        const result = await updateItem(db, edited);

        expect(result.title).toBe('New title');
        expect(result.updatedTs).not.toBe('2020-01-01T00:00:00.000Z');

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('update');
    });
});

describe('removeItem', () => {
    it('deletes the item from IndexedDB and queues a delete op', async () => {
        const item = await collectItem(db, USER_ID, 'To delete');
        await db.clear('syncOperations');

        await removeItem(db, item._id);

        const stored = await db.get('items', item._id);
        expect(stored).toBeUndefined();

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('delete');
        expect(ops[0]?.entityId).toBe(item._id);
        expect(ops[0]?.snapshot).toBeNull();
    });
});
