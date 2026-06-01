import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { fetchDevMultiSessionCookies } from './helpers/context';
import { gtd } from './helpers/gtd';
import { fetchDevSessionCookie, loginAs } from './helpers/login';

const CLIENT_URL = 'http://localhost:4173';

// Adding a SECOND account is the case the empty-state skeleton can't cover: account A's items are
// already on screen (unified multi-account view), so no list page is "empty" and the skeleton never
// shows. The AccountSyncChip ("Syncing account…") surfaces the indicator in the header regardless,
// while account B does its first-launch bootstrap.
//
// Reproduction: log a device in as A (settles → A has a cursor + items in IDB). Then add B's
// multi-session cookies with B active and re-enter via /auth/callback (the real add-account flow,
// which hydrates B as the IDB-active account). B has no cursor → isInitialSyncing fires. We throttle
// B's bootstrap so the chip is observable; A's item must stay visible throughout.
test.describe('second-account sync chip', () => {
    test('header chip shows while the newly-added account bootstraps; existing items stay', async ({ browser }) => {
        const emailA = `acctA-${dayjs().valueOf()}@example.com`;
        const emailB = `acctB-${dayjs().valueOf()}@example.com`;

        // Seed A's data on the server via a throwaway device.
        const seedCtx = await browser.newContext();
        try {
            const seedPage = await loginAs(seedCtx, emailA);
            await gtd.collect(seedPage, 'Account A task');
            await gtd.flush(seedPage);
        } finally {
            await seedCtx.close();
        }

        const ctx = await browser.newContext();
        try {
            // First boot as A only — A bootstraps, its item lands in IDB, and A gets a sync cursor.
            await fetchDevSessionCookie(emailA); // ensures A's user exists for the multi-login below
            const page = await loginAs(ctx, emailA);
            await expect(page.getByText('Account A task')).toBeVisible();

            // Add B: install the multi-session cookie set with B active (index 0), then re-enter via
            // /auth/callback exactly like the real add-account redirect. B has no cursor on this device.
            const { cookies } = await fetchDevMultiSessionCookies([emailB, emailA], 0);
            await ctx.addCookies(cookies);

            // Throttle B's bootstrap so the chip is observable before B's (empty) data settles.
            await page.route('**/sync/bootstrap*', async (route) => {
                await new Promise((r) => setTimeout(r, 1500));
                await route.continue();
            });

            await page.goto(`${CLIENT_URL}/auth/callback`);
            await page.waitForURL(`${CLIENT_URL}/inbox`);

            // The "Syncing account…" chip is visible while B bootstraps, and A's item never disappears.
            await expect(page.getByTestId('syncingChip')).toBeVisible();
            await expect(page.getByText('Syncing account…')).toBeVisible();
            await expect(page.getByText('Account A task')).toBeVisible();

            // Once B's bootstrap resolves the chip clears; A's item is still there.
            await expect(page.getByTestId('syncingChip')).toHaveCount(0, { timeout: 15_000 });
            await expect(page.getByText('Account A task')).toBeVisible();
        } finally {
            await ctx.close();
        }
    });
});
