import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clarifyToCalendar,
    clarifyToDone,
    clarifyToInbox,
    clarifyToNextAction,
    clarifyToSomedayMaybe,
    clarifyToTrash,
    clarifyToWaitingFor,
    collectItem,
    recordRoutineInstanceModification,
    removeItem,
    updateItem,
} from '../db/itemMutations';
import { generateCalendarItemsToHorizon } from '../db/routineItemHelpers';
import { createRoutine } from '../db/routineMutations';
import { waitForPendingFlush } from '../db/syncHelpers';
import type { MyDB, StoredRoutine } from '../types/MyDB';
import { openTestDB } from './openTestDB';

// Mock sync API calls so they don't attempt to reach the server during tests
vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));
vi.mock('../lib/calendarHorizon', () => ({
    getCalendarHorizonMonths: () => 2,
}));

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
});

describe('collectItem', () => {
    it('writes an inbox item and queues a create op', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Buy milk' });

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
        const item = await collectItem(db, USER_ID, { title: 'Process inbox' });
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
        const item = await collectItem(db, USER_ID, { title: 'Process inbox' });
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
        const item = await collectItem(db, USER_ID, { title: 'Doctor appointment' });
        await db.clear('syncOperations');

        const withNextActionFields = { ...item, workContextIds: ['ctx-1'], energy: 'high' as const, waitingForPersonId: 'p-1', ignoreBefore: '2025-06-01' };
        const cal = await clarifyToCalendar(db, withNextActionFields, { timeStart: '2025-07-01T09:00:00Z', timeEnd: '2025-07-01T10:00:00Z' });

        expect(cal.status).toBe('calendar');
        expect(cal.timeStart).toBe('2025-07-01T09:00:00Z');
        expect(cal.timeEnd).toBe('2025-07-01T10:00:00Z');
        expect(cal.workContextIds).toBeUndefined();
        expect((cal as { energy?: string }).energy).toBeUndefined();
        expect(cal.waitingForPersonId).toBeUndefined();
        expect(cal.ignoreBefore).toBeUndefined();
    });

    it('sets calendarSyncConfigId and calendarIntegrationId when provided', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Team standup' });
        await db.clear('syncOperations');

        const cal = await clarifyToCalendar(db, item, {
            timeStart: '2025-07-01T09:00:00Z',
            timeEnd: '2025-07-01T10:00:00Z',
            calendarSyncConfigId: 'config-1',
            calendarIntegrationId: 'integration-1',
        });

        expect(cal.calendarSyncConfigId).toBe('config-1');
        expect(cal.calendarIntegrationId).toBe('integration-1');
    });

    it('strips stale calendarSyncConfigId when re-clarifying to calendar with default', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Moved event' });
        // First clarify with explicit config
        const withConfig = await clarifyToCalendar(db, item, {
            timeStart: '2025-07-01T09:00:00Z',
            timeEnd: '2025-07-01T10:00:00Z',
            calendarSyncConfigId: 'old-config',
            calendarIntegrationId: 'old-integration',
        });
        expect(withConfig.calendarSyncConfigId).toBe('old-config');

        // Re-clarify without config (user selected "Default")
        const withDefault = await clarifyToCalendar(db, withConfig, {
            timeStart: '2025-07-02T09:00:00Z',
            timeEnd: '2025-07-02T10:00:00Z',
        });
        expect(withDefault.calendarSyncConfigId).toBeUndefined();
        expect(withDefault.calendarIntegrationId).toBeUndefined();
    });
});

describe('clarifyToNextAction strips calendarSyncConfigId', () => {
    it('removes calendar fields including calendarSyncConfigId', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Was calendar' });
        const cal = await clarifyToCalendar(db, item, {
            timeStart: '2025-07-01T09:00:00Z',
            timeEnd: '2025-07-01T10:00:00Z',
            calendarSyncConfigId: 'config-1',
            calendarIntegrationId: 'integration-1',
        });

        const next = await clarifyToNextAction(db, cal);
        expect(next.status).toBe('nextAction');
        expect(next.calendarSyncConfigId).toBeUndefined();
        expect(next.calendarIntegrationId).toBeUndefined();
    });
});

