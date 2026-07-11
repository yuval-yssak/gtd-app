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

import {
    buildUpdatedRoutine,
    linkedTypeSwitchSplitDate,
    type SaveContext,
    saveCreate,
    saveEditWithoutStartDateChange,
    saveEditWithStartDateChange,
} from '../components/routineEditor/RoutineEditorBody';
import { waitForPendingFlush } from '../db/syncHelpers';
import type { MyDB, StoredItem, StoredRoutine } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function buildCtx(overrides: Partial<SaveContext> = {}): SaveContext {
    return {
        trimmedTitle: 'Updated title',
        finalRrule: 'FREQ=DAILY;INTERVAL=1',
        recurrenceAnchor: 'floating',
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

describe('nextAction open-item propagation on save', () => {
    it('updates the open item when the template changes (no schedule change)', async () => {
        const routine = buildRoutine({ template: { energy: 'low' } });
        await db.put('routines', routine);
        const today = dayjs().format('YYYY-MM-DD');
        await db.put('items', buildItem({ _id: 'open-1', energy: 'low', expectedBy: today, ignoreBefore: today }));

        const result = await saveEditWithoutStartDateChange(
            db,
            routine,
            buildCtx({ trimmedTitle: 'Original title', template: { energy: 'high', workContextIds: ['wc-1'] } }),
        );

        expect(result?.outcome).toBe('updated');
        const stored = await db.get('items', 'open-1');
        expect(stored?.energy).toBe('high');
        expect(stored?.workContextIds).toEqual(['wc-1']);
        expect(stored?.expectedBy).toBe(today);
    });

    it('recomputes the open item dates when the recurrence changes', async () => {
        const routine = buildRoutine({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU' });
        await db.put('routines', routine);
        const nextWeek = dayjs().add(7, 'day').format('YYYY-MM-DD');
        await db.put('items', buildItem({ _id: 'open-1', expectedBy: nextWeek, ignoreBefore: nextWeek }));

        const result = await saveEditWithoutStartDateChange(db, routine, buildCtx({ trimmedTitle: 'Original title', finalRrule: 'FREQ=DAILY;INTERVAL=1' }));

        expect(result?.outcome).toBe('updated');
        const stored = await db.get('items', 'open-1');
        const today = dayjs().format('YYYY-MM-DD');
        expect(stored?.expectedBy).toBe(today);
        expect(stored?.ignoreBefore).toBe(today);
    });

    it('restamps a surviving future open item on a startDate change instead of seeding a duplicate', async () => {
        const routine = buildRoutine();
        await db.put('routines', routine);
        const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
        await db.put('items', buildItem({ _id: 'open-1', expectedBy: tomorrow, ignoreBefore: tomorrow }));
        const inThreeDays = dayjs().add(3, 'day').format('YYYY-MM-DD');

        const result = await saveEditWithStartDateChange(db, routine, buildCtx({ trimmedTitle: 'Original title', formStartDate: inThreeDays }));

        expect(result?.outcome).toBe('updated');
        const items = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === routine._id);
        expect(items).toHaveLength(1);
        const [stored] = items;
        if (!stored) throw new Error('expected the surviving open item');
        expect(stored._id).toBe('open-1');
        expect(stored.expectedBy).toBe(inThreeDays);
        expect(stored.ignoreBefore).toBe(inThreeDays);
    });

    it('trashes the pending item and deactivates the routine when the edited schedule is exhausted', async () => {
        const routine = buildRoutine();
        await db.put('routines', routine);
        const today = dayjs().format('YYYY-MM-DD');
        await db.put('items', buildItem({ _id: 'open-1', expectedBy: today, ignoreBefore: today }));

        const result = await saveEditWithoutStartDateChange(
            db,
            routine,
            buildCtx({ trimmedTitle: 'Original title', finalRrule: 'FREQ=DAILY;INTERVAL=1;UNTIL=20200101T235959Z' }),
        );

        expect(result?.outcome).toBe('trashedExhausted');
        const stored = await db.get('items', 'open-1');
        expect(stored?.status).toBe('trash');
        const storedRoutine = await db.get('routines', routine._id);
        expect(storedRoutine?.active).toBe(false);
    });
});

describe('startDate change with a transformed survivor', () => {
    it('does not seed a duplicate next to a transformed open item (broad open-slot guard)', async () => {
        const routine = buildRoutine();
        await db.put('routines', routine);
        const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
        // The generated item was transformed to waitingFor — it claims the open slot but is the
        // user's own now, so it must be neither edited nor shadowed by a fresh nextAction item.
        await db.put('items', buildItem({ _id: 'transformed-1', status: 'waitingFor', expectedBy: tomorrow, ignoreBefore: tomorrow }));
        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

        const result = await saveEditWithStartDateChange(db, routine, buildCtx({ trimmedTitle: 'Original title', formStartDate: yesterday }));

        expect(result).toBeNull();
        const items = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === routine._id);
        expect(items).toHaveLength(1);
        const [survivor] = items;
        if (!survivor) throw new Error('expected the transformed survivor');
        expect(survivor.status).toBe('waitingFor');
        expect(survivor.expectedBy).toBe(tomorrow);
    });
});

describe('routineType switch (nextAction ↔ calendar)', () => {
    const calendarCtx = (overrides: Partial<SaveContext> = {}) =>
        buildCtx({ routineType: 'calendar', calendarItemTemplate: { timeOfDay: '09:00', duration: 30 }, ...overrides });

    it('nextAction → calendar: trashes the open native item and fills the calendar horizon', async () => {
        const routine = buildRoutine();
        await db.put('routines', routine);
        await db.put('items', buildItem({ _id: 'open-na', status: 'nextAction', expectedBy: dayjs().format('YYYY-MM-DD') }));

        await saveEditWithoutStartDateChange(db, routine, calendarCtx());

        const oldItem = await db.get('items', 'open-na');
        expect(oldItem?.status).toBe('trash');
        const calendarItems = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.status === 'calendar');
        expect(calendarItems.length).toBeGreaterThan(0);
        const stored = await db.get('routines', routine._id);
        expect(stored?.routineType).toBe('calendar');
        // The trash must ride a queued update op — that sync breadcrumb is what converges other devices.
        const trashOps = (await db.getAll('syncOperations')).filter((op) => op.entityId === 'open-na' && op.opType === 'update');
        expect(trashOps.some((op) => op.snapshot !== null && 'status' in op.snapshot && op.snapshot.status === 'trash')).toBe(true);
    });

    it('calendar → nextAction: trashes only future calendar items, keeps past history, seeds the first item', async () => {
        const routine = buildRoutine({ routineType: 'calendar', calendarItemTemplate: { timeOfDay: '09:00', duration: 30 } });
        await db.put('routines', routine);
        const pastDate = dayjs().subtract(3, 'day').format('YYYY-MM-DD');
        const futureDate = dayjs().add(3, 'day').format('YYYY-MM-DD');
        await db.put('items', buildItem({ _id: 'past-cal', status: 'calendar', timeStart: `${pastDate}T09:00:00`, timeEnd: `${pastDate}T09:30:00` }));
        await db.put('items', buildItem({ _id: 'future-cal', status: 'calendar', timeStart: `${futureDate}T09:00:00`, timeEnd: `${futureDate}T09:30:00` }));

        await saveEditWithoutStartDateChange(db, routine, buildCtx({ routineType: 'nextAction' }));

        expect((await db.get('items', 'past-cal'))?.status).toBe('calendar');
        expect((await db.get('items', 'future-cal'))?.status).toBe('trash');
        const seeded = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.status === 'nextAction');
        expect(seeded).toHaveLength(1);
        const [firstItem] = seeded;
        if (!firstItem) throw new Error('expected a seeded nextAction item');
        expect(firstItem.routineId).toBe(routine._id);
    });

    it('calendar → nextAction with a transformed survivor: does not seed a duplicate open item', async () => {
        const routine = buildRoutine({ routineType: 'calendar', calendarItemTemplate: { timeOfDay: '09:00', duration: 30 } });
        await db.put('routines', routine);
        await db.put('items', buildItem({ _id: 'transformed', status: 'waitingFor' }));

        await saveEditWithoutStartDateChange(db, routine, buildCtx({ routineType: 'nextAction' }));

        const open = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.status === 'nextAction');
        expect(open).toHaveLength(0);
        expect((await db.get('items', 'transformed'))?.status).toBe('waitingFor');
    });

    it('calendar → nextAction with an exhausted new schedule: trashes nothing extra and deactivates the routine', async () => {
        const routine = buildRoutine({ routineType: 'calendar', calendarItemTemplate: { timeOfDay: '09:00', duration: 30 } });
        await db.put('routines', routine);

        await saveEditWithoutStartDateChange(db, routine, buildCtx({ routineType: 'nextAction', finalRrule: 'FREQ=DAILY;UNTIL=20200101T000000Z' }));

        const stored = await db.get('routines', routine._id);
        expect(stored?.active).toBe(false);
    });

    it('type switch combined with a startDate change also runs the transition (no orphaned old-type items)', async () => {
        const routine = buildRoutine({ routineType: 'calendar', calendarItemTemplate: { timeOfDay: '09:00', duration: 30 } });
        await db.put('routines', routine);
        const futureDate = dayjs().add(2, 'day').format('YYYY-MM-DD');
        await db.put('items', buildItem({ _id: 'future-cal-sd', status: 'calendar', timeStart: `${futureDate}T09:00:00`, timeEnd: `${futureDate}T09:30:00` }));

        await saveEditWithStartDateChange(db, routine, buildCtx({ routineType: 'nextAction', formStartDate: dayjs().format('YYYY-MM-DD') }));

        expect((await db.get('items', 'future-cal-sd'))?.status).toBe('trash');
        const seeded = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.status === 'nextAction');
        expect(seeded).toHaveLength(1);
    });
});

