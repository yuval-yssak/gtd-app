import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createNextRoutineItem,
    deleteAndRegenerateFutureItems,
    generateCalendarItemsToHorizon,
    getCalendarCompletionTiming,
    RruleExhaustedError,
    regenerateFutureItemContent,
} from '../db/routineItemHelpers';
import { hasAtLeastOne } from '../lib/typeUtils';
import type { MyDB, StoredRoutine } from '../types/MyDB';
import { openTestDB } from './openTestDB';

vi.mock('../lib/calendarHorizon', () => ({
    getCalendarHorizonMonths: () => 2,
}));

const USER_ID = 'user-1';

function buildRoutine(overrides: Partial<StoredRoutine> = {}): StoredRoutine {
    return {
        _id: 'routine-1',
        userId: USER_ID,
        title: 'Test routine',
        routineType: 'nextAction',
        rrule: 'FREQ=DAILY;INTERVAL=1',
        template: {},
        active: true,
        createdTs: '2025-01-01T00:00:00.000Z',
        updatedTs: '2025-01-01T00:00:00.000Z',
        ...overrides,
    };
}

// ── createNextRoutineItem ─────────────────────────────────────────────────────

describe('createNextRoutineItem', () => {
    let db: IDBPDatabase<MyDB>;

    beforeEach(async () => {
        db = await openTestDB();
    });

    afterEach(() => {
        db.close();
    });

    it('sets ignoreBefore equal to expectedBy (tickler until due date)', async () => {
        const routine = buildRoutine();
        await createNextRoutineItem(db, USER_ID, routine, dayjs('2025-06-01T12:00:00').toDate());

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(1);
        if (!hasAtLeastOne(items)) {
            throw new Error('No items found');
        }
        const generated = items[0];
        expect(generated.ignoreBefore).toBe(generated.expectedBy);
        expect(generated.routineId).toBe('routine-1');
        expect(generated.status).toBe('nextAction');
    });

    it('computes expectedBy from rrule and completion date', async () => {
        // Every 3 days — completing on June 1 should yield June 4. Local-midday instant: the
        // local and UTC calendar dates agree in every real timezone, so the fixture (unlike the
        // old `new Date('2025-06-01')` UTC-midnight form) asserts the same date everywhere.
        const routine = buildRoutine({ rrule: 'FREQ=DAILY;INTERVAL=3' });
        await createNextRoutineItem(db, USER_ID, routine, dayjs('2025-06-01T12:00:00').toDate());

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        if (!hasAtLeastOne(items)) {
            throw new Error('No items found');
        }
        expect(items[0].expectedBy).toBe('2025-06-04');
        expect(items[0].ignoreBefore).toBe('2025-06-04');
    });

    it('anchors on the completion LOCAL calendar day — a late-evening completion never regenerates for today', async () => {
        // 21:00 local wall-clock. In a negative-offset timezone this instant is already the next
        // day in UTC — the old raw-timestamp anchor produced the user's "today" again, re-showing
        // the task they just completed. The local-date anchor advances to the next LOCAL day.
        const routine = buildRoutine({ rrule: 'FREQ=DAILY;INTERVAL=1' });
        await createNextRoutineItem(db, USER_ID, routine, dayjs('2025-06-01T21:00:00').toDate());

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        if (!hasAtLeastOne(items)) {
            throw new Error('No items found');
        }
        expect(items[0].expectedBy).toBe('2025-06-02');
        expect(items[0].ignoreBefore).toBe('2025-06-02');
    });

    it('copies template fields onto the generated item', async () => {
        const routine = buildRoutine({
            template: {
                workContextIds: ['ctx-1'],
                energy: 'high',
                time: 30,
                focus: true,
                urgent: true,
                notes: 'Test notes',
            },
        });
        await createNextRoutineItem(db, USER_ID, routine, dayjs('2025-06-01T12:00:00').toDate());

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        if (!hasAtLeastOne(items)) {
            throw new Error('No items found');
        }
        const generated = items[0];
        expect(generated.workContextIds).toEqual(['ctx-1']);
        expect(generated.energy).toBe('high');
        expect(generated.time).toBe(30);
        expect(generated.focus).toBe(true);
        expect(generated.urgent).toBe(true);
        expect(generated.notes).toBe('Test notes');
    });

    it('queues a sync operation for the created item', async () => {
        const routine = buildRoutine();
        await createNextRoutineItem(db, USER_ID, routine, dayjs('2025-06-01T12:00:00').toDate());

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        if (!hasAtLeastOne(ops)) {
            throw new Error('No sync operations found');
        }
        expect(ops[0].opType).toBe('create');
        expect(ops[0].entityType).toBe('item');
    });
});

