import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

dayjs.extend(utc);

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { createFirstRoutineItem, createNextRoutineItem, generateCalendarItemsToHorizon, materializePendingNextActionRoutines } from '../db/routineItemHelpers';
import { waitForPendingFlush } from '../db/syncHelpers';
import { hasAtLeastOne } from '../lib/typeUtils';
import type { MyDB, StoredRoutine } from '../types/MyDB';
import { openTestDB } from './openTestDB';

vi.mock('../lib/calendarHorizon', () => ({
    getCalendarHorizonMonths: () => 2,
}));

const USER_ID = 'user-1';

function buildRoutine(overrides: Partial<StoredRoutine> = {}): StoredRoutine {
    return {
        _id: 'routine-sd',
        userId: USER_ID,
        title: 'Start-date routine',
        routineType: 'nextAction',
        rrule: 'FREQ=DAILY;INTERVAL=1',
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

afterEach(async () => {
    await waitForPendingFlush().catch(() => {});
    db.close();
    vi.clearAllMocks();
});

// ── createNextRoutineItem: anchor on max(completionDate, startDate) ─────────

describe('createNextRoutineItem — startDate', () => {
    it('uses startDate as the search anchor when completionDate precedes it', async () => {
        const routine = buildRoutine({ rrule: 'FREQ=DAILY;INTERVAL=1', startDate: '2025-07-01' });
        // Completion date is before startDate — the next occurrence should snap forward to startDate.
        await createNextRoutineItem(db, USER_ID, routine, new Date('2025-06-15'));
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        if (!hasAtLeastOne(items)) throw new Error('No items');
        // First occurrence strictly after 2025-07-01 for DAILY is 2025-07-02.
        expect(items[0].expectedBy).toBe('2025-07-02');
    });

    it('falls back to completionDate when it is already after startDate', async () => {
        const routine = buildRoutine({ rrule: 'FREQ=DAILY;INTERVAL=1', startDate: '2025-06-01' });
        await createNextRoutineItem(db, USER_ID, routine, new Date('2025-06-15'));
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        if (!hasAtLeastOne(items)) throw new Error('No items');
        expect(items[0].expectedBy).toBe('2025-06-16');
    });

    it('paused routine: generates no item (early return)', async () => {
        const routine = buildRoutine({ active: false });
        await createNextRoutineItem(db, USER_ID, routine, new Date('2025-06-15'));
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(0);
    });
});

// ── createFirstRoutineItem: includes today as a candidate so daily/interval rules land today ──

describe('createFirstRoutineItem', () => {
    // Pin time so weekday-derived assertions can't flake across a midnight boundary.
    // 2025-04-23 12:00 local = a Wednesday at noon — gives us a clean "today" + "tomorrow".
    // toFake: ['Date'] keeps setTimeout/setInterval real so IDB async ops aren't frozen.
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2025-04-23T12:00:00'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('daily rule: first item lands today', async () => {
        const todayStr = dayjs().format('YYYY-MM-DD');
        const routine = buildRoutine({ rrule: 'FREQ=DAILY;INTERVAL=1' });
        await createFirstRoutineItem(db, USER_ID, routine);
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        if (!hasAtLeastOne(items)) throw new Error('No items');
        expect(items[0].expectedBy).toBe(todayStr);
    });

    it('every-3-days rule: first item lands today', async () => {
        const todayStr = dayjs().format('YYYY-MM-DD');
        const routine = buildRoutine({ rrule: 'FREQ=DAILY;INTERVAL=3' });
        await createFirstRoutineItem(db, USER_ID, routine);
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        if (!hasAtLeastOne(items)) throw new Error('No items');
        expect(items[0].expectedBy).toBe(todayStr);
    });

    it('weekly rule with non-matching BYDAY: first item lands on the next matching weekday', async () => {
        // Pick a BYDAY that is NOT today (Wed) so the rule must advance — Thursday.
        const routine = buildRoutine({ rrule: 'FREQ=WEEKLY;BYDAY=TH' });
        await createFirstRoutineItem(db, USER_ID, routine);
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        if (!hasAtLeastOne(items)) throw new Error('No items');
        const tomorrowStr = dayjs().add(1, 'day').format('YYYY-MM-DD');
        expect(items[0].expectedBy).toBe(tomorrowStr);
    });

    it('future startDate: snaps the first item to startDate', async () => {
        const futureStart = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const routine = buildRoutine({ rrule: 'FREQ=DAILY;INTERVAL=1', startDate: futureStart });
        await createFirstRoutineItem(db, USER_ID, routine);
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        if (!hasAtLeastOne(items)) throw new Error('No items');
        expect(items[0].expectedBy).toBe(futureStart);
    });

    it('paused routine: generates no item', async () => {
        const routine = buildRoutine({ active: false });
        await createFirstRoutineItem(db, USER_ID, routine);
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(0);
    });

    // Regression: anchoring on UTC rather than local would land on the wrong calendar date
    // whenever local-midnight straddles a UTC day boundary. The two pinned moments below catch
    // both directions: early-morning (positive UTC offsets see UTC = yesterday) and late-evening
    // (negative UTC offsets see UTC = tomorrow). Together they detect a regression in any
    // non-UTC TZ; on a UTC CI process they still assert the noon-equivalent contract.
    it('daily rule near end-of-day local: lands on local today, not UTC tomorrow', async () => {
        vi.setSystemTime(new Date('2025-04-23T23:30:00'));
        const todayStr = dayjs().format('YYYY-MM-DD');
        const routine = buildRoutine({ rrule: 'FREQ=DAILY;INTERVAL=1' });
        await createFirstRoutineItem(db, USER_ID, routine);
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        if (!hasAtLeastOne(items)) throw new Error('No items');
        expect(items[0].expectedBy).toBe(todayStr);
    });

    it('daily rule near start-of-day local: lands on local today, not UTC yesterday', async () => {
        vi.setSystemTime(new Date('2025-04-23T00:30:00'));
        const todayStr = dayjs().format('YYYY-MM-DD');
        const routine = buildRoutine({ rrule: 'FREQ=DAILY;INTERVAL=1' });
        await createFirstRoutineItem(db, USER_ID, routine);
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        if (!hasAtLeastOne(items)) throw new Error('No items');
        expect(items[0].expectedBy).toBe(todayStr);
    });
});

