import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { partitionPastItemsByDoneness } from '../db/routineItemHelpers';
import { createRoutine, pauseRoutine, removeRoutine, updateRoutine } from '../db/routineMutations';
import { waitForPendingFlush } from '../db/syncHelpers';
import type { MyDB, StoredItem, StoredRoutine } from '../types/MyDB';
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

describe('createRoutine — startDate', () => {
    it('round-trips startDate through IDB and the sync queue', async () => {
        const routine = await createRoutine(db, { ...routineFields(), startDate: '2026-06-15' });
        expect(routine.startDate).toBe('2026-06-15');
        const stored = await db.get('routines', routine._id);
        expect(stored?.startDate).toBe('2026-06-15');
        const ops = await db.getAll('syncOperations');
        expect((ops[0]?.snapshot as StoredRoutine | null)?.startDate).toBe('2026-06-15');
    });
});

describe('pauseRoutine', () => {
    it('flips active=false, trashes future open items, queues update ops', async () => {
        const routine = await createRoutine(db, routineFields());
        await db.clear('syncOperations');

        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        const yesterday = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
        const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);

        // Future open nextAction → should be trashed.
        const futureItem: StoredItem = {
            _id: 'future-1',
            userId: USER_ID,
            status: 'nextAction',
            title: 'future',
            routineId: routine._id,
            expectedBy: tomorrow,
            createdTs: today,
            updatedTs: today,
        };
        // Past-due open → invariant: left alone.
        const pastDueItem: StoredItem = {
            _id: 'past-1',
            userId: USER_ID,
            status: 'nextAction',
            title: 'past',
            routineId: routine._id,
            expectedBy: yesterday,
            createdTs: yesterday,
            updatedTs: yesterday,
        };
        // Done item → left alone (not an open item).
        const doneItem: StoredItem = {
            _id: 'done-1',
            userId: USER_ID,
            status: 'done',
            title: 'done',
            routineId: routine._id,
            expectedBy: tomorrow,
            createdTs: today,
            updatedTs: today,
        };
        await db.put('items', futureItem);
        await db.put('items', pastDueItem);
        await db.put('items', doneItem);

        await pauseRoutine(db, USER_ID, routine);

        expect((await db.get('routines', routine._id))?.active).toBe(false);
        expect((await db.get('items', 'future-1'))?.status).toBe('trash');
        expect((await db.get('items', 'past-1'))?.status).toBe('nextAction');
        expect((await db.get('items', 'done-1'))?.status).toBe('done');

        const ops = await db.getAll('syncOperations');
        // 1 item update + 1 routine update.
        const routineOps = ops.filter((o) => o.entityType === 'routine');
        const itemOps = ops.filter((o) => o.entityType === 'item');
        expect(routineOps).toHaveLength(1);
        expect(routineOps[0]?.opType).toBe('update');
        expect((routineOps[0]?.snapshot as StoredRoutine | null)?.active).toBe(false);
        expect(itemOps).toHaveLength(1);
        expect(itemOps[0]?.entityId).toBe('future-1');
    });
});

// ─── partitionPastItemsByDoneness ───────────────────────────────────────────

