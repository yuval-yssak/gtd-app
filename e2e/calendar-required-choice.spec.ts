import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// E2E coverage for Step 2's mandatory post-OAuth calendar choice. After connecting an integration,
// the user MUST pick at least one calendar — the ChooseCalendarDialog has no "Skip" button. Until
// they do, the integration row surfaces a "No calendar selected — choose one" CTA.

const SETTINGS_URL = 'http://localhost:4173/settings';
const DEV_SEED_INTEGRATION_URL = 'http://localhost:4000/dev/calendar/seed-integration';

interface SeedResponse {
    ok: boolean;
    integrationId: string;
    configIds: string[];
}

/** Seed an integration with NO sync configs — simulates the post-OAuth state where the user dismissed the picker. */
async function seedIntegrationWithoutConfigs(userId: string): Promise<SeedResponse> {
    const res = await fetch(DEV_SEED_INTEGRATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }), // calendars omitted
    });
    if (!res.ok) {
        throw new Error(`seed failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as SeedResponse;
}

test.describe('calendar required-choice', () => {
    test('integration row shows "No calendar selected" CTA when no sync configs exist', async ({ browser }) => {
        const email = `choose-empty-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            await seedIntegrationWithoutConfigs(userId);

            await page.goto(SETTINGS_URL);

            // NoCalendarChosenRow renders this exact text under the integration row. Allow 10s
            // because the settings page mounts → fetches /calendar/integrations → renders the row,
            // which is two awaits (and parallel-runner contention can stretch that out).
            await expect(page.getByText('No calendar selected — choose one')).toBeVisible({ timeout: 10_000 });
            await expect(page.getByRole('button', { name: 'Choose calendar' })).toBeVisible();
        });
    });

    test('ChooseCalendarDialog has no Skip button — choice is mandatory', async ({ browser }) => {
        const email = `choose-no-skip-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            await seedIntegrationWithoutConfigs(userId);

            // The dialog auto-opens on settings load when ?calendarConnected=1, but our seed path
            // doesn't trigger that branch — open it via the explicit "Choose calendar" CTA.
            await page.goto(SETTINGS_URL);
            await page.getByRole('button', { name: 'Choose calendar' }).click();

            const dialog = page.getByRole('dialog', { name: 'Choose a calendar to sync' });
            await expect(dialog).toBeVisible();

            // Step 2 explicitly removed the Skip button — assert it is NOT present.
            await expect(dialog.getByRole('button', { name: /skip/i })).toHaveCount(0);
            // Save & sync is the only action button.
            await expect(dialog.getByRole('button', { name: /Save & sync/i })).toBeVisible();
        });
    });

    test('after seeding a sync config, the row stops showing the "no calendar selected" CTA', async ({ browser }) => {
        // We don't drive the ChooseCalendarDialog → createSyncConfig flow itself (that would require
        // mocking the GCal calendars list). Instead seed a config server-side and assert the row
        // updates after a settings refresh.
        const email = `choose-after-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            const seeded = await seedIntegrationWithoutConfigs(userId);

            // Re-seed using the same integrationId but supplying a calendar — this adds a sync config row.
            await fetch(DEV_SEED_INTEGRATION_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId,
                    integrationId: seeded.integrationId,
                    calendars: [{ calendarId: 'primary', displayName: 'Primary', isDefault: true }],
                }),
            });

            await page.goto(SETTINGS_URL);
            // Once the sync config exists, the empty-state CTA disappears.
            await expect(page.getByText('No calendar selected — choose one')).toHaveCount(0);
        });
    });
});