describe('clarifyToWaitingFor', () => {
    it('sets waitingForPersonId, strips calendar/nextAction fields', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Waiting on report' });
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
        const item = await collectItem(db, USER_ID, { title: 'Finish report' });
        await db.clear('syncOperations');

        // Seed a past updatedTs so the assertion detects the refresh even within the same ms.
        const done = await clarifyToDone(db, { ...item, updatedTs: '2020-01-01T00:00:00.000Z' });

        expect(done.status).toBe('done');
        expect(done.updatedTs).not.toBe('2020-01-01T00:00:00.000Z');

        const stored = await db.get('items', done._id);
        expect(stored?.status).toBe('done');
    });

    it('auto-creates next routine item when item belongs to an active nextAction routine', async () => {
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Daily review',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY;INTERVAL=1',
            template: {},
            active: true,
        });
        const item = await collectItem(db, USER_ID, { title: 'Daily review' });
        const nextActionItem = { ...item, status: 'nextAction' as const, routineId: routine._id };
        await db.clear('syncOperations');

        await clarifyToDone(db, nextActionItem);

        // The done item + 1 new next-action item created by the routine
        const allItems = await db.getAllFromIndex('items', 'userId', USER_ID);
        const nextItems = allItems.filter((i) => i.status === 'nextAction' && i.routineId === routine._id);
        expect(nextItems).toHaveLength(1);
        expect(nextItems[0]?.expectedBy).toBeTruthy();
    });

    it('does not auto-create next item when routine is inactive', async () => {
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Paused task',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY;INTERVAL=1',
            template: {},
            active: false,
        });
        const item = await collectItem(db, USER_ID, { title: 'Paused task' });
        const nextActionItem = { ...item, status: 'nextAction' as const, routineId: routine._id };
        await db.clear('syncOperations');

        await clarifyToDone(db, nextActionItem);

        const allItems = await db.getAllFromIndex('items', 'userId', USER_ID);
        const nextItems = allItems.filter((i) => i.status === 'nextAction');
        expect(nextItems).toHaveLength(0);
    });
});

describe('clarifyToTrash', () => {
    it('sets status to trash', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Old idea' });
        await db.clear('syncOperations');

        const trashed = await clarifyToTrash(db, item);

        expect(trashed.status).toBe('trash');
        const stored = await db.get('items', trashed._id);
        expect(stored?.status).toBe('trash');
    });

    it('auto-creates next routine item when trashing a routine-linked item', async () => {
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Weekly cleanup',
            routineType: 'nextAction',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            template: {},
            active: true,
        });
        const item = await collectItem(db, USER_ID, { title: 'Weekly cleanup' });
        const nextActionItem = { ...item, status: 'nextAction' as const, routineId: routine._id };
        await db.clear('syncOperations');

        await clarifyToTrash(db, nextActionItem);

        const allItems = await db.getAllFromIndex('items', 'userId', USER_ID);
        const nextItems = allItems.filter((i) => i.status === 'nextAction' && i.routineId === routine._id);
        expect(nextItems).toHaveLength(1);
    });
});