// ── getCalendarCompletionTiming ───────────────────────────────────────────────

describe('getCalendarCompletionTiming', () => {
    it('returns onTime when completion is within 24h of timeStart', () => {
        const timeStart = '2024-03-14T18:00:00';
        // Completed 2h after start — well within the 24h window
        const completionDate = new Date('2024-03-14T20:00:00Z');
        expect(getCalendarCompletionTiming(timeStart, completionDate)).toBe('onTime');
    });

    it('returns late when completion is more than 24h after timeStart', () => {
        const timeStart = '2024-03-14T18:00:00';
        // 48h after start — well past the 24h window
        const completionDate = new Date('2024-03-16T18:00:00Z');
        expect(getCalendarCompletionTiming(timeStart, completionDate)).toBe('late');
    });

    it('returns onTime when completed exactly 24h after timeStart (boundary — isAfter is strict)', () => {
        // The implementation uses dayjs.isAfter which is strictly greater than.
        // Both sides use dayjs local time so the comparison is timezone-independent.
        const timeStart = '2024-03-14T12:00:00';
        // Exactly 24h later in local time — NOT after the boundary, so must be 'onTime'
        const completionDate = dayjs('2024-03-14T12:00:00').add(24, 'hour').toDate();
        expect(getCalendarCompletionTiming(timeStart, completionDate)).toBe('onTime');
    });

    it('returns onTime when completed before timeStart (trashed before due)', () => {
        const timeStart = '2024-03-20T10:00:00';
        // Completed a week before the event
        const completionDate = new Date('2024-03-13T10:00:00Z');
        expect(getCalendarCompletionTiming(timeStart, completionDate)).toBe('onTime');
    });
});

// ── generateCalendarItemsToHorizon ──────────────────────────────────────────

function buildCalendarRoutine(overrides: Partial<StoredRoutine> = {}): StoredRoutine {
    return {
        _id: 'cal-routine-1',
        userId: USER_ID,
        title: 'Weekly standup',
        routineType: 'calendar',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        template: {},
        active: true,
        createdTs: '2025-01-01T00:00:00.000Z',
        updatedTs: '2025-01-01T00:00:00.000Z',
        calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
        ...overrides,
    };
}

