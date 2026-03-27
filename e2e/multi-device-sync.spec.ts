import { expect, test } from '@playwright/test';
import type { StoredItem } from '../client/src/types/MyDB';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';

// Two BrowserContext instances represent two devices — they share cookies and the server
// but have fully isolated IndexedDB, localStorage, and service worker registrations.

test.describe('multi-device sync', () => {
    test('item created on device-1 appears on device-2 via pull', async ({ browser }) => {
        const email = `pull-${Date.now()}@example.com`;
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page1 = await loginAs(ctx1, email);
        const page2 = await loginAs(ctx2, email);

        await gtd.collect(page1, 'Shared item');
        await gtd.flush(page1);

        await gtd.pull(page2);
        const items = await gtd.listItems(page2);
        expect(items.some((i) => i.title === 'Shared item')).toBe(true);

        await ctx1.close();
        await ctx2.close();
    });

    test('SSE triggers automatic pull on device-2 without manual pull()', async ({ browser }) => {
        const email = `sse-${Date.now()}@example.com`;
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page1 = await loginAs(ctx1, email);
        const page2 = await loginAs(ctx2, email);

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

        await ctx1.close();
        await ctx2.close();
    });

    test('last-write-wins conflict resolution', async ({ browser }) => {
        const email = `conflict-${Date.now()}@example.com`;
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page1 = await loginAs(ctx1, email);
        const page2 = await loginAs(ctx2, email);

        // Create a shared item on device-1 and sync it to device-2.
        const inbox = await gtd.collect(page1, 'Contested');
        await gtd.flush(page1);
        await gtd.pull(page2);

        // Device-2 writes first — this timestamp is older and will lose.
        // Wait for the pulled item to land in IDB before reading it — pull() is async and the
        // write may not be visible yet when listItems() is called immediately after.
        const item2 = await page2.waitForFunction(
            (id) =>
                (
                    window as unknown as {
                        __gtd: { listItems(): Promise<Array<{ _id: string; title: string }>> };
                    }
                ).__gtd
                    .listItems()
                    .then((its) => its.find((i) => i._id === id) ?? null),
            inbox._id,
            { timeout: 10_000, polling: 200 },
        ).then((h) => h.jsonValue());
        await gtd.clarifyToNextAction(page2, item2!, { energy: 'high' });
        await gtd.flush(page2);

        // Device-1 writes after — newer updatedTs wins the conflict.
        // Small sleep is unavoidable here: we need device-1's updatedTs to be strictly
        // greater than device-2's, and both run on the same JS clock.
        await page1.waitForTimeout(50);
        // Use inbox directly rather than re-querying listItems — device-1's IDB may have been
        // overwritten by an SSE-triggered pull from device-2's flush, making find() return
        // undefined and crashing clarifyToNextAction's destructuring of the item argument.
        await gtd.clarifyToNextAction(page1, inbox, { energy: 'low', urgent: true });
        await gtd.flush(page1);

        // Both devices pull and should converge on device-1's version.
        await gtd.pull(page1);
        await gtd.pull(page2);

        for (const [page, label] of [[page1, 'device-1'] as const, [page2, 'device-2'] as const]) {
            const resolved = (await gtd.listItems(page)).find((i) => i._id === inbox._id);
            expect(resolved?.energy, `${label} energy`).toBe('low');
            expect(resolved?.urgent, `${label} urgent`).toBe(true);
        }

        await ctx1.close();
        await ctx2.close();
    });

    test('fresh device bootstraps all items from server', async ({ browser }) => {
        const email = `bootstrap-${Date.now()}@example.com`;
        const ctx1 = await browser.newContext();
        // ctx2 starts fresh — no deviceSyncState, so it triggers bootstrapFromServer.
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
            type Harness = { listItems(): Promise<Array<{ title: string }>>; syncState(): Promise<{ lastSyncedTs: string } | undefined> };
            const harness = (window as unknown as { __gtd: Harness }).__gtd;
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline) {
                const [its, state] = await Promise.all([harness.listItems(), harness.syncState()]);
                const hasBoth = its.some((i) => i.title === 'Bootstrap item A') && its.some((i) => i.title === 'Bootstrap item B');
                const settled = state?.lastSyncedTs !== '1970-01-01T00:00:00.000Z';
                if (hasBoth && settled) return its;
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
        const email = `d2-create-${Date.now()}@example.com`;
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page1 = await loginAs(ctx1, email);
        const page2 = await loginAs(ctx2, email);

        await gtd.collect(page2, 'Device-2 item');
        await gtd.flush(page2);

        const bootstrap = await page1.evaluate(async () => {
            const res = await fetch('http://localhost:4000/sync/bootstrap', { credentials: 'include' });
            return res.json() as Promise<{ items: StoredItem[] }>;
        });
        expect(bootstrap.items.some((i) => i.title === 'Device-2 item')).toBe(true);

        await ctx1.close();
        await ctx2.close();
    });
});