describe('calendar routine — clarifyToDone', () => {
    it('preserves pre-populated future occurrences after disposing an instance', async () => {
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Family time',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=TH',
            template: {},
            calendarItemTemplate: { timeOfDay: '18:00', duration: 180 },
            active: true,
        });
        // Horizon is populated once at routine creation. Disposing an instance must not touch
        // future occurrences — they were already generated by the initial pass.
        await generateCalendarItemsToHorizon(db, USER_ID, routine);
        const beforeFutureCount = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter(
            (i) => i.routineId === routine._id && i.status === 'calendar',
        ).length;
        expect(beforeFutureCount).toBeGreaterThanOrEqual(1);

        const firstItem = (await db.getAllFromIndex('items', 'userId', USER_ID))
            .filter((i) => i.routineId === routine._id && i.status === 'calendar')
            .sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''))[0];
        if (!firstItem) {
            throw new Error('Expected at least one calendar item after the initial horizon pass');
        }
        await db.clear('syncOperations');

        await clarifyToDone(db, firstItem);

        const remainingFuture = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === routine._id && i.status === 'calendar');
        // All prior calendar items minus the disposed one are still present, no duplicates added.
        expect(remainingFuture.length).toBe(beforeFutureCount - 1);
    });

    it('does not create a duplicate calendar item on the disposed date (matrix A8 regression)', async () => {
        // Matrix A8: completing an instance must leave future items in the series unchanged —
        // including the disposed date itself. The old regen-on-every-dispose path had a dedupe
        // that was tight in isolation but produced a phantom duplicate at runtime; the current
        // implementation skips the horizon pass entirely when the series already has a live
        // future calendar item, eliminating the risk.
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Weekly standup',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            template: {},
            calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
            active: true,
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const firstItem = (await db.getAllFromIndex('items', 'userId', USER_ID))
            .filter((i) => i.routineId === routine._id && i.status === 'calendar')
            .sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''))[0];
        if (!firstItem) {
            throw new Error('Expected at least one calendar item from the initial horizon pass');
        }
        const disposedDate = (firstItem.timeStart ?? '').slice(0, 10);

        await clarifyToDone(db, firstItem);

        const afterItems = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === routine._id);
        const itemsOnDate = afterItems.filter((i) => (i.timeStart ?? '').startsWith(disposedDate));
        expect(itemsOnDate).toHaveLength(1);
        expect(itemsOnDate[0]?.status).toBe('done');

        // Completion must not mutate routineExceptions (matrix A8 explicit assertion), and the
        // routine must stay active — plenty of future Mondays remain in the series.
        const afterRoutine = await db.get('routines', routine._id);
        expect(afterRoutine?.routineExceptions ?? []).toEqual([]);
        expect(afterRoutine?.active).toBe(true);
    });

    it('deactivates a COUNT=1 routine when its sole occurrence is done', async () => {
        // COUNT=1 one-shots exhaust on first completion. The exhaustion check in the disposal
        // path deactivates the routine so it doesn't linger as an active-but-itemless row.
        const pastDate = dayjs().subtract(7, 'day');
        const routine: StoredRoutine = {
            _id: crypto.randomUUID(),
            userId: USER_ID,
            title: 'One-time event',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY;COUNT=1',
            template: {},
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            active: true,
            createdTs: pastDate.toISOString(),
            updatedTs: pastDate.toISOString(),
        };
        await db.put('routines', routine);

        const item = await collectItem(db, USER_ID, { title: 'One-time event' });
        const calItem = {
            ...item,
            status: 'calendar' as const,
            routineId: routine._id,
            timeStart: `${pastDate.format('YYYY-MM-DD')}T09:00:00`,
            timeEnd: `${pastDate.format('YYYY-MM-DD')}T09:30:00`,
        };
        await db.clear('syncOperations');

        await clarifyToDone(db, calItem);

        const updatedRoutine = await db.get('routines', routine._id);
        expect(updatedRoutine?.active).toBe(false);
    });

    it('late-completion (done with timeStart far in the past) is a no-op on routine state', async () => {
        // Decoupled-disposal contract: done never adds a routineException and never extends the
        // horizon, regardless of how late the completion is. If the user wants to re-populate an
        // exhausted series they do it via RoutineDialog / rrule-edit, not via disposal.
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Weekly sync',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            template: {},
            calendarItemTemplate: { timeOfDay: '10:00', duration: 60 },
            active: true,
        });

        const item = await collectItem(db, USER_ID, { title: 'Weekly sync' });
        const calItem = {
            ...item,
            status: 'calendar' as const,
            routineId: routine._id,
            timeStart: '2020-01-06T10:00:00',
            timeEnd: '2020-01-06T11:00:00',
        };
        await db.clear('syncOperations');

        await clarifyToDone(db, calItem);

        const afterRoutine = await db.get('routines', routine._id);
        expect(afterRoutine?.routineExceptions ?? []).toEqual([]);
        const generatedItems = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === routine._id && i.status === 'calendar');
        expect(generatedItems).toHaveLength(0);
    });

    it('disposes today-dated instance without creating a phantom (matrix A8, smoke run #5)', async () => {
        // Run #5 reproducer: routine whose first occurrence is TODAY. User clicks Done on today's
        // instance. The disposed item's timeStart is `today 09:00`, which may already be "past"
        // wall-clock time depending on when the test runs. The horizon guard must still consider
        // this date as "claimed" so no phantom calendar item is created on today's date.
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Weekly Wed',
            routineType: 'calendar',
            rrule: `FREQ=WEEKLY;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][dayjs().day()]}`,
            template: {},
            calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
            active: true,
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const todayStr = dayjs().format('YYYY-MM-DD');
        const todayItem = (await db.getAllFromIndex('items', 'userId', USER_ID)).find(
            (i) => i.routineId === routine._id && (i.timeStart ?? '').startsWith(todayStr),
        );
        if (!todayItem) {
            throw new Error(`Expected a today-dated (${todayStr}) calendar item from the initial horizon pass`);
        }

        await clarifyToDone(db, todayItem);

        const afterItems = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === routine._id);
        const itemsOnToday = afterItems.filter((i) => (i.timeStart ?? '').startsWith(todayStr));
        expect(itemsOnToday).toHaveLength(1);
        expect(itemsOnToday[0]?.status).toBe('done');

        // And future occurrences remain live, unchanged in count.
        const futureCalendar = afterItems.filter((i) => i.status === 'calendar' && (i.timeStart ?? '') > todayStr);
        expect(futureCalendar.length).toBeGreaterThanOrEqual(1);
    });

    it('double-save of the same stale item snapshot does not leak a phantom calendar duplicate (matrix A8, smoke run #4)', async () => {
        // Matches the observed smoke flow: user clicks Done, the UI appears unchanged (React state
        // not refreshed), so they reopen the dialog and click Done+Save again using the same
        // pre-save `StoredItem` snapshot (its status is still 'calendar'). Both clarifyToDone calls
        // must converge on a single 'done' item for the disposed date.
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Weekly standup',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            template: {},
            calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
            active: true,
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const staleFirstItem = (await db.getAllFromIndex('items', 'userId', USER_ID))
            .filter((i) => i.routineId === routine._id && i.status === 'calendar')
            .sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''))[0];
        if (!staleFirstItem) {
            throw new Error('Expected at least one calendar item from the initial horizon pass');
        }
        const disposedDate = (staleFirstItem.timeStart ?? '').slice(0, 10);

        await clarifyToDone(db, staleFirstItem);
        // Second save reuses the same pre-save snapshot (its status is still 'calendar') —
        // this is what EditItemDialog does when it doesn't refresh after the first save.
        await clarifyToDone(db, staleFirstItem);

        const afterItems = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === routine._id);
        const itemsOnDate = afterItems.filter((i) => (i.timeStart ?? '').startsWith(disposedDate));
        expect(itemsOnDate).toHaveLength(1);
        expect(itemsOnDate[0]?.status).toBe('done');

        const afterRoutine = await db.get('routines', routine._id);
        expect(afterRoutine?.routineExceptions ?? []).toEqual([]);
    });
});

