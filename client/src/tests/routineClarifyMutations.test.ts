import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));
vi.mock('../lib/calendarHorizon', () => ({
    getCalendarHorizonMonths: () => 2,
}));

import { collectItem } from '../db/itemMutations';
import { clarifyToRoutine, undoClarifyToRoutine } from '../db/routineClarifyMutations';
import { createRoutineWithFirstItems } from '../db/routineMutations';
import { waitForPendingFlush } from '../db/syncHelpers';
import { resetGhostStore } from '../lib/listGhosts';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(async () => {
    // Wait for any fire-and-forget flush from queueSyncOp to finish before closing the DB.
    // Without this, the flush's IDB operations will throw InvalidStateError from fake-indexeddb.
    await waitForPendingFlush().catch(() => {});
    db.close();
    vi.clearAllMocks();
    resetGhostStore();
});

describe('createRoutineWithFirstItems', () => {
    it('seeds one nextAction item for a daily routine', async () => {
        const routine = await createRoutineWithFirstItems(db, {
            userId: USER_ID,
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY;INTERVAL=1',
            template: { energy: 'low' },
            title: 'Stretch',
            active: true,
        });

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(1);
        const [seeded] = items;
        if (!seeded) throw new Error('expected one seeded item');
        expect(seeded.routineId).toBe(routine._id);
        expect(seeded.status).toBe('nextAction');
        expect(seeded.title).toBe('Stretch');
        expect(seeded.energy).toBe('low');
        expect(seeded.expectedBy).toBe(dayjs().format('YYYY-MM-DD'));
        expect(seeded.ignoreBefore).toBe(seeded.expectedBy);
    });

    it('skips seeding when the startDate is in the future (boot-tick materialises it later)', async () => {
        await createRoutineWithFirstItems(db, {
            userId: USER_ID,
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY;INTERVAL=1',
            template: {},
            title: 'Later',
            active: true,
            startDate: dayjs().add(10, 'day').format('YYYY-MM-DD'),
        });

        expect(await db.getAllFromIndex('items', 'userId', USER_ID)).toHaveLength(0);
    });

    it('persists the routine even when seeding throws (exhausted schedule)', async () => {
        const routine = await createRoutineWithFirstItems(db, {
            userId: USER_ID,
            routineType: 'calendar',
            rrule: 'FREQ=DAILY;INTERVAL=1;UNTIL=20200101T235959Z',
            template: {},
            title: 'Long over',
            active: true,
            calendarItemTemplate: { timeOfDay: '07:00', duration: 30 },
        });

        // Seeding found no occurrence — logged, not thrown — and the routine row survives.
        expect(await db.get('routines', routine._id)).toBeDefined();
        expect(await db.getAllFromIndex('items', 'userId', USER_ID)).toHaveLength(0);
    });

    it('fills the horizon with calendar items for a calendar routine', async () => {
        const routine = await createRoutineWithFirstItems(db, {
            userId: USER_ID,
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
            template: {},
            title: 'Swim',
            active: true,
            calendarItemTemplate: { timeOfDay: '07:00', duration: 30 },
        });

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items.length).toBeGreaterThan(1);
        expect(items.every((i) => i.status === 'calendar' && i.routineId === routine._id)).toBe(true);
    });
});

describe('clarifyToRoutine', () => {
    it('creates the routine under the item owner, trashes the item, and queues both ops', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Water plants', notes: 'Small can' });
        await db.clear('syncOperations'); // simulate the capture already synced

        const { routine, trashedItem } = await clarifyToRoutine(db, item, {
            title: item.title,
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY;INTERVAL=1',
            template: { notes: 'Small can' },
            recurrenceAnchor: 'floating',
        });

        expect(routine.userId).toBe(USER_ID);
        expect(routine.active).toBe(true);
        expect(routine.title).toBe('Water plants');
        expect(await db.get('routines', routine._id)).toEqual(routine);

        expect(trashedItem._id).toBe(item._id);
        expect(trashedItem.status).toBe('trash');
        expect((await db.get('items', item._id))?.status).toBe('trash');

        // Seeded first item carries the template notes.
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        const seeded = items.find((i) => i.routineId === routine._id);
        expect(seeded?.notes).toBe('Small can');

        const ops = await db.getAll('syncOperations');
        const kinds = ops.map((op) => `${op.entityType}:${op.opType}`).sort();
        expect(kinds).toEqual(['item:create', 'item:update', 'routine:create']);
    });
});

describe('undoClarifyToRoutine', () => {
    it('hard-deletes the routine and its generated items and restores the inbox item', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Water plants' });
        const { routine } = await clarifyToRoutine(db, item, {
            title: item.title,
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY;INTERVAL=1',
            template: {},
        });
        await db.clear('syncOperations'); // isolate the undo's own ops

        await undoClarifyToRoutine(db, routine, item);

        expect(await db.get('routines', routine._id)).toBeUndefined();
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(1);
        const [restored] = items;
        if (!restored) throw new Error('expected the restored item');
        expect(restored._id).toBe(item._id);
        expect(restored.status).toBe('inbox');
        // The restore is a fresh write — its updatedTs must beat the trash snapshot in LWW.
        expect(restored.updatedTs > item.updatedTs).toBe(true);

        const ops = await db.getAll('syncOperations');
        const kinds = ops.map((op) => `${op.entityType}:${op.opType}`).sort();
        expect(kinds).toEqual(['item:delete', 'item:update', 'routine:delete']);
    });

    it('collapses an unflushed clarify + undo to zero routine ops (offline round-trip)', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Offline capture' });
        const { routine } = await clarifyToRoutine(db, item, {
            title: item.title,
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY;INTERVAL=1',
            template: {},
        });

        // No clear: the routine:create and seeded item:create are still queued, so the undo's
        // deletes must collapse them away entirely — the server never hears about the routine.
        await undoClarifyToRoutine(db, routine, item);

        const ops = await db.getAll('syncOperations');
        expect(ops.some((op) => op.entityType === 'routine')).toBe(false);
        expect(ops.some((op) => op.opType === 'delete')).toBe(false);
        // What remains is the item's own lifecycle op (create, carrying the restored snapshot).
        const itemOps = ops.filter((op) => op.entityId === item._id);
        expect(itemOps).toHaveLength(1);
        const [survivingOp] = itemOps;
        if (!survivingOp) throw new Error('expected the surviving item op');
        if (!survivingOp.snapshot || !('status' in survivingOp.snapshot)) throw new Error('expected an item snapshot on the surviving op');
        expect(survivingOp.snapshot.status).toBe('inbox');
    });

    it('removes every horizon item of an undone calendar routine', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Swim' });
        const { routine } = await clarifyToRoutine(db, item, {
            title: item.title,
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
            template: {},
            calendarItemTemplate: { timeOfDay: '07:00', duration: 30 },
        });
        const generated = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === routine._id);
        expect(generated.length).toBeGreaterThan(1);

        await undoClarifyToRoutine(db, routine, item);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(1);
        const [restored] = items;
        if (!restored) throw new Error('expected the restored item');
        expect(restored._id).toBe(item._id);
        expect(restored.status).toBe('inbox');
        expect(await db.get('routines', routine._id)).toBeUndefined();
    });
});
