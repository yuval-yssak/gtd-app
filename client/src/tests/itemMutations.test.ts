import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createRoutine } from '../db/routineMutations';
import { waitForPendingFlush } from '../db/syncHelpers';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

// Mock sync API calls so they don't attempt to reach the server during tests
vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

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
    it('creates the next calendar item on-time with correct timeStart for the following occurrence', async () => {
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'Family time',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=TH',
            template: {},
            calendarItemTemplate: { timeOfDay: '18:00', duration: 180 },
            active: true,
        });

        // The routine's createdTs is "now" (today), so DTSTART = today. We use the next Thursday
        // from today as the item's timeStart so the rrule can find a following occurrence.
        // 2026-04-09 is the first Thursday on or after the test run date of 2026-04-04.
        const item = await collectItem(db, USER_ID, { title: 'Family time' });
        const calItem = {
            ...item,
            status: 'calendar' as const,
            routineId: routine._id,
            timeStart: '2026-04-09T18:00:00',
            timeEnd: '2026-04-09T21:00:00',
        };
        await db.clear('syncOperations');

        await clarifyToDone(db, calItem);

        const allItems = await db.getAllFromIndex('items', 'userId', USER_ID);
        const nextItems = allItems.filter((i) => i.status === 'calendar' && i.routineId === routine._id);
        expect(nextItems).toHaveLength(1);
        // On-time completion from 2026-04-09 (Thu) → next Thu is 2026-04-16
        expect(nextItems[0]?.timeStart?.startsWith('2026-04-16')).toBe(true);
        // timeEnd must use the same naive local-time format as timeStart (no Z suffix)
        expect(nextItems[0]?.timeEnd?.startsWith('2026-04-16')).toBe(true);
        expect(nextItems[0]?.timeEnd?.endsWith('Z')).toBe(false);
    });

    it('advances from now when completion is more than 24h late', async () => {
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
        // timeStart far in the past (before DTSTART = today) — completion is definitely late
        const calItem = {
            ...item,
            status: 'calendar' as const,
            routineId: routine._id,
            timeStart: '2020-01-06T10:00:00',
            timeEnd: '2020-01-06T11:00:00',
        };
        await db.clear('syncOperations');

        await clarifyToDone(db, calItem);

        const allItems = await db.getAllFromIndex('items', 'userId', USER_ID);
        const nextItems = allItems.filter((i) => i.status === 'calendar' && i.routineId === routine._id);
        expect(nextItems).toHaveLength(1);
        // Late path uses yesterday as refDate → next Monday is 2026-04-13 since we're past Monday 2026-04-06
        expect(nextItems[0]?.timeStart?.startsWith('2026-04-13')).toBe(true);
    });
});

describe('calendar routine — clarifyToTrash', () => {
    it('records a skipped exception and creates next item from the skipped date when trashed before due', async () => {
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

        // Exception should be recorded on the routine
        const updatedRoutine = await db.get('routines', routine._id);
        expect(updatedRoutine?.routineExceptions).toHaveLength(1);
        expect(updatedRoutine?.routineExceptions?.[0]?.type).toBe('skipped');

        // A new calendar item should be created (for the occurrence after the skipped one)
        const allItems = await db.getAllFromIndex('items', 'userId', USER_ID);
        const nextItems = allItems.filter((i) => i.status === 'calendar' && i.routineId === routine._id);
        expect(nextItems).toHaveLength(1);
        // Next item must be AFTER the skipped date
        // Parens required: ?? has lower precedence than > so without them the comparison is never reached
        expect((nextItems[0]?.timeStart ?? '') > calItem.timeStart).toBe(true);
    });

    it('deactivates the routine when rrule series is exhausted', async () => {
        // COUNT=1 means only one occurrence ever; completing it should exhaust the series
        const routine = await createRoutine(db, {
            userId: USER_ID,
            title: 'One-time event',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY;COUNT=1',
            template: {},
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            active: true,
        });

        const item = await collectItem(db, USER_ID, { title: 'One-time event' });
        // timeStart yesterday so it's in the past (on-time completion path)
        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
        const calItem = {
            ...item,
            status: 'calendar' as const,
            routineId: routine._id,
            timeStart: `${yesterday}T09:00:00`,
            timeEnd: `${yesterday}T09:30:00`,
        };
        await db.clear('syncOperations');

        await clarifyToDone(db, calItem);

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
