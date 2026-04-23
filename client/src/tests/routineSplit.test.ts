import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));
vi.mock('../lib/calendarHorizon', () => ({
    getCalendarHorizonMonths: () => 2,
}));

import { deleteFutureItemsFromDate } from '../db/routineItemHelpers';
import { splitRoutine } from '../db/routineSplit';
import { waitForPendingFlush } from '../db/syncHelpers';
import type { MyDB, StoredItem, StoredRoutine } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function buildRoutine(overrides: Partial<StoredRoutine> = {}): StoredRoutine {
    return {
        _id: 'routine-1',
        userId: USER_ID,
        title: 'Daily standup',
        routineType: 'calendar',
        rrule: 'FREQ=DAILY;INTERVAL=1',
        template: {},
        active: true,
        createdTs: '2025-01-01T00:00:00.000Z',
        updatedTs: '2025-01-01T00:00:00.000Z',
        calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
        ...overrides,
    };
}

function buildItem(overrides: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: `item-${Math.random().toString(36).slice(2, 8)}`,
        userId: USER_ID,
        status: 'calendar',
        title: 'Daily standup',
        createdTs: '2025-01-01T00:00:00.000Z',
        updatedTs: '2025-01-01T00:00:00.000Z',
        routineId: 'routine-1',
        ...overrides,
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

// ── deleteFutureItemsFromDate ────────────────────────────────────────────────

describe('deleteFutureItemsFromDate', () => {
    it('deletes items with timeStart on or after fromDate', async () => {
        await db.put('items', buildItem({ _id: 'past', timeStart: '2025-03-01T09:00:00Z' }));
        await db.put('items', buildItem({ _id: 'on-date', timeStart: '2025-03-10T09:00:00Z' }));
        await db.put('items', buildItem({ _id: 'future', timeStart: '2025-03-20T09:00:00Z' }));

        await deleteFutureItemsFromDate(db, USER_ID, 'routine-1', '2025-03-10');

        const remaining = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(remaining.map((i) => i._id).sort()).toEqual(['past']);
    });

    it('queues delete sync ops for each deleted item', async () => {
        await db.put('items', buildItem({ _id: 'future-1', timeStart: '2025-04-01T09:00:00Z' }));
        await db.put('items', buildItem({ _id: 'future-2', timeStart: '2025-04-02T09:00:00Z' }));

        await deleteFutureItemsFromDate(db, USER_ID, 'routine-1', '2025-04-01');

        const ops = await db.getAll('syncOperations');
        const deleteOps = ops.filter((op) => op.opType === 'delete');
        expect(deleteOps).toHaveLength(2);
    });

    it('leaves items from other routines untouched', async () => {
        await db.put('items', buildItem({ _id: 'other-routine', routineId: 'routine-2', timeStart: '2025-04-01T09:00:00Z' }));
        await db.put('items', buildItem({ _id: 'mine', routineId: 'routine-1', timeStart: '2025-04-01T09:00:00Z' }));

        await deleteFutureItemsFromDate(db, USER_ID, 'routine-1', '2025-04-01');

        const remaining = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(remaining.map((i) => i._id)).toEqual(['other-routine']);
    });

    it('leaves non-calendar items untouched', async () => {
        await db.put('items', buildItem({ _id: 'done-item', status: 'done', timeStart: '2025-04-01T09:00:00Z' }));

        await deleteFutureItemsFromDate(db, USER_ID, 'routine-1', '2025-04-01');

        const remaining = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(remaining).toHaveLength(1);
    });
});

// ── splitRoutine ─────────────────────────────────────────────────────────────

describe('splitRoutine', () => {
    it('caps the original routine with UNTIL and creates a new tail routine', async () => {
        const original = buildRoutine();
        await db.put('routines', original);

        const tail = await splitRoutine(
            db,
            USER_ID,
            original,
            {
                routineType: 'calendar',
                title: 'Updated standup',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: {},
                calendarItemTemplate: { timeOfDay: '10:00', duration: 30 },
            },
            '2025-06-01',
        );

        // Original routine should have UNTIL appended
        const updatedOriginal = await db.get('routines', 'routine-1');
        expect(updatedOriginal?.rrule).toContain('UNTIL=');
        expect(updatedOriginal?.rrule).toContain('20250531T235959Z');

        // Tail routine should exist with the new properties
        expect(tail._id).not.toBe('routine-1');
        expect(tail.title).toBe('Updated standup');
        expect(tail.splitFromRoutineId).toBe('routine-1');
        expect(tail.calendarItemTemplate?.timeOfDay).toBe('10:00');
        expect(tail.active).toBe(true);

        // Tail should be in IDB
        const stored = await db.get('routines', tail._id);
        expect(stored?.title).toBe('Updated standup');
    });

    it('marks the original routine inactive after split', async () => {
        const original = buildRoutine();
        await db.put('routines', original);

        await splitRoutine(
            db,
            USER_ID,
            original,
            {
                routineType: 'calendar',
                title: 'Updated standup',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: {},
                calendarItemTemplate: { timeOfDay: '10:00', duration: 30 },
            },
            '2025-06-01',
        );

        const updatedOriginal = await db.get('routines', 'routine-1');
        expect(updatedOriginal?.active).toBe(false);
    });

    it('does not carry calendarEventId from the original to the tail', async () => {
        const original = buildRoutine({ calendarEventId: 'gcal-event-123' });
        await db.put('routines', original);

        const tail = await splitRoutine(
            db,
            USER_ID,
            original,
            {
                routineType: 'calendar',
                title: 'Updated standup',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: {},
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            },
            '2025-06-01',
        );

        expect(tail.calendarEventId).toBeUndefined();
    });

    it('deletes future items from the original and generates items for the tail', async () => {
        const original = buildRoutine();
        await db.put('routines', original);

        // Seed a future item that should be deleted
        await db.put('items', buildItem({ _id: 'future-item', timeStart: '2025-07-01T09:00:00Z' }));
        // Seed a past item that should be kept
        await db.put('items', buildItem({ _id: 'past-item', timeStart: '2025-03-01T09:00:00Z' }));

        await splitRoutine(
            db,
            USER_ID,
            original,
            {
                routineType: 'calendar',
                title: 'Updated standup',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: {},
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            },
            '2025-06-01',
        );

        const allItems = await db.getAllFromIndex('items', 'userId', USER_ID);
        // Past item should remain; future-item should be deleted; tail items should be generated
        const pastItem = allItems.find((i) => i._id === 'past-item');
        expect(pastItem).toBeDefined();

        const futureItem = allItems.find((i) => i._id === 'future-item');
        expect(futureItem).toBeUndefined();

        // Tail items should have been generated (at least one)
        const tailItems = allItems.filter((i) => i.routineId !== 'routine-1');
        expect(tailItems.length).toBeGreaterThan(0);
    });

    it('sets createdTs on the tail routine to the split date', async () => {
        const original = buildRoutine();
        await db.put('routines', original);

        const tail = await splitRoutine(
            db,
            USER_ID,
            original,
            {
                routineType: 'calendar',
                title: 'Updated standup',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: {},
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            },
            '2025-06-01',
        );

        expect(dayjs(tail.createdTs).format('YYYY-MM-DD')).toBe('2025-06-01');
    });

    it('queues sync ops for the capped original, deleted items, new tail, and generated items', async () => {
        const original = buildRoutine();
        await db.put('routines', original);
        await db.put('items', buildItem({ _id: 'to-delete', timeStart: '2025-07-01T09:00:00Z' }));

        await splitRoutine(
            db,
            USER_ID,
            original,
            {
                routineType: 'calendar',
                title: 'Updated standup',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: {},
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            },
            '2025-06-01',
        );

        const ops = await db.getAll('syncOperations');
        const routineOps = ops.filter((op) => op.entityType === 'routine');
        const itemOps = ops.filter((op) => op.entityType === 'item');

        // 1 update for the capped original + 1 create for the tail
        const routineUpdateOps = routineOps.filter((op) => op.opType === 'update');
        const routineCreateOps = routineOps.filter((op) => op.opType === 'create');
        expect(routineUpdateOps).toHaveLength(1);
        expect(routineCreateOps).toHaveLength(1);

        // Capped original's update snapshot carries active: false
        const cappedSnapshot = routineUpdateOps[0]?.snapshot as StoredRoutine | null;
        expect(cappedSnapshot?.active).toBe(false);
        expect(cappedSnapshot?.rrule).toContain('UNTIL=');

        // Tail create snapshot stays active: true
        const tailSnapshot = routineCreateOps[0]?.snapshot as StoredRoutine | null;
        expect(tailSnapshot?.active).toBe(true);

        // At least 1 delete op (for the deleted future item)
        expect(itemOps.filter((op) => op.opType === 'delete').length).toBeGreaterThanOrEqual(1);
        // Generated items create ops
        expect(itemOps.filter((op) => op.opType === 'create').length).toBeGreaterThan(0);
    });
});
