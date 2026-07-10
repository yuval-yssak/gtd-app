import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { fetchDevMultiSessionCookies, resetServerForEmails, withTwoAccountsOnOneDevice } from './helpers/context';

// Regression test for the settings-page account drift: the calendar rows used to be fetched under
// the AMBIENT cookie session while the "Managing calendars for …" banner (and every pinned
// mutation) targeted the app-active account from IndexedDB. With multi-session drift
// (ambient ≠ IDB-active) the page showed one account's calendars under another account's banner —
// and row actions then hit the wrong integration. The fix pins the reads to the active account,
// so banner, rows, and actions always agree.

const CLIENT_URL = 'http://localhost:4173';
const DEV_SEED_CALENDAR_URL = 'http://localhost:4000/dev/calendar/seed-integration';

async function seedIntegrationWithCalendar(userId: string, integrationId: string, configId: string, displayName: string): Promise<void> {
    const res = await fetch(DEV_SEED_CALENDAR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId,
            integrationId,
            calendars: [{ configId, calendarId: 'primary', displayName, isDefault: true }],
        }),
    });
    if (!res.ok) {
        throw new Error(`seed-integration → ${res.status}: ${await res.text()}`);
    }
}

test('settings shows the app-active account calendars even when the ambient cookie session drifted to another account', async ({ browser }) => {
    const stamp = dayjs().valueOf();
    const emailA = `drift-active-${stamp}@example.com`;
    const emailB = `drift-ambient-${stamp}@example.com`;
    await resetServerForEmails([emailA, emailB]);

    await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
        // Each account owns one integration; the distinct calendar display names discriminate
        // whose rows the settings page actually rendered.
        await seedIntegrationWithCalendar(active.userId, `int-drift-a-${stamp}`, `cfg-drift-a-${stamp}`, 'Personal calendar A');
        await seedIntegrationWithCalendar(secondary.userId, `int-drift-b-${stamp}`, `cfg-drift-b-${stamp}`, 'Work calendar B');

        // Drift the AMBIENT session cookie to account B while the app-active account (IndexedDB)
        // stays A — the exact multi-session mismatch observed in the field. A fresh dev login for B
        // mints a new session whose `better-auth.session_token` cookie overwrites the ambient one.
        const drifted = await fetchDevMultiSessionCookies([secondary.email]);
        const ambientCookie = drifted.cookies.find((c) => c.name === 'better-auth.session_token');
        if (!ambientCookie) {
            throw new Error('expected the drifted login to return an ambient session cookie');
        }
        await page.context().addCookies([ambientCookie]);

        await page.goto(`${CLIENT_URL}/settings`);

        // The banner names the app-active account…
        await expect(page.getByText(`Managing calendars for ${active.email}`)).toBeVisible({ timeout: 10_000 });
        // …and the rows provably belong to it: A's calendar renders, B's never does.
        await expect(page.getByText('Personal calendar A')).toBeVisible({ timeout: 10_000 });
        await expect(page.getByText('Work calendar B')).toHaveCount(0);
    });
});