describe('calendar routine — clarifyToTrash', () => {
    it('does not create a duplicate calendar item on the disposed date when trashed before due', async () => {
        // Companion to the A8-done regression: when a pre-populated routine has a live future
        // item on another date, trashing one instance must not leave two items on the same date.
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Weekly standup',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            template: {},
            calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
            active: true,
        });
        await generateCalendarItemsToHorizon(db, USER_ID, routine);

        const firstItem = (await db.getAllFromIndex('items', 'userId', USER_ID))
            .filter((i) => i.routineId === routine._id && i.status === 'calendar')
            .sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''))[0];
        if (!firstItem) {
            throw new Error('Expected at least one calendar item from the initial horizon pass');
        }
        const disposedDate = (firstItem.timeStart ?? '').slice(0, 10);

        await clarifyToTrash(db, firstItem);

        const afterItems = (await db.getAllFromIndex('items', 'userId', USER_ID)).filter((i) => i.routineId === routine._id);
        const itemsOnDate = afterItems.filter((i) => (i.timeStart ?? '').startsWith(disposedDate));
        expect(itemsOnDate).toHaveLength(1);
        expect(itemsOnDate[0]?.status).toBe('trash');

        // Trash-before-due still records a skipped exception so the date won't be regenerated later.
        const afterRoutine = await db.get('routines', routine._id);
        expect(afterRoutine?.routineExceptions).toEqual([{ date: disposedDate, type: 'skipped' }]);
    });

    it('records a skipped exception when trashed before due', async () => {
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Morning run',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=SA',
            template: {},
            calendarItemTemplate: { timeOfDay: '07:00', duration: 60 },
            active: true,
        });

        const item = await collectItem(db, USER_ID, { title: 'Morning run' });
        // timeStart in the future to simulate trashing before due
        const futureStart = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const calItem = {
            ...item,
            status: 'calendar' as const,
            routineId: routine._id,
            timeStart: `${futureStart}T07:00:00`,
            timeEnd: `${futureStart}T08:00:00`,
        };
        await db.clear('syncOperations');

        await clarifyToTrash(db, calItem);

        // Exception is recorded on the routine; subsequent horizon passes will skip this date.
        const updatedRoutine = await db.get('routines', routine._id);
        expect(updatedRoutine?.routineExceptions).toHaveLength(1);
        expect(updatedRoutine?.routineExceptions?.[0]).toEqual({ date: futureStart, type: 'skipped' });
    });

    it('deactivates a COUNT=1 routine when its sole occurrence is trashed before due', async () => {
        // COUNT=1 one-shots exhaust on first disposal. The exhaustion check in the disposal path
        // deactivates the routine so it doesn't linger as an active-but-itemless row.
        const pastDate = dayjs().subtract(7, 'day');
        const routine: StoredRoutine = {
            _id: crypto.randomUUID(),
            userId: USER_ID,
            title: 'One-time event',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY;COUNT=1',
            template: {},
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            active: true,
            createdTs: pastDate.toISOString(),
            updatedTs: pastDate.toISOString(),
        };
        await db.put('routines', routine);

        const item = await collectItem(db, USER_ID, { title: 'One-time event' });
        const futureStart = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const calItem = {
            ...item,
            status: 'calendar' as const,
            routineId: routine._id,
            timeStart: `${futureStart}T09:00:00`,
            timeEnd: `${futureStart}T09:30:00`,
        };
        await db.clear('syncOperations');

        await clarifyToTrash(db, calItem);

        const updatedRoutine = await db.get('routines', routine._id);
        expect(updatedRoutine?.active).toBe(false);
    });
});

