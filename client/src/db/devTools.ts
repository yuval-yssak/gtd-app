// Dev-only console testing harness. Mounted on window.__gtd in development.
// Wraps mutation helpers so you don't have to pass db or userId manually each time.
// Not included in production builds (main.tsx guards with import.meta.env.DEV).

import type { IDBPDatabase } from 'idb';
import { getAllSyncConfigs } from '../api/calendarApi';
import { getPushStatus } from '../api/pushApi';
import type { MyDB, StoredItem } from '../types/MyDB';
import { getActiveAccount } from './accountHelpers';
import { getOrCreateDeviceId } from './deviceId';
import type { NextActionFilters } from './itemHelpers';
import { getActiveNextActions, getItemsByUser, getOverdueItems, getUpcomingCalendarItems } from './itemHelpers';
import type { CalendarMeta, NextActionMeta, WaitingForMeta } from './itemMutations';
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
} from './itemMutations';
import type { NewPersonFields } from './personMutations';
import { createPerson } from './personMutations';
import { reassignEntity } from './reassignMutations';
import { getRoutinesByUser } from './routineHelpers';
import { deleteAndRegenerateFutureItems, generateCalendarItemsToHorizon, materializePendingNextActionRoutines } from './routineItemHelpers';
import type { NewRoutineFields } from './routineMutations';
import { createRoutine, pauseRoutine, removeRoutine, updateRoutine } from './routineMutations';
import { getOpenSseUserIds } from './sseClient';
import { flushSyncQueue, forcePull, waitForPendingFlush } from './syncHelpers';
import { createWorkContext } from './workContextMutations';

async function resolveUserId(db: IDBPDatabase<MyDB>): Promise<string> {
    const account = await getActiveAccount(db);
    if (!account) throw new Error('[GTD] No active account — log in first');
    return account.id;
}

