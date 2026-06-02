import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Regression for the per-calendar sync toggle reverting on navigation. The toggle updated the
// server + the row's local React state, but did NOT invalidate the module-level integrations
// resource cache. So the change "stuck" after a full reload (which rebuilds the module) but
// reverted when navigating away and back (which re-seeds the row from the stale cached promise).
//
// Fix: the toggle/set-default/remove handlers now invalidate the resource on success. This spec
// drives the toggle, navigates away and back (an in-SPA navigation, NOT a reload), and asserts
// the new value survived.
//
// No real Google OAuth: the integration + two sync configs are created via /dev/calendar/seed-integration.

const SETTINGS_URL = 'http://localhost:4173/settings';
const DEV_SEED_INTEGRATION_URL = 'http://localhost:4000/dev/calendar/seed-integration';

interface SeedResponse {
    ok: boolean;
    integrationId: string;
    configIds: string[];
}

// Seed two synced calendars so we can toggle a NON-default one off without disabling the only
// calendar. Each switch is reachable by its aria-label "Sync <displayName>".
async function seedTwoCalendars(userId: string): Promise<SeedResponse> {
    const res = await fetch(DEV_SEED_INTEGRATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId,
            calendars: [
                { calendarId: 'primary', displayName: 'Primary', isDefault: true },
                { calendarId: 'secondary', displayName: 'Secondary', isDefault: false },
            ],
        }),
    });
    if (!res.ok) {
        throw new Error(`seed failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as SeedResponse;
}

test.describe('calendar sync toggle persistence', () => {
    test('toggling a calendar off survives navigating away and back (not just a reload)', async ({ browser }) => {
        const email = `cal-toggle-persist-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            await seedTwoCalendars(userId);

            await page.goto(SETTINGS_URL);

            const secondaryToggle = page.getByRole('checkbox', { name: 'Sync Secondary' });
            // 10s: settings mount → fetch /calendar/integrations → render the row is two awaits.
            await expect(secondaryToggle).toBeChecked({ timeout: 10_000 });

            // Toggle the non-default calendar off and let the PATCH round-trip settle.
            await secondaryToggle.click();
            await expect(secondaryToggle).not.toBeChecked();

            // In-SPA navigation away and back via the sidebar links (NOT page.goto/reload, which
            // would mask the bug by tearing down the module and rebuilding the resource cache from
            // the server). These are real TanStack Links — clicking routes client-side. The default
            // desktop viewport (1280px) shows the permanent drawer; the temporary one is display:none,
            // so role queries (visible-only) resolve to a single matching link.
            await page.getByRole('link', { name: 'Inbox' }).click();
            await expect(page).toHaveURL(/\/inbox$/);
            await page.getByRole('link', { name: 'Settings' }).click();
            await expect(page).toHaveURL(/\/settings$/);

            // The off state must persist — pre-fix this re-seeded from the stale cache as checked.
            await expect(page.getByRole('checkbox', { name: 'Sync Secondary' })).not.toBeChecked({ timeout: 10_000 });
            // The default calendar is untouched.
            await expect(page.getByRole('checkbox', { name: 'Sync Primary' })).toBeChecked();
        });
    });
});
