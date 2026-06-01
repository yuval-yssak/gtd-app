import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// The calendar + routines pages show a "Syncing calendar…" chip while a Google Calendar
// integration sync is in flight (isCalendarSyncing). We seed an integration with fake tokens,
// throttle the per-integration `/calendar/integrations/:id/sync` POST, then reload — the boot
// `syncAndRefresh` re-runs the (throttled) calendar pass so the chip is observable.
//
// No real Google OAuth: the integration row is created via /dev/calendar/seed-integration.

const DEV_SEED_INTEGRATION_URL = 'http://localhost:4000/dev/calendar/seed-integration';

interface SeedResponse {
    ok: boolean;
    integrationId: string;
    configIds: string[];
}

async function seedIntegration(userId: string): Promise<SeedResponse> {
    const res = await fetch(DEV_SEED_INTEGRATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, calendars: [{ calendarId: 'primary', isDefault: true, displayName: 'Primary' }] }),
    });
    if (!res.ok) {
        throw new Error(`seed failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as SeedResponse;
}

test.describe('calendar sync chip', () => {
    test('calendar page shows "Syncing calendar…" while the integration sync runs, then clears it', async ({ browser }) => {
        const email = `cal-chip-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            await seedIntegration(userId);
            await gtd.pull(page);
            // A calendar item so the calendar page renders its populated header (chip lives beside the title).
            await gtd.collect(page, 'Has a calendar');

            // Throttle the per-integration sync so the in-flight window is observable.
            await page.route('**/calendar/integrations/*/sync', async (route) => {
                await new Promise((r) => setTimeout(r, 1500));
                await route.continue();
            });

            // Reload directly onto /calendar so the boot syncAndRefresh runs the throttled calendar pass here.
            await page.goto('http://localhost:4173/calendar');

            await expect(page.getByTestId('syncingChip')).toBeVisible();
            await expect(page.getByText('Syncing calendar…')).toBeVisible();

            // Once the throttled sync resolves the chip disappears.
            await expect(page.getByTestId('syncingChip')).toHaveCount(0);
        });
    });

    test('chip clears even when the integration sync fails (does not stick on)', async ({ browser }) => {
        const email = `cal-chip-fail-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            await seedIntegration(userId);
            await gtd.pull(page);
            await gtd.collect(page, 'Has a calendar');

            // Fail the integration sync after a short delay — the chip must still clear (the toggle
            // is in a finally, so a throwing/erroring calendar pass resets isCalendarSyncing).
            await page.route('**/calendar/integrations/*/sync', async (route) => {
                await new Promise((r) => setTimeout(r, 800));
                await route.fulfill({ status: 500, body: 'boom' });
            });

            await page.goto('http://localhost:4173/calendar');

            await expect(page.getByTestId('syncingChip')).toBeVisible();
            await expect(page.getByTestId('syncingChip')).toHaveCount(0, { timeout: 15_000 });
        });
    });

    test('routines page shows the same chip during a calendar sync', async ({ browser }) => {
        const email = `routines-chip-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            await seedIntegration(userId);
            await gtd.pull(page);

            await page.route('**/calendar/integrations/*/sync', async (route) => {
                await new Promise((r) => setTimeout(r, 1500));
                await route.continue();
            });

            await page.goto('http://localhost:4173/routines');

            await expect(page.getByTestId('syncingChip')).toBeVisible();
            await expect(page.getByTestId('syncingChip')).toHaveCount(0);
        });
    });
});
