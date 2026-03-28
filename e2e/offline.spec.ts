import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

// Uses Playwright's context.setOffline() to simulate network loss.
// The browser dispatches real 'online'/'offline' window events, so the app's
// handleOnline/handleOffline listeners fire exactly as in production.

test.describe('offline behaviour', () => {
    test('offline queue flushes automatically on reconnect', async ({ browser }) => {
        const email = `offline-flush-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            // Establish an initial item so device-2 has something to sync.
            await gtd.collect(page1, 'Online item');
            await gtd.flush(page1);

            // page1.context() gives back the BrowserContext needed for setOffline.
            await page1.context().setOffline(true);
            await gtd.collect(page1, 'Offline item');

            const queued = await gtd.queuedOps(page1);
            // At least one op for 'Offline item'; may also include 'Online item' if still pending.
            expect(queued.length).toBeGreaterThanOrEqual(1);

            // Coming back online fires window 'online', which calls handleOnline → flushSyncQueue.
            await page1.context().setOffline(false);

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
        });
    });

    test('app shows cached IDB data while offline', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `offline-cache-${dayjs().valueOf()}@example.com`, async (page) => {
            // Create items and flush them so the server has them and IDB is populated.
            await gtd.collect(page, 'Cached item A');
            await gtd.collect(page, 'Cached item B');
            await gtd.flush(page);

            // Go offline — IDB data must remain accessible without any server round-trip.
            // Note: we don't reload the page here because the dev server (no service worker)
            // cannot serve the app shell offline; that scenario requires a production build.
            // The core behaviour being tested — reading from IDB when the network is unavailable
            // — is exercised by calling listItems() while offline below.
            await page.context().setOffline(true);

            // Items were synced into IDB before going offline; they must be readable without network.
            const items = await gtd.listItems(page);
            expect(items.some((i) => i.title === 'Cached item A')).toBe(true);
            expect(items.some((i) => i.title === 'Cached item B')).toBe(true);
        });
    });
});
