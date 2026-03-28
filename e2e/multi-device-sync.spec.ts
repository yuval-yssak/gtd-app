import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredItem } from '../client/src/types/MyDB';
import { withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';

// Two BrowserContext instances represent two devices — they share cookies and the server
// but have fully isolated IndexedDB, localStorage, and service worker registrations.

// Polls device IDB until the item with the given ID appears. Needed because an
// SSE-triggered pull may race with a direct gtd.pull() call, and the item may not
// be visible instantly even after the pull awaitable resolves.
async function waitForItemByIdOnDevice(page: Page, id: string): Promise<StoredItem> {
    // Use evaluate() with an inline polling loop rather than waitForFunction() — the latter
    // resolves as soon as the predicate is truthy, but a Promise is always truthy, so
    // waitForFunction() would resolve immediately without awaiting the IDB read.
    const found = await page.evaluate(async (itemId) => {
        type Harness = { listItems(): Promise<StoredItem[]> };
        const harness = (window as unknown as { __gtd: Harness }).__gtd;
        // Date.now() is intentional — this closure runs in the browser context where dayjs is unavailable.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            const items = await harness.listItems();
            const match = items.find((i) => i._id === itemId);
            if (match) {
                return match;
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        return null;
    }, id);

    if (!found) {
        throw new Error(`Item ${id} not found on device after 10s`);
    }
    return found;
}

async function createSyncedItem(page1: Page, page2: Page, title: string): Promise<StoredItem> {
    const item = await gtd.collect(page1, title);
    await gtd.flush(page1);
    await gtd.pull(page2);
    return item;
}

test.describe('multi-device sync', () => {
    test('item created on device-1 appears on device-2 via pull', async ({ browser }) => {
        const email = `pull-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            await gtd.collect(page1, 'Shared item');
            await gtd.flush(page1);

            await gtd.pull(page2);
            const items = await gtd.listItems(page2);
            expect(items.some((i) => i.title === 'Shared item')).toBe(true);
        });
    });

    test('SSE triggers automatic pull on device-2 without manual pull()', async ({ browser }) => {
        const email = `sse-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            await gtd.collect(page1, 'SSE item');
            await gtd.flush(page1);

            // After device-1 flushes, the server sends an SSE notification to device-2.
            // Device-2's sseClient calls syncAndRefresh() which calls pullFromServer().
            // We poll IDB instead of using a fixed sleep to avoid flakiness.
            await page2.waitForFunction(
                () =>
                    (
                        window as unknown as {
                            __gtd: { listItems(): Promise<Array<{ title: string }>> };
                        }
                    ).__gtd
                        .listItems()
                        .then((items) => items.some((i) => i.title === 'SSE item')),
                undefined,
                { timeout: 15_000, polling: 500 },
            );
        });
    });

    test('last-write-wins conflict resolution', async ({ browser }) => {
        const email = `conflict-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const inboxItem = await createSyncedItem(page1, page2, 'Contested');

            // Device-2 writes first — this timestamp is older and will lose.
            const device2Item = await waitForItemByIdOnDevice(page2, inboxItem._id);
            await gtd.clarifyToNextAction(page2, device2Item, { energy: 'high' });
            await gtd.flush(page2);

            // Device-1 writes after — newer updatedTs wins the conflict.
            // Small sleep is unavoidable here: we need device-1's updatedTs to be strictly
            // greater than device-2's, and both run on the same JS clock.
            await page1.waitForTimeout(50);
            // Use inboxItem directly rather than re-querying listItems — device-1's IDB may have been
            // overwritten by an SSE-triggered pull from device-2's flush, making find() return
            // undefined and crashing clarifyToNextAction's destructuring of the item argument.
            await gtd.clarifyToNextAction(page1, inboxItem, { energy: 'low', urgent: true });
            await gtd.flush(page1);

            // Both devices pull and should converge on device-1's version.
            await gtd.pull(page1);
            await gtd.pull(page2);

            for (const [page, label] of [[page1, 'device-1'] as const, [page2, 'device-2'] as const]) {
                const resolved = (await gtd.listItems(page)).find((i) => i._id === inboxItem._id);
                expect(resolved?.energy, `${label} energy`).toBe('low');
                expect(resolved?.urgent, `${label} urgent`).toBe(true);
            }
        });
    });

    test('fresh device bootstraps all items from server', async ({ browser }) => {
        const email = `bootstrap-${dayjs().valueOf()}@example.com`;
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();

        const page1 = await loginAs(ctx1, email);

        // Create several items and flush them so they're on the server.
        await gtd.collect(page1, 'Bootstrap item A');
        await gtd.collect(page1, 'Bootstrap item B');
        await gtd.flush(page1);

        // Device-2 logs in fresh — _authenticated.tsx calls bootstrapFromServer when no
        // deviceSyncState exists, so the page already has the items by the time it loads.
        const page2 = await loginAs(ctx2, email);

        // Poll inside the browser with evaluate() rather than waitForFunction() — the latter
        // resolves as soon as the predicate returns truthy, but a concurrent StrictMode
        // bootstrapFromServer run can briefly reset IDB (epoch + empty items) before the
        // second fetch completes. Polling inside evaluate() atomically returns the snapshot
        // only after both items AND a non-epoch lastSyncedTs are stable.
        const items = await page2.evaluate(async () => {
            // Date.now() is intentional — this closure runs in the browser context where dayjs is unavailable.
            type Harness = { listItems(): Promise<Array<{ title: string }>>; syncState(): Promise<{ lastSyncedTs: string } | undefined> };
            const harness = (window as unknown as { __gtd: Harness }).__gtd;
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline) {
                const [items, state] = await Promise.all([harness.listItems(), harness.syncState()]);
                const hasBoth = items.some((i) => i.title === 'Bootstrap item A') && items.some((i) => i.title === 'Bootstrap item B');
                const isSyncSettled = state?.lastSyncedTs !== '1970-01-01T00:00:00.000Z';
                if (hasBoth && isSyncSettled) {
                    return items;
                }
                await new Promise((r) => setTimeout(r, 300));
            }
            return null;
        });
        expect(items?.some((i) => i.title === 'Bootstrap item A')).toBe(true);
        expect(items?.some((i) => i.title === 'Bootstrap item B')).toBe(true);

        await ctx1.close();
        await ctx2.close();
    });

    test('item created on device-2 is visible in server bootstrap', async ({ browser }) => {
        const email = `d2-create-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            await gtd.collect(page2, 'Device-2 item');
            await gtd.flush(page2);

            const bootstrap = await gtd.fetchBootstrap(page1);
            expect(bootstrap.items.some((i) => i.title === 'Device-2 item')).toBe(true);
        });
    });
});
