import { expect, test } from '@playwright/test';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';

// Uses Playwright's context.setOffline() to simulate network loss.
// The browser dispatches real 'online'/'offline' window events, so the app's
// handleOnline/handleOffline listeners fire exactly as in production.

test.describe('offline behaviour', () => {
    test('offline queue flushes automatically on reconnect', async ({ browser }) => {
        const email = `offline-flush-${Date.now()}@example.com`;
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page1 = await loginAs(ctx1, email);
        const page2 = await loginAs(ctx2, email);

        // Establish an initial item so device-2 has something to sync.
        await gtd.collect(page1, 'Online item');
        await gtd.flush(page1);

        await ctx1.setOffline(true);
        await gtd.collect(page1, 'Offline item');

        const queued = await gtd.queuedOps(page1);
        // At least one op for 'Offline item'; may also include 'Online item' if still pending.
        expect(queued.length).toBeGreaterThanOrEqual(1);

        // Coming back online fires window 'online', which calls handleOnline → flushSyncQueue.
        await ctx1.setOffline(false);

        // Poll until the queue drains — no fixed sleep.
        await page1.waitForFunction(
            () =>
                (
                    window as unknown as {
                        __gtd: { queuedOps(): Promise<unknown[]> };
                    }
                ).__gtd
                    .queuedOps()
                    .then((ops) => ops.length === 0),
            undefined,
            { timeout: 15_000, polling: 300 },
        );

        // Verify device-2 can pull and see the item that was queued offline.
        await gtd.pull(page2);
        const items = await gtd.listItems(page2);
        expect(items.some((i) => i.title === 'Offline item')).toBe(true);

        await ctx1.close();
        await ctx2.close();
    });

    test('app shows cached IDB data while offline', async ({ browser }) => {
        const email = `offline-cache-${Date.now()}@example.com`;
        const ctx = await browser.newContext();
        const page = await loginAs(ctx, email);

        // Create items and flush them so the server has them and IDB is populated.
        await gtd.collect(page, 'Cached item A');
        await gtd.collect(page, 'Cached item B');
        await gtd.flush(page);

        // Go offline and reload — the app must load entirely from IndexedDB.
        await ctx.setOffline(true);
        await page.reload();

        // Wait for __gtd to be remounted after reload.
        await page.waitForFunction(() => typeof (window as unknown as { __gtd?: unknown }).__gtd !== 'undefined');

        // IDB survives the reload; the app renders cached items without any server round-trip.
        const items = await gtd.listItems(page);
        expect(items.some((i) => i.title === 'Cached item A')).toBe(true);
        expect(items.some((i) => i.title === 'Cached item B')).toBe(true);

        await ctx.close();
    });
});
