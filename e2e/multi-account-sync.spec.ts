import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { StoredItem } from '../client/src/types/MyDB';
import { closeContextQuietly, withTwoAccountsOnOneDevice } from './helpers/context';
import { API_URL } from './helpers/env';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';
import { uniqueStamp } from './helpers/uniqueStamp';

const API_SERVER = API_URL;

async function waitForChannelCount(page: Page, expected: number): Promise<string[]> {
    return page.evaluate(async (target) => {
        type Harness = { sseChannelUserIds(): string[] };
        const harness = (window as unknown as { __gtd: Harness }).__gtd;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            const ids = harness.sseChannelUserIds();
            if (ids.length >= target) {
                return ids;
            }
            await new Promise((r) => setTimeout(r, 100));
        }
        return harness.sseChannelUserIds();
    }, expected);
}

async function waitForItemTitle(page: Page, title: string): Promise<StoredItem> {
    const found = await page.evaluate(async (t) => {
        type Harness = { listItems(): Promise<StoredItem[]> };
        const harness = (window as unknown as { __gtd: Harness }).__gtd;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            const items = await harness.listItems();
            const match = items.find((i) => i.title === t);
            if (match) {
                return match;
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        return null;
    }, title);
    if (!found) {
        throw new Error(`Item "${title}" not found on device after 10s`);
    }
    return found;
}

test.describe('multi-account sync', () => {
    // A tab's boot sync can fail — another tab pivots the shared session cookie mid-pull, the server
    // hiccups — and that must not leave the tab without live updates: its channels still open, and
    // their first-open catch-up retries the sync.
    test('a failed boot sync still opens the live channels, which then retry the sync', async ({ browser }) => {
        const stamp = uniqueStamp();
        await withTwoAccountsOnOneDevice(
            browser,
            [`boot-fail-a-${stamp}@example.com`, `boot-fail-b-${stamp}@example.com`],
            async (page, { active, secondary }) => {
                const failedSyncFetches = { count: 0 };
                // Fail every pull until a channel has opened: the boot sync fails, the channel's catch-up later succeeds.
                const isChannelOpen = { value: false };
                // Only the reloaded document's channels count; the outgoing page's may request before it unloads.
                page.on('framenavigated', (frame) => {
                    if (frame === page.mainFrame()) isChannelOpen.value = false;
                });
                page.on('request', (request) => {
                    if (request.url().includes('/sync/events')) isChannelOpen.value = true;
                });
                // Bootstrap or pull, whichever the boot sync takes, fails until a channel has opened.
                await page.route(/\/sync\/(pull|bootstrap)/, async (route) => {
                    if (isChannelOpen.value) {
                        await route.continue();
                        return;
                    }
                    failedSyncFetches.count += 1;
                    await route.fulfill({ status: 500, body: '{}' });
                });

                await page.reload();

                await expect.poll(() => gtd.sseChannelUserIds(page), { timeout: 15_000 }).toEqual(expect.arrayContaining([active.userId, secondary.userId]));
                expect(failedSyncFetches.count).toBeGreaterThan(0);
            },
            // page.route cannot intercept requests the service worker makes once it controls the page.
            { serviceWorkers: 'block' },
        );
    });

    test('GET /sync/events?userId= rejects users that are not sessions on this device with 403', async ({ browser }) => {
        const email = `sse-403-${uniqueStamp()}@example.com`;
        const ctx = await browser.newContext();
        try {
            await loginAs(ctx, email);
            const page = (await ctx.pages())[0] ?? (await ctx.newPage());
            // Random uuid that is not a session on this device → server must reject with 403.
            const status = await page.evaluate(async (apiServer) => {
                const res = await fetch(`${apiServer}/sync/events?userId=00000000-0000-4000-8000-000000000000`, {
                    credentials: 'include',
                });
                // Drain so the connection closes promptly even if the server were (incorrectly) to stream.
                if (res.body) {
                    await res.body.cancel();
                }
                return res.status;
            }, API_SERVER);
            expect(status).toBe(403);
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('cross-device SSE delivers updates per account on a multi-account device', async ({ browser }) => {
        const ts = uniqueStamp();
        const emailA = `cross-a-${ts}@example.com`;
        const emailB = `cross-b-${ts}@example.com`;
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page1, accounts) => {
            // Both channels need to be open before the second device fires updates,
            // otherwise the SSE event would arrive before the listener exists.
            const channels = await waitForChannelCount(page1, 2);
            expect(new Set(channels)).toEqual(new Set([accounts.active.userId, accounts.secondary.userId]));

            const ctx2 = await browser.newContext();
            try {
                const page2A = await loginAs(ctx2, emailA);
                await gtd.collect(page2A, 'A from device 2');
                await gtd.flush(page2A);

                // Device 1's a@ SSE channel fires → multiUserSync pulls a@'s ops → unified inbox shows it.
                const seen = await waitForItemTitle(page1, 'A from device 2');
                expect(seen.userId).toBe(accounts.active.userId);
            } finally {
                await closeContextQuietly(ctx2);
            }
        });
    });
});