describe('updateItem', () => {
    it('refreshes updatedTs and queues update op', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Original title' });
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
        const item = await collectItem(db, USER_ID, { title: 'To delete' });
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

describe('clarifyToInbox', () => {
    it('strips all status-specific fields and keeps notes + peopleIds + routineId', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Back to inbox' });
        const mixed = {
            ...item,
            status: 'nextAction' as const,
            routineId: 'routine-1',
            notes: 'kept',
            peopleIds: ['p-1'],
            workContextIds: ['ctx-1'],
            energy: 'high' as const,
            time: 30,
            urgent: true,
            focus: true,
            expectedBy: '2026-01-01',
            ignoreBefore: '2025-06-01',
            timeStart: '2025-07-01T09:00:00Z',
            timeEnd: '2025-07-01T10:00:00Z',
            calendarEventId: 'evt-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'cfg-1',
            waitingForPersonId: 'p-9',
        };

        const back = await clarifyToInbox(db, mixed);

        expect(back.status).toBe('inbox');
        expect(back.notes).toBe('kept');
        expect(back.peopleIds).toEqual(['p-1']);
        expect(back.routineId).toBe('routine-1');
        expect(back.workContextIds).toBeUndefined();
        expect((back as { energy?: string }).energy).toBeUndefined();
        expect(back.time).toBeUndefined();
        expect(back.urgent).toBeUndefined();
        expect(back.focus).toBeUndefined();
        expect(back.expectedBy).toBeUndefined();
        expect(back.ignoreBefore).toBeUndefined();
        expect(back.timeStart).toBeUndefined();
        expect(back.timeEnd).toBeUndefined();
        expect(back.calendarEventId).toBeUndefined();
        expect(back.calendarIntegrationId).toBeUndefined();
        expect(back.calendarSyncConfigId).toBeUndefined();
        expect(back.waitingForPersonId).toBeUndefined();
    });

    it('queues an update op', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Back again' });
        await db.clear('syncOperations');

        const back = await clarifyToInbox(db, item);
        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('update');
        expect(ops[0]?.entityId).toBe(back._id);
    });
});

describe('clarifyToSomedayMaybe', () => {
    it('sets status to somedayMaybe and strips all status-specific fields', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Learn Rust' });
        // Seed a rich, mixed-status shape — clarifyToSomedayMaybe should remove everything
        // except title, notes, peopleIds, and routineId.
        const mixed = {
            ...item,
            workContextIds: ['ctx-1'],
            energy: 'medium' as const,
            time: 30,
            urgent: true,
            focus: true,
            expectedBy: '2026-01-01',
            ignoreBefore: '2025-06-01',
            timeStart: '2025-07-01T09:00:00Z',
            timeEnd: '2025-07-01T10:00:00Z',
            calendarEventId: 'evt-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'cfg-1',
            waitingForPersonId: 'p-1',
            peopleIds: ['p-2'],
            notes: 'parking lot',
        };

        const sm = await clarifyToSomedayMaybe(db, mixed);

        expect(sm.status).toBe('somedayMaybe');
        expect(sm.notes).toBe('parking lot');
        expect(sm.peopleIds).toEqual(['p-2']);
        expect(sm.workContextIds).toBeUndefined();
        expect((sm as { energy?: string }).energy).toBeUndefined();
        expect(sm.time).toBeUndefined();
        expect(sm.urgent).toBeUndefined();
        expect(sm.focus).toBeUndefined();
        expect(sm.expectedBy).toBeUndefined();
        expect(sm.ignoreBefore).toBeUndefined();
        expect(sm.timeStart).toBeUndefined();
        expect(sm.timeEnd).toBeUndefined();
        expect(sm.calendarEventId).toBeUndefined();
        expect(sm.calendarIntegrationId).toBeUndefined();
        expect(sm.calendarSyncConfigId).toBeUndefined();
        expect(sm.waitingForPersonId).toBeUndefined();
    });

    it('queues an update op', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Maybe later' });
        await db.clear('syncOperations');

        const sm = await clarifyToSomedayMaybe(db, item);

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('update');
        expect(ops[0]?.entityId).toBe(sm._id);
    });
});