describe('linkedTypeSwitchSplitDate', () => {
    it('returns a split date only for a GCal-linked calendar → nextAction switch', () => {
        const linked = buildRoutine({ routineType: 'calendar', calendarEventId: 'gcal-1', calendarItemTemplate: { timeOfDay: '09:00', duration: 30 } });
        expect(linkedTypeSwitchSplitDate(linked, buildCtx({ routineType: 'nextAction' }))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // Unlinked routine, same-type edit, and nextAction source all fall through to null.
        expect(linkedTypeSwitchSplitDate(buildRoutine({ routineType: 'calendar' }), buildCtx({ routineType: 'nextAction' }))).toBeNull();
        expect(linkedTypeSwitchSplitDate(linked, buildCtx({ routineType: 'calendar' }))).toBeNull();
        expect(linkedTypeSwitchSplitDate(buildRoutine({ calendarEventId: 'gcal-1' }), buildCtx({ routineType: 'calendar' }))).toBeNull();
    });
});

describe('buildUpdatedRoutine — type-switch field hygiene', () => {
    it('drops GCal master mirrors and lastKnown* markers when switching away from calendar', () => {
        const routine = buildRoutine({
            routineType: 'calendar',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            organizer: { email: 'boss@example.com' },
            attendees: [{ email: 'boss@example.com', responseStatus: 'accepted' }],
            responseStatus: 'accepted',
            lastKnownCalendarEventId: 'old-master',
            lastKnownCalendarIntegrationId: 'integration-1',
        });

        const updated = buildUpdatedRoutine(routine, buildCtx({ routineType: 'nextAction' }), undefined);

        expect(updated.organizer).toBeUndefined();
        expect(updated.attendees).toBeUndefined();
        expect(updated.responseStatus).toBeUndefined();
        expect(updated.lastKnownCalendarEventId).toBeUndefined();
        expect(updated.lastKnownCalendarIntegrationId).toBeUndefined();
    });

    it('drops lastKnown* markers when switching to calendar (fresh master, no relink to a capped one)', () => {
        const routine = buildRoutine({ routineType: 'nextAction', lastKnownCalendarEventId: 'old-master' });
        const updated = buildUpdatedRoutine(
            routine,
            buildCtx({ routineType: 'calendar', calendarItemTemplate: { timeOfDay: '09:00', duration: 30 } }),
            undefined,
        );
        expect(updated.lastKnownCalendarEventId).toBeUndefined();
    });
});