describe('partitionPastItemsByDoneness', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    // Freeze the clock to a specific LOCAL wall-clock so datetime-level comparisons are stable
    // regardless of the test runner's TZ. We pass hour/minute explicitly and build the Date via
    // the local-time constructor — the ISO form would anchor to UTC and drift across machines.
    function freezeLocalClockAt(year: number, monthZeroIdx: number, day: number, hour: number, minute: number): void {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date(year, monthZeroIdx, day, hour, minute, 0, 0));
    }

    it('classifies today-but-wall-clock-past done items as past (datetime-level compare)', async () => {
        // K2 regression: the old string compare treated "2026-04-24T09:00:00" < "2026-04-24" as
        // false, so a done 9am item on today's date was wrongly left out of `donePast` and the
        // startDate-edit split path fell into the in-place branch instead of splitting.
        freezeLocalClockAt(2026, 3, 24, 22, 0); // Local 22:00 on Apr 24
        const todayStr = dayjs().format('YYYY-MM-DD');

        const routine = await createRoutine(db, { ...routineFields(), routineType: 'calendar' });
        const doneToday: StoredItem = {
            _id: 'done-today-morning',
            userId: USER_ID,
            status: 'done',
            title: '9am standup',
            routineId: routine._id,
            timeStart: `${todayStr}T09:00:00`,
            timeEnd: `${todayStr}T09:30:00`,
            createdTs: todayStr,
            updatedTs: todayStr,
        };
        await db.put('items', doneToday);

        const { donePast, nonDonePast } = await partitionPastItemsByDoneness(db, USER_ID, routine._id);

        expect(donePast.map((i) => i._id)).toEqual(['done-today-morning']);
        expect(nonDonePast).toEqual([]);
    });

    it('leaves today-but-wall-clock-future items out of the past partition', async () => {
        // Complement to the K2 regression: an item later today (e.g. a 9am item at 07:00 local)
        // must NOT be classified as past, otherwise the startDate-edit path would spuriously split.
        freezeLocalClockAt(2026, 3, 24, 7, 0); // Local 07:00 on Apr 24 — before the 9am item
        const todayStr = dayjs().format('YYYY-MM-DD');

        const routine = await createRoutine(db, { ...routineFields(), routineType: 'calendar' });
        await db.put('items', {
            _id: 'today-future',
            userId: USER_ID,
            status: 'calendar',
            title: '9am standup',
            routineId: routine._id,
            timeStart: `${todayStr}T09:00:00`,
            createdTs: todayStr,
            updatedTs: todayStr,
        });

        const { donePast, nonDonePast } = await partitionPastItemsByDoneness(db, USER_ID, routine._id);

        expect(donePast).toEqual([]);
        expect(nonDonePast).toEqual([]);
    });

    it('classifies yesterday done and open items into the right buckets', async () => {
        freezeLocalClockAt(2026, 3, 24, 10, 0);
        const yesterdayStr = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

        const routine = await createRoutine(db, { ...routineFields(), routineType: 'calendar' });
        await db.put('items', {
            _id: 'yesterday-done',
            userId: USER_ID,
            status: 'done',
            title: 'yesterday done',
            routineId: routine._id,
            timeStart: `${yesterdayStr}T09:00:00`,
            createdTs: yesterdayStr,
            updatedTs: yesterdayStr,
        });
        await db.put('items', {
            _id: 'yesterday-open',
            userId: USER_ID,
            status: 'calendar',
            title: 'yesterday open',
            routineId: routine._id,
            timeStart: `${yesterdayStr}T09:00:00`,
            createdTs: yesterdayStr,
            updatedTs: yesterdayStr,
        });

        const { donePast, nonDonePast } = await partitionPastItemsByDoneness(db, USER_ID, routine._id);

        expect(donePast.map((i) => i._id)).toEqual(['yesterday-done']);
        expect(nonDonePast.map((i) => i._id)).toEqual(['yesterday-open']);
    });

    it('excludes future items and items from other routines', async () => {
        freezeLocalClockAt(2026, 3, 24, 10, 0);
        const tomorrowStr = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const yesterdayStr = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

        const routine = await createRoutine(db, { ...routineFields(), routineType: 'calendar' });
        const otherRoutine = await createRoutine(db, { ...routineFields(), routineType: 'calendar' });
        await db.put('items', {
            _id: 'future',
            userId: USER_ID,
            status: 'calendar',
            title: 'future',
            routineId: routine._id,
            timeStart: `${tomorrowStr}T09:00:00`,
            createdTs: yesterdayStr,
            updatedTs: yesterdayStr,
        });
        await db.put('items', {
            _id: 'other-routine-past',
            userId: USER_ID,
            status: 'done',
            title: 'other',
            routineId: otherRoutine._id,
            timeStart: `${yesterdayStr}T09:00:00`,
            createdTs: yesterdayStr,
            updatedTs: yesterdayStr,
        });

        const { donePast, nonDonePast } = await partitionPastItemsByDoneness(db, USER_ID, routine._id);

        expect(donePast).toEqual([]);
        expect(nonDonePast).toEqual([]);
    });
});
