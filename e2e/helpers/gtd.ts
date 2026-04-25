import type { Page } from '@playwright/test';
import type { NextActionFilters } from '../../client/src/db/itemHelpers';
import type { CalendarMeta, NextActionMeta, WaitingForMeta } from '../../client/src/db/itemMutations';
import type { StoredDeviceSyncState, StoredItem, StoredPerson, StoredRoutine, StoredWorkContext, SyncOperation } from '../../client/src/types/MyDB';

// Typed wrappers around window.__gtd.* that hide the page.evaluate() boilerplate.
// All functions accept a Page as the first argument and run the corresponding __gtd
// method in the browser context, returning a typed result.

export const gtd = {
    // ── List / query ─────────────────────────────────────────────────────────
    listItems: (page: Page): Promise<StoredItem[]> =>
        page.evaluate(() => (window as unknown as { __gtd: { listItems(): Promise<StoredItem[]> } }).__gtd.listItems()),

    listNextActions: (page: Page, filters: NextActionFilters = {}): Promise<StoredItem[]> =>
        page.evaluate(
            (f) =>
                (
                    window as unknown as {
                        __gtd: { listNextActions(f: NextActionFilters): Promise<StoredItem[]> };
                    }
                ).__gtd.listNextActions(f),
            filters,
        ),

    listCalendar: (page: Page): Promise<StoredItem[]> =>
        page.evaluate(() => (window as unknown as { __gtd: { listCalendar(): Promise<StoredItem[]> } }).__gtd.listCalendar()),

    listRoutines: (page: Page): Promise<StoredRoutine[]> =>
        page.evaluate(() => (window as unknown as { __gtd: { listRoutines(): Promise<StoredRoutine[]> } }).__gtd.listRoutines()),

    // ── Collect ──────────────────────────────────────────────────────────────
    collect: (page: Page, title: string): Promise<StoredItem> =>
        page.evaluate((t) => (window as unknown as { __gtd: { collect(t: string): Promise<StoredItem> } }).__gtd.collect(t), title),

    // ── Clarify ──────────────────────────────────────────────────────────────
    clarifyToNextAction: (page: Page, item: StoredItem, meta: NextActionMeta = {}): Promise<StoredItem> =>
        page.evaluate(
            ([i, m]) =>
                (
                    window as unknown as {
                        __gtd: { clarifyToNextAction(i: StoredItem, m: NextActionMeta): Promise<StoredItem> };
                    }
                ).__gtd.clarifyToNextAction(i as StoredItem, m as NextActionMeta),
            [item, meta] as const,
        ),

    clarifyToCalendar: (page: Page, item: StoredItem, meta: CalendarMeta): Promise<StoredItem> =>
        page.evaluate(
            ([i, m]) =>
                (
                    window as unknown as {
                        __gtd: { clarifyToCalendar(i: StoredItem, m: CalendarMeta): Promise<StoredItem> };
                    }
                ).__gtd.clarifyToCalendar(i as StoredItem, m as CalendarMeta),
            [item, meta] as const,
        ),

    clarifyToWaitingFor: (page: Page, item: StoredItem, meta: WaitingForMeta): Promise<StoredItem> =>
        page.evaluate(
            ([i, m]) =>
                (
                    window as unknown as {
                        __gtd: { clarifyToWaitingFor(i: StoredItem, m: WaitingForMeta): Promise<StoredItem> };
                    }
                ).__gtd.clarifyToWaitingFor(i as StoredItem, m as WaitingForMeta),
            [item, meta] as const,
        ),

    clarifyToDone: (page: Page, item: StoredItem): Promise<StoredItem> =>
        page.evaluate(
            (i) =>
                (
                    window as unknown as {
                        __gtd: { clarifyToDone(i: StoredItem): Promise<StoredItem> };
                    }
                ).__gtd.clarifyToDone(i as StoredItem),
            item,
        ),

    clarifyToTrash: (page: Page, item: StoredItem): Promise<StoredItem> =>
        page.evaluate(
            (i) =>
                (
                    window as unknown as {
                        __gtd: { clarifyToTrash(i: StoredItem): Promise<StoredItem> };
                    }
                ).__gtd.clarifyToTrash(i as StoredItem),
            item,
        ),

    clarifyToInbox: (page: Page, item: StoredItem): Promise<StoredItem> =>
        page.evaluate(
            (i) =>
                (
                    window as unknown as {
                        __gtd: { clarifyToInbox(i: StoredItem): Promise<StoredItem> };
                    }
                ).__gtd.clarifyToInbox(i as StoredItem),
            item,
        ),

    clarifyToSomedayMaybe: (page: Page, item: StoredItem): Promise<StoredItem> =>
        page.evaluate(
            (i) =>
                (
                    window as unknown as {
                        __gtd: { clarifyToSomedayMaybe(i: StoredItem): Promise<StoredItem> };
                    }
                ).__gtd.clarifyToSomedayMaybe(i as StoredItem),
            item,
        ),

    // ── Update / remove ──────────────────────────────────────────────────────
    updateItem: (page: Page, item: StoredItem): Promise<StoredItem> =>
        page.evaluate(
            (i) =>
                (
                    window as unknown as {
                        __gtd: { updateItem(i: StoredItem): Promise<StoredItem> };
                    }
                ).__gtd.updateItem(i as StoredItem),
            item,
        ),

    removeItem: (page: Page, itemId: string): Promise<void> =>
        page.evaluate((id) => (window as unknown as { __gtd: { removeItem(id: string): Promise<void> } }).__gtd.removeItem(id), itemId),

    // ── People ───────────────────────────────────────────────────────────────
    createPerson: (page: Page, fields: { name: string; email?: string; phone?: string }): Promise<StoredPerson> =>
        page.evaluate(
            (f) =>
                (
                    window as unknown as {
                        __gtd: { createPerson(f: { name: string; email?: string; phone?: string }): Promise<StoredPerson> };
                    }
                ).__gtd.createPerson(f),
            fields,
        ),

    // ── Work Contexts ────────────────────────────────────────────────────────
    createWorkContext: (page: Page, name: string): Promise<StoredWorkContext> =>
        page.evaluate(
            (n) =>
                (
                    window as unknown as {
                        __gtd: { createWorkContext(n: string): Promise<StoredWorkContext> };
                    }
                ).__gtd.createWorkContext(n),
            name,
        ),

    // ── Routines ─────────────────────────────────────────────────────────────
    createRoutine: (page: Page, fields: Omit<StoredRoutine, '_id' | 'userId' | 'createdTs' | 'updatedTs'>): Promise<StoredRoutine> =>
        page.evaluate(
            (f) =>
                (
                    window as unknown as {
                        __gtd: {
                            createRoutine(f: Omit<StoredRoutine, '_id' | 'userId' | 'createdTs' | 'updatedTs'>): Promise<StoredRoutine>;
                        };
                    }
                ).__gtd.createRoutine(f),
            fields,
        ),

    updateRoutine: (page: Page, routine: StoredRoutine): Promise<StoredRoutine> =>
        page.evaluate(
            (r) =>
                (
                    window as unknown as {
                        __gtd: { updateRoutine(r: StoredRoutine): Promise<StoredRoutine> };
                    }
                ).__gtd.updateRoutine(r as StoredRoutine),
            routine,
        ),

    removeRoutine: (page: Page, routineId: string): Promise<void> =>
        page.evaluate((id) => (window as unknown as { __gtd: { removeRoutine(id: string): Promise<void> } }).__gtd.removeRoutine(id), routineId),

    pauseRoutine: (page: Page, routineId: string): Promise<StoredRoutine> =>
        page.evaluate(
            (id) => (window as unknown as { __gtd: { pauseRoutine(id: string): Promise<StoredRoutine> } }).__gtd.pauseRoutine(id),
            routineId,
        ),

    materializePendingNextActionRoutines: (page: Page): Promise<void> =>
        page.evaluate(() =>
            (
                window as unknown as {
                    __gtd: { materializePendingNextActionRoutines(): Promise<void> };
                }
            ).__gtd.materializePendingNextActionRoutines(),
        ),

    generateCalendarItemsToHorizon: (page: Page, routineId: string): Promise<void> =>
        page.evaluate(
            (id) =>
                (
                    window as unknown as {
                        __gtd: { generateCalendarItemsToHorizon(id: string): Promise<void> };
                    }
                ).__gtd.generateCalendarItemsToHorizon(id),
            routineId,
        ),

    deleteAndRegenerateFutureItems: (page: Page, routineId: string): Promise<void> =>
        page.evaluate(
            (id) =>
                (
                    window as unknown as {
                        __gtd: { deleteAndRegenerateFutureItems(id: string): Promise<void> };
                    }
                ).__gtd.deleteAndRegenerateFutureItems(id),
            routineId,
        ),

    // ── Sync controls ────────────────────────────────────────────────────────
    flush: (page: Page): Promise<void> => page.evaluate(() => (window as unknown as { __gtd: { flush(): Promise<void> } }).__gtd.flush()),

    pull: (page: Page): Promise<void> => page.evaluate(() => (window as unknown as { __gtd: { pull(): Promise<void> } }).__gtd.pull()),

    queuedOps: (page: Page): Promise<SyncOperation[]> =>
        page.evaluate(() => (window as unknown as { __gtd: { queuedOps(): Promise<SyncOperation[]> } }).__gtd.queuedOps()),

    syncState: (page: Page): Promise<StoredDeviceSyncState | undefined> =>
        page.evaluate(() =>
            (
                window as unknown as {
                    __gtd: { syncState(): Promise<StoredDeviceSyncState | undefined> };
                }
            ).__gtd.syncState(),
        ),

    // ── Server verification ──────────────────────────────────────────────────
    fetchBootstrap: (page: Page): Promise<{ items: StoredItem[]; routines: StoredRoutine[]; people: StoredPerson[]; workContexts: StoredWorkContext[] }> =>
        page.evaluate(async () => {
            const res = await fetch('http://localhost:4000/sync/bootstrap', { credentials: 'include' });
            return res.json() as Promise<{
                items: StoredItem[];
                routines: StoredRoutine[];
                people: StoredPerson[];
                workContexts: StoredWorkContext[];
            }>;
        }),
};