export function mountDevTools(db: IDBPDatabase<MyDB>): void {
    const gtd = {
        // ── Inspect ─────────────────────────────────────────────────────────
        db,
        syncState: () => db.get('deviceSyncState', 'local'),
        queuedOps: () => db.getAll('syncOperations'),

        // ── List / query ─────────────────────────────────────────────────────
        listItems: () => resolveUserId(db).then((uid) => getItemsByUser(db, uid)),
        listNextActions: (filters: NextActionFilters = {}) => resolveUserId(db).then((uid) => getActiveNextActions(db, uid, filters)),
        listCalendar: () => resolveUserId(db).then((uid) => getUpcomingCalendarItems(db, uid)),
        listOverdue: () => resolveUserId(db).then((uid) => getOverdueItems(db, uid)),

        // ── Collect ──────────────────────────────────────────────────────────
        collect: (title: string) => resolveUserId(db).then((uid) => collectItem(db, uid, { title })),

        // ── Clarify ──────────────────────────────────────────────────────────
        clarifyToNextAction: (item: StoredItem, meta: NextActionMeta = {}) => clarifyToNextAction(db, item, meta),
        clarifyToCalendar: (item: StoredItem, meta: CalendarMeta) => clarifyToCalendar(db, item, meta),
        clarifyToWaitingFor: (item: StoredItem, meta: WaitingForMeta) => clarifyToWaitingFor(db, item, meta),
        clarifyToInbox: (item: StoredItem) => clarifyToInbox(db, item),
        clarifyToSomedayMaybe: (item: StoredItem) => clarifyToSomedayMaybe(db, item),
        clarifyToDone: (item: StoredItem) => clarifyToDone(db, item),
        clarifyToTrash: (item: StoredItem) => clarifyToTrash(db, item),
        updateItem: (item: StoredItem) => updateItem(db, item),
        removeItem: (itemId: string) => removeItem(db, itemId),
        recordRoutineInstanceModification: (
            routineId: string,
            originalDate: string,
            override: { itemId: string; newTimeStart?: string; newTimeEnd?: string; title?: string; notes?: string },
        ) => recordRoutineInstanceModification(db, routineId, originalDate, override),

        // ── Supporting entities ──────────────────────────────────────────────
        createPerson: (fields: Omit<NewPersonFields, 'userId'>) => resolveUserId(db).then((uid) => createPerson(db, { ...fields, userId: uid })),
        createWorkContext: (name: string) => resolveUserId(db).then((uid) => createWorkContext(db, { userId: uid, name })),

        // ── Routines ─────────────────────────────────────────────────────────
        listRoutines: () => resolveUserId(db).then((uid) => getRoutinesByUser(db, uid)),
        createRoutine: (fields: Omit<NewRoutineFields, 'userId'>) => resolveUserId(db).then((uid) => createRoutine(db, { ...fields, userId: uid })),
        updateRoutine: (routine: Parameters<typeof updateRoutine>[1]) => updateRoutine(db, routine),
        removeRoutine: (routineId: string) => removeRoutine(db, routineId),
        pauseRoutine: (routineId: string) =>
            resolveUserId(db).then(async (uid) => {
                const routine = await db.get('routines', routineId);
                if (!routine) {
                    throw new Error(`Routine ${routineId} not found`);
                }
                return pauseRoutine(db, uid, routine);
            }),
        materializePendingNextActionRoutines: () => resolveUserId(db).then((uid) => materializePendingNextActionRoutines(db, uid)),
        generateCalendarItemsToHorizon: (routineId: string) =>
            resolveUserId(db).then(async (uid) => {
                const routine = await db.get('routines', routineId);
                if (!routine) {
                    throw new Error(`Routine ${routineId} not found`);
                }
                await generateCalendarItemsToHorizon(db, uid, routine);
            }),
        deleteAndRegenerateFutureItems: (routineId: string) =>
            resolveUserId(db).then(async (uid) => {
                const routine = await db.get('routines', routineId);
                if (!routine) {
                    throw new Error(`Routine ${routineId} not found`);
                }
                await deleteAndRegenerateFutureItems(db, uid, routine);
            }),

        // ── Sync controls ────────────────────────────────────────────────────
        // Wait for any fire-and-forget flush that queueSyncOp kicked off, then flush any
        // remaining ops. This guarantees ALL mutations are on the server when flush resolves.
        flush: async () => {
            await waitForPendingFlush();
            await flushSyncQueue(db);
        },
        pull: () => forcePull(db),

        // ── Device + notifications introspection (used by e2e specs) ─────────
        // Stable per-device UUID — exposed so e2e tests can correlate the deviceUsers join
        // collection on the server with the IDB-side state without poking IDB directly.
        getDeviceId: () => getOrCreateDeviceId(db),
        // Active account ID (Better Auth user id) — distinct from getActiveAccount which returns
        // the full StoredAccount. Convenient when the test only needs the user id.
        getActiveAccountId: async () => {
            const account = await getActiveAccount(db);
            return account?.id ?? null;
        },
        // Server-side push registration status for this device — wraps /push/status.
        getPushStatus: async () => {
            const deviceId = await getOrCreateDeviceId(db);
            return getPushStatus(deviceId);
        },
        // Multi-account aggregated calendar bundles — used by Step 3 e2e specs to assert
        // that the unified picker enumerates calendars across every signed-in account.
        getAllSyncConfigs: () => getAllSyncConfigs(),

        // ── Multi-account sync introspection (Step 4) ──────────────────────────
        // Returns the set of userIds with an open SSE channel right now. Used by the
        // multi-account-sync e2e spec to assert the device opened one channel per account.
        sseChannelUserIds: () => getOpenSseUserIds(),

        // ── Reassign (Step 5) ──────────────────────────────────────────────────
        // Drives the cross-account move via /sync/reassign. Returns the discriminated server
        // response so e2e specs can assert ok/error branches without network introspection.
        reassign: (params: Parameters<typeof reassignEntity>[1]) => reassignEntity(db, params),

        // Test-only: simulates a calendar-linked item move via the dev /simulate-event-move
        // endpoint that stubs out Google Calendar. Used by the calendar-reassign e2e spec.
        simulateCalendarMove: async (body: {
            entityType: 'item';
            entityId: string;
            fromUserId: string;
            toUserId: string;
            targetCalendar: { integrationId: string; syncConfigId: string };
        }) => {
            const res = await fetch('http://localhost:4000/dev/calendar/simulate-event-move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return res.json();
        },
    };

    (window as unknown as { __gtd: typeof gtd }).__gtd = gtd;

    console.info(
        '%c[GTD dev tools] window.__gtd ready',
        'color: #4caf50; font-weight: bold',
        '\n\nQuick reference:',
        '\n  __gtd.collect("Buy milk")              → inbox item',
        '\n  __gtd.listItems()                      → all items',
        '\n  __gtd.flush()                          → push queue to server',
        '\n  __gtd.pull()                           → pull from server',
        '\n  __gtd.syncState()                      → device cursor + deviceId',
        '\n  __gtd.queuedOps()                      → pending offline queue',
    );
}