describe('recordRoutineInstanceModification', () => {
    it('adds a modified exception with the supplied time override', async () => {
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Weekly sync',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            template: {},
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            active: true,
        });
        await db.clear('syncOperations');

        await recordRoutineInstanceModification(db, routine._id, '2026-05-04', {
            itemId: 'item-1',
            newTimeStart: '2026-05-04T11:00:00',
            newTimeEnd: '2026-05-04T11:30:00',
        });

        const updated = await db.get('routines', routine._id);
        expect(updated?.routineExceptions).toHaveLength(1);
        expect(updated?.routineExceptions?.[0]).toEqual({
            date: '2026-05-04',
            type: 'modified',
            itemId: 'item-1',
            newTimeStart: '2026-05-04T11:00:00',
            newTimeEnd: '2026-05-04T11:30:00',
        });
    });

    it('replaces an existing exception on the same date rather than duplicating', async () => {
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Standup',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY',
            template: {},
            calendarItemTemplate: { timeOfDay: '09:00', duration: 15 },
            active: true,
            routineExceptions: [{ date: '2026-05-04', type: 'modified' as const, itemId: 'old', newTimeStart: '2026-05-04T10:00:00' }],
        });

        await recordRoutineInstanceModification(db, routine._id, '2026-05-04', {
            itemId: 'item-1',
            newTimeStart: '2026-05-04T14:00:00',
        });

        const updated = await db.get('routines', routine._id);
        expect(updated?.routineExceptions).toHaveLength(1);
        expect(updated?.routineExceptions?.[0]?.newTimeStart).toBe('2026-05-04T14:00:00');
        expect(updated?.routineExceptions?.[0]?.itemId).toBe('item-1');
    });

    it('no-ops when the routine does not exist', async () => {
        await expect(
            recordRoutineInstanceModification(db, 'missing-routine', '2026-05-04', { itemId: 'item-1', newTimeStart: '2026-05-04T10:00:00' }),
        ).resolves.toBeUndefined();
    });
});
