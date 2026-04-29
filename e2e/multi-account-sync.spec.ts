import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredItem } from '../client/src/types/MyDB';
import { withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';

const API_SERVER = 'http://localhost:4000';

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
    test('GET /sync/events?userId= rejects users that are not sessions on this device with 403', async ({ browser }) => {
        const email = `sse-403-${dayjs().valueOf()}@example.com`;
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
            await ctx.close();
        }
    });

    test('cross-device SSE delivers updates per account on a multi-account device', async ({ browser }) => {
        const ts = dayjs().valueOf();
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
                await ctx2.close();
            }
        });
    });
});
