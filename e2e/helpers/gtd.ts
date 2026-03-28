import type { Page } from '@playwright/test';
import type { NextActionMeta, WaitingForMeta } from '../../client/src/db/itemMutations';
import type { StoredDeviceSyncState, StoredItem, SyncOperation } from '../../client/src/types/MyDB';

// Typed wrappers around window.__gtd.* that hide the page.evaluate() boilerplate.
// All functions accept a Page as the first argument and run the corresponding __gtd
// method in the browser context, returning a typed result.

export const gtd = {
    listItems: (page: Page): Promise<StoredItem[]> =>
        page.evaluate(() => (window as unknown as { __gtd: { listItems(): Promise<StoredItem[]> } }).__gtd.listItems()),

    collect: (page: Page, title: string): Promise<StoredItem> =>
        page.evaluate((t) => (window as unknown as { __gtd: { collect(t: string): Promise<StoredItem> } }).__gtd.collect(t), title),

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

    fetchBootstrap: (page: Page): Promise<{ items: StoredItem[] }> =>
        page.evaluate(async () => {
            const res = await fetch('http://localhost:4000/sync/bootstrap', { credentials: 'include' });
            return res.json() as Promise<{ items: StoredItem[] }>;
        }),
};