// ── generateCalendarItemsToHorizon: startDate + active guards ───────────────

describe('generateCalendarItemsToHorizon — startDate & active', () => {
    it('future startDate: no items until the startDate arrives', async () => {
        const futureStart = dayjs().add(30, 'day').format('YYYY-MM-DD');
        const routine = buildRoutine({
            _id: 'cal-1',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            startDate: futureStart,
            createdTs: '2025-01-01T00:00:00.000Z',
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        // All generated items must have timeStart >= startDate.
        const bad = items.filter((i) => (i.timeStart ?? '').slice(0, 10) < futureStart);
        expect(bad).toEqual([]);
    });

    it('paused routine: generates nothing', async () => {
        const routine = buildRoutine({
            _id: 'cal-2',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            active: false,
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);
        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(0);
    });
});

// ── materializePendingNextActionRoutines ────────────────────────────────────

describe('materializePendingNextActionRoutines', () => {
    it('generates the first item for an active nextAction routine whose startDate has arrived', async () => {
        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
        const routine = buildRoutine({ _id: 'mat-1', startDate: yesterday });
        await db.put('routines', routine);

        await materializePendingNextActionRoutines(db, USER_ID);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(1);
        expect(items[0]?.routineId).toBe('mat-1');
    });

    it('skips routines with a future startDate', async () => {
        const future = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const routine = buildRoutine({ _id: 'mat-2', startDate: future });
        await db.put('routines', routine);

        await materializePendingNextActionRoutines(db, USER_ID);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(0);
    });

    it('skips paused routines', async () => {
        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
        const routine = buildRoutine({ _id: 'mat-3', startDate: yesterday, active: false });
        await db.put('routines', routine);

        await materializePendingNextActionRoutines(db, USER_ID);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(0);
    });

    it('skips routines that already have an open item (preserves "at most one" invariant)', async () => {
        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
        const routine = buildRoutine({ _id: 'mat-4', startDate: yesterday });
        await db.put('routines', routine);
        await db.put('items', {
            _id: 'existing-open',
            userId: USER_ID,
            status: 'nextAction',
            title: 'already here',
            routineId: 'mat-4',
            createdTs: yesterday,
            updatedTs: yesterday,
        });

        await materializePendingNextActionRoutines(db, USER_ID);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        // Still just the one pre-existing open item.
        expect(items.filter((i) => i.routineId === 'mat-4')).toHaveLength(1);
    });

    it('skips calendar routines (horizon generator handles them)', async () => {
        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
        const routine = buildRoutine({
            _id: 'mat-5',
            routineType: 'calendar',
            startDate: yesterday,
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
        });
        await db.put('routines', routine);

        await materializePendingNextActionRoutines(db, USER_ID);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(0);
    });

    it('skips routines without a startDate (legacy behavior unchanged)', async () => {
        const routine = buildRoutine({ _id: 'mat-6' });
        await db.put('routines', routine);

        await materializePendingNextActionRoutines(db, USER_ID);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(0);
    });
});