describe('generateCalendarItemsToHorizon', () => {
    let db: IDBPDatabase<MyDB>;

    beforeEach(async () => {
        db = await openTestDB();
    });

    afterEach(() => {
        db.close();
    });

    it('generates items up to the 2-month horizon', async () => {
        const routine = buildCalendarRoutine();
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        const calendarItems = items.filter((i) => i.routineId === 'cal-routine-1' && i.status === 'calendar');

        // Weekly for ~2 months: expect roughly 8-9 items
        expect(calendarItems.length).toBeGreaterThanOrEqual(7);
        expect(calendarItems.length).toBeLessThanOrEqual(10);

        // All items should be on Mondays
        for (const item of calendarItems) {
            expect(dayjs(item.timeStart).day()).toBe(1); // Monday
            expect(item.timeStart).toContain('T09:00:00');
        }
    });

    it('skips exception dates', async () => {
        // Find the first Monday from today to use as an exception
        const nextMonday = dayjs().startOf('day').day(8); // next Monday
        const exceptionDate = nextMonday.format('YYYY-MM-DD');

        const routine = buildCalendarRoutine({
            routineExceptions: [{ date: exceptionDate, type: 'skipped' }],
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        const calendarItems = items.filter((i) => i.routineId === 'cal-routine-1');
        const dates = calendarItems.map((i) => (i.timeStart ?? '').slice(0, 10));
        expect(dates).not.toContain(exceptionDate);
    });

    it('applies title and notes overrides from content-modified exceptions', async () => {
        const nextMonday = dayjs().startOf('day').day(8);
        const overrideDate = nextMonday.format('YYYY-MM-DD');

        const routine = buildCalendarRoutine({
            routineExceptions: [{ date: overrideDate, type: 'modified', title: 'Special standup', notes: 'Retro agenda' }],
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        const overriddenItem = items.find((i) => (i.timeStart ?? '').startsWith(overrideDate));
        expect(overriddenItem).toBeDefined();
        expect(overriddenItem?.title).toBe('Special standup');
        expect(overriddenItem?.notes).toBe('Retro agenda');

        // Other items should still use the routine's default title
        const otherItems = items.filter((i) => !(i.timeStart ?? '').startsWith(overrideDate) && i.routineId === 'cal-routine-1');
        for (const item of otherItems) {
            expect(item.title).toBe('Weekly standup');
        }
    });

    it('mirrors routine master attendees/organizer onto every generated item', async () => {
        const routine = buildCalendarRoutine({
            organizer: { email: 'org@example.com', displayName: 'Org' },
            attendees: [
                { email: 'alice@example.com', responseStatus: 'accepted' },
                { email: 'bob@example.com', responseStatus: 'accepted' },
            ],
            eventType: 'default',
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        const generated = items.filter((i) => i.routineId === 'cal-routine-1' && i.status === 'calendar');
        expect(generated.length).toBeGreaterThan(0);
        for (const item of generated) {
            expect(item.organizer?.email).toBe('org@example.com');
            expect(item.attendees).toHaveLength(2);
            expect(item.eventType).toBe('default');
        }
    });

    it('per-instance exception attendees override master attendees on the matching date only', async () => {
        const nextMonday = dayjs().startOf('day').day(8);
        const overrideDate = nextMonday.format('YYYY-MM-DD');
        const routine = buildCalendarRoutine({
            attendees: [{ email: 'alice@example.com', responseStatus: 'accepted' }],
            routineExceptions: [
                {
                    date: overrideDate,
                    type: 'modified',
                    attendees: [
                        { email: 'alice@example.com', responseStatus: 'accepted' },
                        { email: 'carol@example.com', responseStatus: 'needsAction' },
                    ],
                },
            ],
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        const overriddenItem = items.find((i) => (i.timeStart ?? '').startsWith(overrideDate));
        expect(overriddenItem?.attendees).toHaveLength(2);

        const masterItems = items.filter((i) => !(i.timeStart ?? '').startsWith(overrideDate) && i.routineId === 'cal-routine-1');
        for (const item of masterItems) {
            expect(item.attendees).toHaveLength(1);
            expect(item.attendees?.[0]?.email).toBe('alice@example.com');
        }
    });

    it('per-instance exception with only responseStatus override keeps master organizer/attendees', async () => {
        const nextMonday = dayjs().startOf('day').day(8);
        const overrideDate = nextMonday.format('YYYY-MM-DD');
        const routine = buildCalendarRoutine({
            organizer: { email: 'org@example.com' },
            attendees: [{ email: 'alice@example.com', responseStatus: 'accepted' }],
            responseStatus: 'accepted',
            routineExceptions: [
                {
                    date: overrideDate,
                    type: 'modified',
                    responseStatus: 'declined',
                },
            ],
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        const overriddenItem = items.find((i) => (i.timeStart ?? '').startsWith(overrideDate));
        expect(overriddenItem?.organizer?.email).toBe('org@example.com');
        expect(overriddenItem?.attendees).toHaveLength(1);
        expect(overriddenItem?.attendees?.[0]?.email).toBe('alice@example.com');
        expect(overriddenItem?.responseStatus).toBe('declined');
    });

    it('per-instance exception with explicit empty attendees clears the master attendee list on that date', async () => {
        const nextMonday = dayjs().startOf('day').day(8);
        const overrideDate = nextMonday.format('YYYY-MM-DD');
        const routine = buildCalendarRoutine({
            attendees: [{ email: 'alice@example.com', responseStatus: 'accepted' }],
            routineExceptions: [{ date: overrideDate, type: 'modified', attendees: [] }],
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        const overriddenItem = items.find((i) => (i.timeStart ?? '').startsWith(overrideDate));
        expect(overriddenItem?.attendees).toEqual([]);
    });

    it('does not create duplicate items for existing dates', async () => {
        const routine = buildCalendarRoutine();

        // Generate once
        await generateCalendarItemsToHorizon(db, USER_ID, routine);
        const firstCount = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1').length;

        // Generate again — should not add duplicates
        await generateCalendarItemsToHorizon(db, USER_ID, routine);
        const secondCount = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1').length;

        expect(secondCount).toBe(firstCount);
    });

    it('does not regenerate a moved `modified` exception (its original date is excluded)', async () => {
        // When the user edits a routine instance's time-of-day to a different day, the exception
        // carries the original rrule date + a newTimeStart on a later date. A second horizon pass
        // must NOT regenerate a fresh item for the original date — otherwise the user's move
        // silently duplicates.
        const nextMonday = dayjs().startOf('day').day(8);
        const originalDate = nextMonday.format('YYYY-MM-DD');
        const movedToDate = nextMonday.add(1, 'day').format('YYYY-MM-DD');
        const routine = buildCalendarRoutine({
            routineExceptions: [
                {
                    date: originalDate,
                    type: 'modified',
                    itemId: 'moved-item',
                    newTimeStart: `${movedToDate}T09:00:00`,
                    newTimeEnd: `${movedToDate}T09:30:00`,
                },
            ],
        });

        // The item on the moved date already exists in IDB — mirror what the dialog would leave.
        await db.put('items', {
            _id: 'moved-item',
            userId: USER_ID,
            status: 'calendar',
            title: 'Weekly standup',
            routineId: 'cal-routine-1',
            timeStart: `${movedToDate}T09:00:00`,
            timeEnd: `${movedToDate}T09:30:00`,
            createdTs: '2025-01-01T00:00:00.000Z',
            updatedTs: '2025-01-01T00:00:00.000Z',
        });

        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const items = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1');
        const onOriginalDate = items.filter((i) => (i.timeStart ?? '').startsWith(originalDate));
        expect(onOriginalDate).toHaveLength(0);
    });

    it('queues sync operations for each generated item', async () => {
        const routine = buildCalendarRoutine();
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const items = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1');
        const ops = await db.getAll('syncOperations');
        // +1 for the routine update (lastGeneratedDate)
        expect(ops.length).toBe(items.length + 1);
    });

    it('throws RruleExhaustedError when series is exhausted', async () => {
        // COUNT=1 with createdTs in the past — the only occurrence is before today's horizon
        const routine = buildCalendarRoutine({
            rrule: 'FREQ=DAILY;COUNT=1',
            createdTs: '2020-01-01T00:00:00.000Z',
        });

        await expect(generateCalendarItemsToHorizon(db, USER_ID, routine)).rejects.toThrow(RruleExhaustedError);
    });

    it('does not recreate a calendar item for a date whose item was marked done (matrix A8)', async () => {
        // Regression guard: dedupe must match items of ANY status for this routine, not just
        // status === 'calendar'. Otherwise the disposal-time horizon extension creates a
        // duplicate item on the same date that was just marked done.
        const nextMonday = dayjs().startOf('day').day(8);
        const doneDate = nextMonday.format('YYYY-MM-DD');
        const routine = buildCalendarRoutine();

        await db.put('items', {
            _id: 'done-item',
            userId: USER_ID,
            status: 'done',
            title: 'Weekly standup',
            routineId: 'cal-routine-1',
            timeStart: `${doneDate}T09:00:00`,
            timeEnd: `${doneDate}T09:30:00`,
            createdTs: '2025-01-01T00:00:00.000Z',
            updatedTs: '2025-01-01T00:00:00.000Z',
        });

        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const items = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1');
        const onDoneDate = items.filter((i) => (i.timeStart ?? '').startsWith(doneDate));
        expect(onDoneDate).toHaveLength(1);
        expect(onDoneDate[0]?.status).toBe('done');
    });

    it('does not recreate a calendar item for a date whose item was marked trash', async () => {
        // Same dedupe rule as the done case — the `skipped` exception would also block it on the
        // trash path, but this covers the dedupe itself independently of the exception list.
        const nextMonday = dayjs().startOf('day').day(8);
        const trashDate = nextMonday.format('YYYY-MM-DD');
        const routine = buildCalendarRoutine();

        await db.put('items', {
            _id: 'trash-item',
            userId: USER_ID,
            status: 'trash',
            title: 'Weekly standup',
            routineId: 'cal-routine-1',
            timeStart: `${trashDate}T09:00:00`,
            timeEnd: `${trashDate}T09:30:00`,
            createdTs: '2025-01-01T00:00:00.000Z',
            updatedTs: '2025-01-01T00:00:00.000Z',
        });

        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const items = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1');
        const onTrashDate = items.filter((i) => (i.timeStart ?? '').startsWith(trashDate));
        expect(onTrashDate).toHaveLength(1);
        expect(onTrashDate[0]?.status).toBe('trash');
    });

    // ── all-day routines ──────────────────────────────────────────────────────

    it('generates all-day items with date-only timeStart/timeEnd and allDay: true', async () => {
        const routine = buildCalendarRoutine({
            // Replace the default timed template with the all-day shape — the generator's allDay
            // branch is independent of timeOfDay/duration, so omitting them must be safe.
            calendarItemTemplate: { allDay: true },
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const items = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1' && i.status === 'calendar');
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.allDay).toBe(true);
            // timeStart is YYYY-MM-DD (no T component)
            expect(item.timeStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            // timeEnd is exactly +1 day (GCal exclusive-end convention for single-day all-day)
            expect(item.timeEnd).toBe(dayjs(item.timeStart).add(1, 'day').format('YYYY-MM-DD'));
            // Items still land on Mondays per BYDAY=MO
            expect(dayjs(item.timeStart).day()).toBe(1);
        }
    });

    it('throws RruleExhaustedError when only done/trash items remain and rrule has no future occurrences', async () => {
        // Without gating exhaustion on live `calendar`-status items, historical done items would
        // suppress the exhausted signal and the routine would never be deactivated.
        const routine = buildCalendarRoutine({
            rrule: 'FREQ=DAILY;COUNT=1',
            createdTs: '2020-01-01T00:00:00.000Z',
        });
        await db.put('items', {
            _id: 'historical-done',
            userId: USER_ID,
            status: 'done',
            title: 'Weekly standup',
            routineId: 'cal-routine-1',
            timeStart: '2020-01-01T09:00:00',
            timeEnd: '2020-01-01T09:30:00',
            createdTs: '2020-01-01T00:00:00.000Z',
            updatedTs: '2020-01-01T00:00:00.000Z',
        });

        await expect(generateCalendarItemsToHorizon(db, USER_ID, routine)).rejects.toThrow(RruleExhaustedError);
    });
});

// ── deleteAndRegenerateFutureItems ──────────────────────────────────────────

describe('deleteAndRegenerateFutureItems', () => {
    let db: IDBPDatabase<MyDB>;

    beforeEach(async () => {
        db = await openTestDB();
    });

    afterEach(() => {
        db.close();
    });

    it('deletes future items and regenerates from new rrule', async () => {
        const routine = buildCalendarRoutine();
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const beforeItems = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1');
        expect(beforeItems.length).toBeGreaterThan(0);

        // Change rrule from weekly to biweekly
        const updatedRoutine = { ...routine, rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO' };
        await deleteAndRegenerateFutureItems(db, USER_ID, updatedRoutine);

        const afterItems = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1' && i.status === 'calendar');
        // Biweekly should have roughly half the items
        expect(afterItems.length).toBeLessThan(beforeItems.length);
        expect(afterItems.length).toBeGreaterThan(0);
    });
});

// ── regenerateFutureItemContent ──────────────────────────────────────────────

describe('regenerateFutureItemContent', () => {
    let db: IDBPDatabase<MyDB>;

    beforeEach(async () => {
        db = await openTestDB();
    });

    afterEach(() => {
        db.close();
    });

    it('updates title and notes on future items, preserving their ids', async () => {
        const routine = buildCalendarRoutine();
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const before = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1');
        const idsBefore = before.map((i) => i._id).sort();

        const renamed = { ...routine, title: 'Renamed standup', template: { ...routine.template, notes: 'fresh notes' } };
        await regenerateFutureItemContent(db, USER_ID, renamed);

        const after = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1');
        expect(after.map((i) => i._id).sort()).toEqual(idsBefore);
        expect(after.every((i) => i.title === 'Renamed standup')).toBe(true);
        expect(after.every((i) => i.notes === 'fresh notes')).toBe(true);
    });

    it('preserves per-instance overrides from routineExceptions', async () => {
        const routine = buildCalendarRoutine();
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        // Pick one future date to override
        const all = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1');
        const [target] = all;
        if (!target) {
            throw new Error('expected at least one generated item');
        }
        const overrideDate = (target.timeStart ?? '').slice(0, 10);

        const renamed = {
            ...routine,
            title: 'Renamed standup',
            routineExceptions: [{ date: overrideDate, type: 'modified' as const, title: 'Custom override', notes: 'instance notes' }],
        };
        await regenerateFutureItemContent(db, USER_ID, renamed);

        const after = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1');
        const overridden = after.find((i) => (i.timeStart ?? '').slice(0, 10) === overrideDate);
        expect(overridden?.title).toBe('Custom override');
        expect(overridden?.notes).toBe('instance notes');
        const nonOverridden = after.find((i) => (i.timeStart ?? '').slice(0, 10) !== overrideDate);
        expect(nonOverridden?.title).toBe('Renamed standup');
    });

    it('clears notes when master notes are removed and no override exists', async () => {
        const routine = buildCalendarRoutine({ template: { notes: 'initial' } });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const cleared = { ...routine, template: {} };
        await regenerateFutureItemContent(db, USER_ID, cleared);

        const after = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === 'cal-routine-1');
        expect(after.every((i) => i.notes === undefined)).toBe(true);
    });
});
