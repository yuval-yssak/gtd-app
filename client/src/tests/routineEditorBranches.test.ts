/**
 * Branch-helper coverage for RoutineEditorBody. Exercises the four extracted save branches
 * against fake-indexeddb so the dispatcher's behavioural invariants — what's written, what's
 * regenerated, when splits fire — are locked in independently of the React shell.
 */
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));
vi.mock('../lib/calendarHorizon', () => ({
    getCalendarHorizonMonths: () => 2,
}));

import { type SaveContext, saveCreate, saveEditWithoutStartDateChange, saveEditWithStartDateChange } from '../components/routineEditor/RoutineEditorBody';
import { waitForPendingFlush } from '../db/syncHelpers';
import type { MyDB, StoredItem, StoredRoutine } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function buildCtx(overrides: Partial<SaveContext> = {}): SaveContext {
    return {
        trimmedTitle: 'Updated title',
        finalRrule: 'FREQ=DAILY;INTERVAL=1',
        routineType: 'nextAction',
        template: {},
        calendarItemTemplate: undefined,
        calendarLink: {},
        formStartDate: undefined,
        ...overrides,
    };
}

function buildRoutine(overrides: Partial<StoredRoutine> = {}): StoredRoutine {
    return {
        _id: 'routine-1',
        userId: USER_ID,
        title: 'Original title',
        routineType: 'nextAction',
        rrule: 'FREQ=DAILY;INTERVAL=1',
        template: {},
        active: true,
        createdTs: '2025-01-01T00:00:00.000Z',
        updatedTs: '2025-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function buildItem(overrides: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: `item-${Math.random().toString(36).slice(2, 8)}`,
        userId: USER_ID,
        status: 'nextAction',
        title: 'Original title',
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

describe('saveCreate', () => {
    it('persists the routine and seeds a first nextAction item when not future-dated', async () => {
        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
        await saveCreate(db, USER_ID, buildCtx({ trimmedTitle: 'Brand new', formStartDate: yesterday }));

        const routines = await db.getAllFromIndex('routines', 'userId', USER_ID);
        expect(routines).toHaveLength(1);
        const [created] = routines;
        if (!created) throw new Error('expected one routine');
        expect(created.title).toBe('Brand new');
        expect(created.active).toBe(true);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(1);
    });

    it('skips seeding the first item when startDate is strictly in the future', async () => {
        const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
        await saveCreate(db, USER_ID, buildCtx({ formStartDate: tomorrow }));

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(0);
    });
});

describe('saveEditWithStartDateChange', () => {
    it('hard-deletes open past items and updates in place when no done past items exist', async () => {
        const routine = buildRoutine();
        await db.put('routines', routine);
        // Open past item — should be hard-deleted (no sync op queued, gone from IDB).
        const past = buildItem({ _id: 'past-open', expectedBy: '2025-01-02', status: 'nextAction' });
        await db.put('items', past);
        await db.clear('syncOperations');

        await saveEditWithStartDateChange(db, routine, buildCtx({ trimmedTitle: 'Renamed', formStartDate: '2026-01-01' }));

        const stored = await db.get('routines', routine._id);
        expect(stored?.title).toBe('Renamed');
        expect(stored?.startDate).toBe('2026-01-01');
        // The open past item was hard-deleted, not trashed.
        const remaining = await db.get('items', 'past-open');
        expect(remaining).toBeUndefined();
    });

    it('splits the routine when done past items exist (preserves history)', async () => {
        const routine = buildRoutine();
        await db.put('routines', routine);
        const donePast = buildItem({ _id: 'done-past', status: 'done', expectedBy: '2025-01-02' });
        await db.put('items', donePast);
        await db.clear('syncOperations');

        await saveEditWithStartDateChange(db, routine, buildCtx({ trimmedTitle: 'New tail', formStartDate: '2026-01-01' }));

        const routines = await db.getAllFromIndex('routines', 'userId', USER_ID);
        // Original is capped + inactive; tail is a brand new routine.
        expect(routines).toHaveLength(2);
        const original = routines.find((r) => r._id === routine._id);
        const tail = routines.find((r) => r._id !== routine._id);
        expect(original?.active).toBe(false);
        expect(tail?.title).toBe('New tail');
        expect(tail?.active).toBe(true);
    });
});

describe('saveEditWithoutStartDateChange', () => {
    it('updates in place when there are no past items, even if the schedule changed', async () => {
        const routine = buildRoutine();
        await db.put('routines', routine);
        await db.clear('syncOperations');

        // Schedule change is irrelevant for nextAction (isCalendarScheduleChanged returns false),
        // so this exercises the "no past items → in-place" path regardless.
        await saveEditWithoutStartDateChange(db, routine, buildCtx({ trimmedTitle: 'Renamed', finalRrule: 'FREQ=WEEKLY;BYDAY=MO' }));

        const stored = await db.get('routines', routine._id);
        expect(stored?.title).toBe('Renamed');
        expect(stored?.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
        // No split: only the one original routine exists.
        const routines = await db.getAllFromIndex('routines', 'userId', USER_ID);
        expect(routines).toHaveLength(1);
    });

    it('resumes a paused routine — decision.resumeOnSave is derived from !routine.active', async () => {
        const routine = buildRoutine({ active: false });
        await db.put('routines', routine);
        await db.clear('syncOperations');

        await saveEditWithoutStartDateChange(db, routine, buildCtx({ trimmedTitle: 'Resumed' }));

        const stored = await db.get('routines', routine._id);
        expect(stored?.active).toBe(true);
        expect(stored?.title).toBe('Resumed');
    });

    it('keeps an active routine active (no implicit pause)', async () => {
        const routine = buildRoutine({ active: true });
        await db.put('routines', routine);
        await db.clear('syncOperations');

        await saveEditWithoutStartDateChange(db, routine, buildCtx({ trimmedTitle: 'Notes-only' }));

        const stored = await db.get('routines', routine._id);
        expect(stored?.active).toBe(true);
    });

    it('splits a calendar routine when the schedule changed and past items exist', async () => {
        const routine = buildRoutine({
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
        });
        await db.put('routines', routine);
        // Past calendar item — its presence triggers the split path so history is preserved.
        await db.put(
            'items',
            buildItem({
                _id: 'past-cal',
                status: 'calendar',
                timeStart: '2025-01-06T09:00:00.000Z',
                timeEnd: '2025-01-06T10:00:00.000Z',
                routineId: routine._id,
            }),
        );
        await db.clear('syncOperations');

        await saveEditWithoutStartDateChange(
            db,
            routine,
            buildCtx({
                routineType: 'calendar',
                finalRrule: 'FREQ=WEEKLY;BYDAY=TU',
                calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
                trimmedTitle: 'New tail',
            }),
        );

        const routines = await db.getAllFromIndex('routines', 'userId', USER_ID);
        expect(routines).toHaveLength(2);
        const original = routines.find((r) => r._id === routine._id);
        const tail = routines.find((r) => r._id !== routine._id);
        expect(original?.active).toBe(false);
        expect(tail?.active).toBe(true);
        expect(tail?.title).toBe('New tail');
    });
});

describe('saveEditWithStartDateChange (additional)', () => {
    it('skips seeding when the new startDate is strictly in the future (nextAction)', async () => {
        const routine = buildRoutine();
        await db.put('routines', routine);
        await db.clear('syncOperations');
        const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');

        await saveEditWithStartDateChange(db, routine, buildCtx({ formStartDate: tomorrow }));

        const items = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === routine._id);
        expect(items).toHaveLength(0);
        const stored = await db.get('routines', routine._id);
        expect(stored?.startDate).toBe(tomorrow);
    });
});
