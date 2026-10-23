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
    nonIncreasingRun,
    recordRoutineInstanceModification,
    removeItem,
    reorderItem,
    updateItem,
} from '../db/itemMutations';
import { generateCalendarItemsToHorizon } from '../db/routineItemHelpers';
import { createRoutine } from '../db/routineMutations';
import { waitForPendingFlush } from '../db/syncHelpers';
import { compareNextActions } from '../lib/compareNextActions';
import * as itemRank from '../lib/itemRank';
import { compareRank, isStrictlyIncreasing } from '../lib/itemRank';
import { getGhostSnapshots, resetGhostStore } from '../lib/listGhosts';
import type { MyDB, StoredItem, StoredRoutine } from '../types/MyDB';
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
    // Every status-changing mutation records into the module-level ghost store — reset so
    // ghosts from one test can't leak into another's assertions.
    resetGhostStore();
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

    it('mints each new item a rank above the previous one (the origin first)', async () => {
        const first = await collectItem(db, USER_ID, { title: 'first' });
        const second = await collectItem(db, USER_ID, { title: 'second' });
        expect(first.rank).toBe('a0');
        expect(second.rank).toBeDefined();
        expect(compareRank(second.rank ?? '', first.rank ?? '')).toBe(-1);
    });
});

describe('clarifyToNextAction', () => {
    it('mints a FRESH rank when an inbox capture is clarified, keeps it on other transitions, and mints for an unranked item', async () => {
        const ranked = await collectItem(db, USER_ID, { title: 'ranked' });
        const fresh = await clarifyToNextAction(db, ranked, {});
        expect(fresh.rank).toBeDefined();
        expect(compareRank(fresh.rank ?? '', ranked.rank ?? '')).toBe(-1);
        const kept = await clarifyToNextAction(db, { ...fresh, status: 'somedayMaybe' }, {});
        expect(kept.rank).toBe(fresh.rank);
        const { rank: _r, ...legacy } = await collectItem(db, USER_ID, { title: 'legacy' });
        await db.put('items', legacy);
        const minted = await clarifyToNextAction(db, legacy, {});
        expect(minted.rank).toBeDefined();
        expect(compareRank(minted.rank ?? '', ranked.rank ?? '')).toBe(-1);
    });

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

    it('strips expectedBy — disallowed on calendar status, would 400 /sync/push and jam the queue', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Pay for thermostat replacement' });
        await db.clear('syncOperations');

        const withDeadline = { ...item, status: 'nextAction' as const, expectedBy: '2026-07-14', ignoreBefore: '2026-07-12', energy: 'low' as const, time: 30 };
        const cal = await clarifyToCalendar(db, withDeadline, { timeStart: '2026-07-16T09:00:00', timeEnd: '2026-07-16T09:30:00' });

        expect(cal.expectedBy).toBeUndefined();
        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one sync op');
        expect((op.snapshot as { expectedBy?: string }).expectedBy).toBeUndefined();
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

    // `done` is an archival status — it preserves whatever status-specific fields the item carried
    // at completion (timeStart, energy, etc.) so historical queries (e.g. "items completed for
    // date X" via timeStart) keep working. The server-side matrix mirrors this allowance for the
    // `done` and `trash` statuses; new statuses like `nextAction` and `calendar` enforce field
    // gating actively.
    it('invokes onReadOnlyGCal when transitioning a fromGmail calendar item with a calendarEventId to done', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Gmail-created meeting' });
        const fromGmailItem: StoredItem = {
            ...item,
            status: 'calendar',
            timeStart: '2026-05-09T10:00:00.000Z',
            timeEnd: '2026-05-09T11:00:00.000Z',
            calendarEventId: 'evt-fromgmail',
            calendarIntegrationId: 'integ-1',
            eventType: 'fromGmail',
        };
        await db.clear('syncOperations');

        const onReadOnlyGCal = vi.fn();
        const done = await clarifyToDone(db, fromGmailItem, { onReadOnlyGCal });

        expect(done.status).toBe('done');
        expect(onReadOnlyGCal).toHaveBeenCalledOnce();
    });

    it('does not invoke onReadOnlyGCal for non-fromGmail calendar items', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Regular meeting' });
        const calItem: StoredItem = {
            ...item,
            status: 'calendar',
            timeStart: '2026-05-09T10:00:00.000Z',
            timeEnd: '2026-05-09T11:00:00.000Z',
            calendarEventId: 'evt-regular',
            calendarIntegrationId: 'integ-1',
            eventType: 'default',
        };
        await db.clear('syncOperations');

        const onReadOnlyGCal = vi.fn();
        await clarifyToDone(db, calItem, { onReadOnlyGCal });

        expect(onReadOnlyGCal).not.toHaveBeenCalled();
    });

    it('does not invoke onReadOnlyGCal when calendarEventId is missing (no GCal-side push would have fired)', async () => {
        // eventType could be 'fromGmail' on a row that was never linked to GCal (e.g. local-only
        // mutation that copied the field). Without a calendarEventId the server would never push,
        // so the warning would be misleading.
        const item = await collectItem(db, USER_ID, { title: 'Orphan' });
        const orphanFromGmail: StoredItem = {
            ...item,
            status: 'calendar',
            timeStart: '2026-05-09T10:00:00.000Z',
            timeEnd: '2026-05-09T11:00:00.000Z',
            eventType: 'fromGmail',
        };
        await db.clear('syncOperations');

        const onReadOnlyGCal = vi.fn();
        await clarifyToDone(db, orphanFromGmail, { onReadOnlyGCal });

        expect(onReadOnlyGCal).not.toHaveBeenCalled();
    });

    it('does not throw when onReadOnlyGCal is omitted for a fromGmail item', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Gmail no-callback' });
        const fromGmailItem: StoredItem = {
            ...item,
            status: 'calendar',
            timeStart: '2026-05-09T10:00:00.000Z',
            timeEnd: '2026-05-09T11:00:00.000Z',
            calendarEventId: 'evt-no-cb',
            eventType: 'fromGmail',
        };
        await db.clear('syncOperations');

        // No opts at all — must not throw.
        await expect(clarifyToDone(db, fromGmailItem)).resolves.toMatchObject({ status: 'done' });
    });

    it('fires onReadOnlyGCal AFTER the local IDB write persists', async () => {
        // Locks in the doc-comment contract: by the time the callback runs, the IDB row is
        // already 'done'. The callback snapshots the row it reads at fire time; we await that
        // read directly (rather than racing a setTimeout against fake-indexeddb's internal read
        // timer, which flaked under full-suite load) before asserting.
        const item = await collectItem(db, USER_ID, { title: 'order-of-ops' });
        const fromGmailItem: StoredItem = {
            ...item,
            status: 'calendar',
            timeStart: '2026-05-09T10:00:00.000Z',
            timeEnd: '2026-05-09T11:00:00.000Z',
            calendarEventId: 'evt-order',
            eventType: 'fromGmail',
        };
        await db.clear('syncOperations');

        let readAtCallback: Promise<StoredItem | undefined> | undefined;
        const onReadOnlyGCal = vi.fn(() => {
            readAtCallback = db.get('items', fromGmailItem._id);
        });
        await clarifyToDone(db, fromGmailItem, { onReadOnlyGCal });

        expect(onReadOnlyGCal).toHaveBeenCalledOnce();
        const storedAtCallback = await readAtCallback;
        expect(storedAtCallback?.status).toBe('done');
    });

    it('preserves prior status-specific fields when transitioning to done (audit trail)', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Calendar to done' });
        const calItem: StoredItem = {
            ...item,
            status: 'calendar',
            timeStart: '2026-05-09T10:00:00.000Z',
            timeEnd: '2026-05-09T11:00:00.000Z',
            calendarEventId: 'evt-1',
            calendarIntegrationId: 'integ-1',
        };
        await db.clear('syncOperations');

        const done = await clarifyToDone(db, calItem);

        expect(done.status).toBe('done');
        expect(done.timeStart).toBe('2026-05-09T10:00:00.000Z');
        expect(done.timeEnd).toBe('2026-05-09T11:00:00.000Z');
        expect(done.calendarEventId).toBe('evt-1');
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

    // Mirror of the clarifyToDone audit-trail test — `trash` is also archival, so we keep the
    // prior status-specific fields rather than shedding them. The disposal-marker tests below
    // rely on this (timeStart on the trashed instance lets us reason about which date it covered).
    it('preserves prior status-specific fields when trashing a calendar item (audit trail)', async () => {
        const item = await collectItem(db, USER_ID, { title: 'Cancel meeting' });
        const calItem: StoredItem = {
            ...item,
            status: 'calendar',
            timeStart: '2026-05-09T10:00:00.000Z',
            timeEnd: '2026-05-09T11:00:00.000Z',
            calendarEventId: 'evt-1',
            calendarIntegrationId: 'integ-1',
        };
        await db.clear('syncOperations');

        const trashed = await clarifyToTrash(db, calItem);

        expect(trashed.status).toBe('trash');
        expect(trashed.timeStart).toBe('2026-05-09T10:00:00.000Z');
        expect(trashed.timeEnd).toBe('2026-05-09T11:00:00.000Z');
        expect(trashed.calendarEventId).toBe('evt-1');
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

        // Pick the first future item — `clarifyToTrash` only records a 'skipped' exception when
        // trashed before the occurrence's start, so picking today's already-past instance would
        // skip the exception path entirely. Items use local-time `timeStart` (no Z), so compare via dayjs.
        const now = dayjs();
        const firstItem = (await db.getAllFromIndex('items', 'userId', USER_ID))
            .filter((i) => i.routineId === routine._id && i.status === 'calendar' && i.timeStart !== undefined && now.isBefore(dayjs(i.timeStart)))
            .sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''))[0];
        if (!firstItem) {
            throw new Error('Expected at least one future calendar item from the initial horizon pass');
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

describe('reorderItem / ensureRunRanked', () => {
    async function seedSection(ranks: Array<string | undefined>, overrides: Partial<StoredItem>[] = []): Promise<StoredItem[]> {
        const items = await Promise.all(
            ranks.map(async (rank, idx) => {
                const item: StoredItem = {
                    _id: `row-${idx}`,
                    userId: USER_ID,
                    status: 'nextAction',
                    title: `row ${idx}`,
                    createdTs: '2026-01-01T00:00:00.000Z',
                    updatedTs: '2026-01-01T00:00:00.000Z',
                    ...(rank === undefined ? {} : { rank }),
                    ...(overrides[idx] ?? {}),
                };
                await db.put('items', item);
                return item;
            }),
        );
        await db.clear('syncOperations');
        return items;
    }

    async function storedRank(id: string): Promise<string> {
        const row = await db.get('items', id);
        if (row?.rank === undefined) throw new Error(`expected a rank on ${id}`);
        return row.rank;
    }

    function four(items: StoredItem[]): [StoredItem, StoredItem, StoredItem, StoredItem] {
        const [a, b, c, d] = items;
        if (!a || !b || !c || !d) throw new Error('expected four rows');
        return [a, b, c, d];
    }

    it('happy path: writes ONE row with a key between its neighbours and queues ONE update op', async () => {
        const [a, b, c, d] = four(await seedSection(['a0', 'a1', 'a2', 'a3']));
        const moved = await reorderItem(db, { sectionItems: [a, b, c, d], itemId: d._id, aboveId: a._id, belowId: b._id });
        if (!moved) throw new Error('expected a move');
        expect(compareRank('a0', moved.rank ?? '') < 0 && compareRank(moved.rank ?? '', 'a1') < 0).toBe(true);
        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one op');
        expect(op.entityId).toBe('row-3');
        expect(op.opType).toBe('update');
        // Untouched neighbours keep their rows exactly.
        expect(await db.get('items', 'row-0')).toEqual(a);
        expect(await db.get('items', 'row-1')).toEqual(b);
        expect(moved.expectedBy).toBeUndefined();
    });

    it.each(['inbox', 'somedayMaybe'] as const)('%s rows reorder within their one section (no day keying)', async (status) => {
        const items = await seedSection(['a0', 'a1', 'a2'], [{ status }, { status, expectedBy: '2026-11-01' }, { status }]);
        const [a, , c] = items;
        if (!a || !c) throw new Error('seed');
        const moved = await reorderItem(db, { sectionItems: items, itemId: c._id, aboveId: undefined, belowId: a._id });
        expect(moved?.status).toBe(status);
        expect(compareRank(await storedRank(c._id), await storedRank(a._id))).toBeLessThan(0);
    });

    it('waiting-for rows reorder within their expected day only; another day is another section', async () => {
        const items = await seedSection(
            ['a0', 'a1', 'a2'],
            [
                { status: 'waitingFor', expectedBy: '2026-11-01' },
                { status: 'waitingFor', expectedBy: '2026-11-01' },
                { status: 'waitingFor', expectedBy: '2026-11-02' },
            ],
        );
        const [a, b, c] = items;
        if (!a || !b || !c) throw new Error('seed');
        const moved = await reorderItem(db, { sectionItems: [a, b], itemId: b._id, aboveId: undefined, belowId: a._id });
        expect(compareRank(await storedRank(b._id), await storedRank(a._id))).toBeLessThan(0);
        expect(moved?.expectedBy).toBe('2026-11-01');
        // A neighbour from another day is a different section: nothing is written.
        expect(await reorderItem(db, { sectionItems: [a, c], itemId: c._id, aboveId: undefined, belowId: a._id })).toBeNull();
    });

    it('a row whose status changed since the page rendered (shown as inbox, stored as nextAction) writes nothing', async () => {
        const items = await seedSection(['a0', 'a1'], [{ status: 'nextAction' }, { status: 'nextAction' }]);
        const [a, b] = items;
        if (!a || !b) throw new Error('seed');
        const shownAsInbox = [
            { ...a, status: 'inbox' as const },
            { ...b, status: 'inbox' as const },
        ];
        expect(await reorderItem(db, { sectionItems: shownAsInbox, itemId: b._id, aboveId: undefined, belowId: a._id })).toBeNull();
    });

    it('a calendar row has no manual order: nothing is written', async () => {
        const items = await seedSection(['a0', 'a1'], [{ status: 'calendar' }, { status: 'calendar' }]);
        const [a, b] = items;
        if (!a || !b) throw new Error('seed');
        expect(await reorderItem(db, { sectionItems: items, itemId: b._id, aboveId: undefined, belowId: a._id })).toBeNull();
    });

    it('a drop at the top / bottom of the section uses an open end', async () => {
        const items = await seedSection(['a0', 'a1', 'a2']);
        const [a, b, c] = items;
        if (!a || !b || !c) throw new Error('expected three rows');
        const top = await reorderItem(db, { sectionItems: items, itemId: c._id, aboveId: undefined, belowId: a._id });
        if (!top) throw new Error('expected a move');
        expect(compareRank(top.rank ?? '', 'a0')).toBe(-1);
        const bottom = await reorderItem(db, { sectionItems: [top, a, b], itemId: a._id, aboveId: b._id, belowId: undefined });
        if (!bottom) throw new Error('expected a move');
        expect(compareRank(bottom.rank ?? '', 'a1')).toBe(1);
    });

    it('is a no-op (null, no write) when the row already sits in the requested slot', async () => {
        const items = await seedSection(['a0', 'a1', 'a2']);
        const [a, b, c] = items;
        if (!a || !b || !c) throw new Error('expected three rows');
        expect(await reorderItem(db, { sectionItems: items, itemId: b._id, aboveId: a._id, belowId: c._id })).toBeNull();
        expect(await reorderItem(db, { sectionItems: items, itemId: a._id, aboveId: undefined, belowId: b._id })).toBeNull();
        expect(await db.getAll('syncOperations')).toHaveLength(0);
    });

    it('equal neighbours (concurrent mints) → only that run is re-keyed, then the move lands between them', async () => {
        const items = await seedSection(['Zz', 'a0', 'a0', 'a1', 'a2']);
        const [z, a, b, c, d] = items;
        if (!z || !a || !b || !c || !d) throw new Error('expected five rows');
        const spy = vi.spyOn(itemRank, 'rankBetween');
        const moved = await reorderItem(db, { sectionItems: items, itemId: d._id, aboveId: a._id, belowId: b._id });
        if (!moved) throw new Error('expected a move');
        expect(spy).toHaveBeenCalled();
        for (const [above, below] of spy.mock.calls) {
            if (above && below) {
                expect(compareRank(above, below)).toBe(-1);
            }
        }
        spy.mockRestore();
        const ranks = await Promise.all(['row-0', 'row-1', 'row-4', 'row-2', 'row-3'].map(storedRank));
        expect(isStrictlyIncreasing(ranks)).toBe(true);
        // Only ONE of the equal pair (row-1, re-keyed between Zz and a0) and the moved row were written —
        // row-2's key already fits, and the ordered rows around the run are untouched.
        const written = (await db.getAll('syncOperations')).map((op) => op.entityId).sort();
        expect(written).toEqual(['row-1', 'row-4']);
        expect(await db.get('items', 'row-0')).toEqual(z);
        expect(await db.get('items', 'row-2')).toEqual(b);
        expect(await db.get('items', 'row-3')).toEqual(c);
    });

    // No "inverted neighbours" case: the visible rows come from the comparator, which orders ranked
    // rows by key, so `above` can never carry a larger key than `below` — only EQUAL keys (two mints
    // that collided) and unranked rows reach the re-key path.

    it('an unranked neighbour (pre-rollout row) → re-keyed first', async () => {
        const items = await seedSection([undefined, 'a0', 'a1']);
        const [a, b, c] = items;
        if (!a || !b || !c) throw new Error('expected three rows');
        const moved = await reorderItem(db, { sectionItems: items, itemId: c._id, aboveId: a._id, belowId: b._id });
        if (!moved) throw new Error('expected a move');
        expect(isStrictlyIncreasing([await storedRank('row-0'), moved.rank ?? '', await storedRank('row-1')])).toBe(true);
        // Only the unranked row is re-keyed (between the open end and a0) — plus the move itself.
        const written = (await db.getAll('syncOperations')).map((op) => op.entityId).sort();
        expect(written).toEqual(['row-0', 'row-2']);
    });

    it('re-keys the FULL day section: a hidden (filtered-out) row keeps its place relative to the visible ones', async () => {
        // Display order of the whole section: hidden(unranked, first) → a(a0) → b(a0, equal) → c(a1).
        const items = await seedSection([undefined, 'a0', 'a0', 'a1'], [{ energy: 'high' }, { energy: 'low' }, { energy: 'low' }, { energy: 'low' }]);
        const [hidden, a, b, c] = four(items);
        // The page is filtered to low energy: only a, b, c are visible.
        const moved = await reorderItem(db, { sectionItems: [a, b, c], itemId: c._id, aboveId: a._id, belowId: b._id });
        if (!moved) throw new Error('expected a move');
        const all = (await db.getAll('items')).sort(compareNextActions);
        expect(all.map((row) => row._id)).toEqual([hidden._id, a._id, c._id, b._id]);
    });

    it('re-keys across an account whose rows in the day are ALL filtered out (ownerIds), keeping its row in place', async () => {
        // Display order: A1(a0) · A2(a0, equal) · B(a0V, hidden — every row of account B is filtered out) · A3(a1).
        const items = await seedSection(['a0', 'a0', 'a0V', 'a1'], [{ userId: 'user-A' }, { userId: 'user-A' }, { userId: 'user-B' }, { userId: 'user-A' }]);
        const [a1, a2, b, a3] = four(items);
        const moved = await reorderItem(db, { sectionItems: [a1, a2, a3], itemId: a3._id, aboveId: a1._id, belowId: a2._id, ownerIds: ['user-A', 'user-B'] });
        if (!moved) throw new Error('expected a move');
        const all = (await db.getAll('items')).sort(compareNextActions);
        expect(all.map((row) => row._id)).toEqual([a1._id, a3._id, a2._id, b._id]);
        expect(await db.get('items', b._id)).toEqual(b);
    });

    it("writes the moved row AS STORED, never the page's copy (a concurrent edit survives the reorder)", async () => {
        const items = await seedSection(['a0', 'a1', 'a2']);
        const [a, b, c] = items;
        if (!a || !b || !c) throw new Error('expected three rows');
        // Another tab / a pull changed the row after the page rendered it.
        await db.put('items', { ...c, notes: 'edited elsewhere', updatedTs: '2026-02-01T00:00:00.000Z' });
        const moved = await reorderItem(db, { sectionItems: items, itemId: c._id, aboveId: a._id, belowId: b._id });
        if (!moved) throw new Error('expected a move');
        expect(moved.notes).toBe('edited elsewhere');
        expect((await db.get('items', c._id))?.notes).toBe('edited elsewhere');
    });

    it('returns null without writing when the moved row is no longer a live nextAction row', async () => {
        const items = await seedSection(['a0', 'a1', 'a2']);
        const [a, b, c] = items;
        if (!a || !b || !c) throw new Error('expected three rows');
        await db.put('items', { ...c, status: 'done' });
        expect(await reorderItem(db, { sectionItems: items, itemId: c._id, aboveId: a._id, belowId: b._id })).toBeNull();
        expect(await db.getAll('syncOperations')).toHaveLength(0);
    });

    it('returns null without writing when the row was re-dated elsewhere mid-gesture (its neighbours belong to another day)', async () => {
        const items = await seedSection(['a0', 'a1', 'a2']);
        const [a, b, c] = items;
        if (!a || !b || !c) throw new Error('expected three rows');
        await db.put('items', { ...c, expectedBy: '2026-12-01' });
        expect(await reorderItem(db, { sectionItems: items, itemId: c._id, aboveId: a._id, belowId: b._id })).toBeNull();
        expect(await db.getAll('syncOperations')).toHaveLength(0);
        expect((await db.get('items', c._id))?.rank).toBe('a2');
    });

    it('returns null without writing when BOTH named neighbours vanished (the slot no longer exists)', async () => {
        const items = await seedSection(['a0', 'a1', 'a2']);
        const [a, b, c] = items;
        if (!a || !b || !c) throw new Error('expected three rows');
        await db.delete('items', a._id);
        await db.delete('items', b._id);
        expect(await reorderItem(db, { sectionItems: items, itemId: c._id, aboveId: a._id, belowId: b._id })).toBeNull();
        expect(await db.getAll('syncOperations')).toHaveLength(0);
    });

    it('a neighbour that vanished mid-gesture (completed elsewhere) is treated as a section edge', async () => {
        const items = await seedSection(['a0', 'a1', 'a2']);
        const [a, b, c] = items;
        if (!a || !b || !c) throw new Error('expected three rows');
        await db.delete('items', a._id);
        const moved = await reorderItem(db, { sectionItems: items, itemId: c._id, aboveId: a._id, belowId: b._id });
        if (!moved) throw new Error('expected a move');
        expect(compareRank(moved.rank ?? '', 'a1')).toBe(-1);
    });

    it('a merged two-account section: distinct keys → one op; equal keys across accounts → only the run is re-keyed', async () => {
        const items = await seedSection(['a0', 'a0', 'a1', 'a1'], [{ userId: 'user-1' }, { userId: 'user-2' }, { userId: 'user-1' }, { userId: 'user-2' }]);
        const [a, b, c, d] = four(items);
        // c lands between a and b: that pair ties, so a (re-keyed below b) + the move are written; b and d stay.
        const moved = await reorderItem(db, { sectionItems: items, itemId: c._id, aboveId: a._id, belowId: b._id });
        if (!moved) throw new Error('expected a move');
        expect(moved.userId).toBe('user-1');
        const createOps = await db.getAll('syncOperations');
        expect(createOps.map((op) => op.entityId).sort()).toEqual(['row-0', 'row-2']);
        expect(createOps.every((op) => op.userId === 'user-1')).toBe(true);
        expect(await db.get('items', b._id)).toEqual(b);
        await db.clear('syncOperations');
        // Now every key is distinct: moving d to the top is one op.
        const current = (await db.getAll('items')).sort((x, y) => compareRank(x.rank ?? '', y.rank ?? ''));
        const top = await reorderItem(db, { sectionItems: current, itemId: d._id, aboveId: undefined, belowId: current[0]?._id });
        if (!top) throw new Error('expected a move');
        const topOps = await db.getAll('syncOperations');
        expect(topOps).toHaveLength(1);
    });

    it('a minted key that grows too long triggers a section rebalance with the item in its new slot', async () => {
        const longA = `a0${'V'.repeat(40)}`;
        const longB = `a0${'V'.repeat(40)}G`;
        const items = await seedSection([longA, longB, 'a1']);
        const [a, b, c] = items;
        if (!a || !b || !c) throw new Error('expected three rows');
        const moved = await reorderItem(db, { sectionItems: items, itemId: c._id, aboveId: a._id, belowId: b._id });
        if (!moved) throw new Error('expected a move');
        const ranks = await Promise.all(['row-0', 'row-1'].map(storedRank));
        expect([...ranks, moved.rank ?? ''].every((rank) => rank.length <= 40)).toBe(true);
        expect(isStrictlyIncreasing([ranks[0] ?? '', moved.rank ?? '', ranks[1] ?? ''])).toBe(true);
    });

    it('nonIncreasingRun grows over unranked / non-increasing boundaries, then trims edge rows whose keys already fit', () => {
        const row = (id: string, rank?: string): StoredItem => ({
            _id: id,
            userId: USER_ID,
            status: 'nextAction',
            title: id,
            createdTs: '',
            updatedTs: '',
            ...(rank ? { rank } : {}),
        });
        const rows = [row('a', 'Zz'), row('b', 'a0'), row('c', 'a0'), row('d', 'a1'), row('e'), row('f', 'a3')];
        // The equal pair (b, c): only b needs a key between Zz and c's a0.
        expect(nonIncreasingRun(rows, 1, 2)).toEqual({ lo: 1, hi: 1 });
        // Around d: the unranked e is the only row that needs a key (between a1 and a3).
        expect(nonIncreasingRun(rows, 3, 3)).toEqual({ lo: 4, hi: 4 });
        expect(nonIncreasingRun(rows, 0, 0)).toEqual({ lo: 0, hi: 0 });
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
            rank: 'a0V',
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
        // `rank` is universal — it survives every status transition.
        expect(back.rank).toBe('a0V');
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
            rank: 'a0V',
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
        expect(sm.rank).toBe('a0V');
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

// Pins the wiring between the mutation layer and the ghost store (lib/listGhosts) — the store's
// own behavior is covered in listGhosts.test.ts; these assert that the helpers actually record.
describe('ghost snapshot recording', () => {
    it('clarifyToDone records the pre-mutation snapshot with its old status', async () => {
        const inbox = await collectItem(db, USER_ID, { title: 'Ghost me' });
        const nextAction = await clarifyToNextAction(db, inbox, {});
        resetGhostStore(); // isolate the transition under test from the inbox→nextAction ghost above

        await clarifyToDone(db, nextAction);

        expect(getGhostSnapshots()).toHaveLength(1);
        const [ghost] = getGhostSnapshots();
        if (!ghost) throw new Error('expected one ghost snapshot');
        expect(ghost._id).toBe(nextAction._id);
        expect(ghost.status).toBe('nextAction');
        expect(ghost.updatedTs).toBe(nextAction.updatedTs);
    });

    it('every status-changing clarify helper records a ghost', async () => {
        // Distinct items per helper — the store keeps one entry per item id, so a single
        // item chained through several transitions would only retain the last ghost.
        const transitions = [
            (item: StoredItem) => clarifyToNextAction(db, item, {}),
            (item: StoredItem) => clarifyToWaitingFor(db, item, {}),
            (item: StoredItem) => clarifyToSomedayMaybe(db, item, {}),
            (item: StoredItem) => clarifyToDone(db, item),
            (item: StoredItem) => clarifyToTrash(db, item),
        ];
        for (const transition of transitions) {
            await transition(await collectItem(db, USER_ID, { title: 'Departure' }));
        }

        expect(getGhostSnapshots().map((g) => g.status)).toEqual(['inbox', 'inbox', 'inbox', 'inbox', 'inbox']);
    });

    it('a clarify call that keeps the status does not record a ghost', async () => {
        const inbox = await collectItem(db, USER_ID, { title: 'Stay put' });
        const nextAction = await clarifyToNextAction(db, inbox, {});
        resetGhostStore();

        // Re-clarifying with new meta but the same status is a field edit, not a list departure.
        await clarifyToNextAction(db, nextAction, { energy: 'high' });

        expect(getGhostSnapshots()).toHaveLength(0);
    });

    it('updateItem (same-status field edit) does not record a ghost', async () => {
        const inbox = await collectItem(db, USER_ID, { title: 'Edited in place' });
        resetGhostStore();

        await updateItem(db, { ...inbox, title: 'Edited in place (renamed)' });

        expect(getGhostSnapshots()).toHaveLength(0);
    });

    it('removeItem records the deleted item as a ghost', async () => {
        const inbox = await collectItem(db, USER_ID, { title: 'Hard delete' });
        resetGhostStore();

        await removeItem(db, inbox._id);

        expect(getGhostSnapshots().map((g) => g._id)).toEqual([inbox._id]);
    });

    it('removeItem of a missing id records nothing', async () => {
        // The queued delete op can't resolve a userId for a missing item in this env (no
        // active account) and rejects — the ghost guard must already have declined by then.
        await removeItem(db, 'no-such-item').catch(() => {});

        expect(getGhostSnapshots()).toHaveLength(0);
    });
});
