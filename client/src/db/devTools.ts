// Dev-only console testing harness. Mounted on window.__gtd in development.
// Wraps mutation helpers so you don't have to pass db or userId manually each time.
// Not included in production builds (main.tsx guards with import.meta.env.DEV).

import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredItem } from '../types/MyDB';
import { getActiveAccount } from './accountHelpers';
import type { NextActionFilters } from './itemHelpers';
import { getActiveNextActions, getItemsByUser, getOverdueItems, getUpcomingCalendarItems } from './itemHelpers';
import type { CalendarMeta, NextActionMeta, WaitingForMeta } from './itemMutations';
import {
    clarifyToCalendar,
    clarifyToDone,
    clarifyToNextAction,
    clarifyToTrash,
    clarifyToWaitingFor,
    collectItem,
    removeItem,
    updateItem,
} from './itemMutations';
import type { NewPersonFields } from './personMutations';
import { createPerson } from './personMutations';
import { getRoutinesByUser } from './routineHelpers';
import { deleteAndRegenerateFutureItems, generateCalendarItemsToHorizon } from './routineItemHelpers';
import type { NewRoutineFields } from './routineMutations';
import { createRoutine, removeRoutine, updateRoutine } from './routineMutations';
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
        clarifyToDone: (item: StoredItem) => clarifyToDone(db, item),
        clarifyToTrash: (item: StoredItem) => clarifyToTrash(db, item),
        updateItem: (item: StoredItem) => updateItem(db, item),
        removeItem: (itemId: string) => removeItem(db, itemId),

        // ── Supporting entities ──────────────────────────────────────────────
        createPerson: (fields: Omit<NewPersonFields, 'userId'>) => resolveUserId(db).then((uid) => createPerson(db, { ...fields, userId: uid })),
        createWorkContext: (name: string) => resolveUserId(db).then((uid) => createWorkContext(db, { userId: uid, name })),

        // ── Routines ─────────────────────────────────────────────────────────
        listRoutines: () => resolveUserId(db).then((uid) => getRoutinesByUser(db, uid)),
        createRoutine: (fields: Omit<NewRoutineFields, 'userId'>) => resolveUserId(db).then((uid) => createRoutine(db, { ...fields, userId: uid })),
        updateRoutine: (routine: Parameters<typeof updateRoutine>[1]) => updateRoutine(db, routine),
        removeRoutine: (routineId: string) => removeRoutine(db, routineId),
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
