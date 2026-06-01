import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { gtd } from './helpers/gtd';
import { fetchDevSessionCookie, loginAs } from './helpers/login';

const CLIENT_URL = 'http://localhost:4173';

// First launch on a fresh device runs a full `GET /sync/bootstrap` that can take many seconds.
// Before this change the list pages rendered their "empty" copy during that window, which read as
// "you have no items" rather than "still loading". The fix shows a skeleton (data-testid=listSkeleton)
// while `isInitialSyncing` is true — i.e. only when the active account has no sync cursor yet.
//
// To observe the skeleton deterministically we delay the bootstrap response on a second, fresh
// browser context for an account that already has data on the server. The first context seeds the
// data; the second context bootstraps through the throttled route.
test.describe('initial-sync skeleton', () => {
    test('fresh device shows skeleton during bootstrap, then items', async ({ browser }) => {
        const email = `skeleton-${dayjs().valueOf()}@example.com`;
        // Seed one item via a first context that logs in + settles normally, then flush to the server.
        const { cookie } = await fetchDevSessionCookie(email);
        const seedCtx = await browser.newContext();
        try {
            const seedPage = await loginAs(seedCtx, email);
            await gtd.collect(seedPage, 'Bootstrap me slowly');
            await gtd.flush(seedPage);
        } finally {
            await seedCtx.close();
        }

        // Fresh context (empty IndexedDB → no sync cursor → isInitialSyncing fires) with a delayed bootstrap.
        const freshCtx = await browser.newContext();
        try {
            await freshCtx.addCookies([cookie]);
            const page = await freshCtx.newPage();
            // Hold the bootstrap response for ~1.5s so the skeleton is observable before items land.
            await page.route('**/sync/bootstrap*', async (route) => {
                await new Promise((r) => setTimeout(r, 1500));
                await route.continue();
            });
            await page.goto(`${CLIENT_URL}/auth/callback`);
            await page.waitForURL(`${CLIENT_URL}/inbox`);

            // Skeleton is visible while the (throttled) bootstrap is in flight.
            await expect(page.getByTestId('listSkeleton')).toBeVisible();
            // The "empty" copy must NOT appear during the bootstrap window.
            await expect(page.getByText('Inbox zero — well done.')).toHaveCount(0);

            // Once bootstrap resolves, the seeded item renders and the skeleton disappears.
            // Generous timeout: the throttled bootstrap (1.5s) plus the post-pull resource refresh.
            await expect(page.getByText('Bootstrap me slowly')).toBeVisible({ timeout: 15_000 });
            await expect(page.getByTestId('listSkeleton')).toHaveCount(0);
        } finally {
            await freshCtx.close();
        }
    });

    test('returning device with cached items never shows the skeleton', async ({ browser }) => {
        const email = `skeleton-cached-${dayjs().valueOf()}@example.com`;
        const { cookie } = await fetchDevSessionCookie(email);
        const ctx = await browser.newContext();
        try {
            await ctx.addCookies([cookie]);
            const page = await ctx.newPage();
            await page.goto(`${CLIENT_URL}/auth/callback`);
            await page.waitForURL(`${CLIENT_URL}/inbox`);
            await page.waitForFunction(() => typeof (window as unknown as { __gtd?: unknown }).__gtd !== 'undefined');
            await page.evaluate(() => (window as unknown as { __gtd: { collect(t: string): Promise<unknown> } }).__gtd.collect('Already cached'));
            await page.evaluate(() => (window as unknown as { __gtd: { flush(): Promise<void> } }).__gtd.flush());

            // Reload: this device already has a cursor + cached items, so even a throttled pull
            // must not raise the skeleton — the data is already on screen.
            await page.route('**/sync/pull*', async (route) => {
                await new Promise((r) => setTimeout(r, 1000));
                await route.continue();
            });
            await page.reload();

            await expect(page.getByText('Already cached')).toBeVisible();
            await expect(page.getByTestId('listSkeleton')).toHaveCount(0);
        } finally {
            await ctx.close();
        }
    });
});
