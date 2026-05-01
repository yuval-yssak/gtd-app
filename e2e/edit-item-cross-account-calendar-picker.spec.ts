import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withTwoAccountsOnOneDevice } from './helpers/context';

// Regression for: opening EditItemDialog on a calendar-linked item, switching the AccountPicker
// to the secondary account, and finding no calendar selector — only the validation error
// "Pick a calendar from {email} before saving" with no UI to satisfy it.
//
// Two failure modes reproduced before the fix:
//   1. Picker hidden because the target account has only 1 calendar (length > 1 gate).
//   2. Picker shown but Select rendered empty because the previously-picked configId belongs
//      to the source account and is filtered out of visibleCalendarOptions.
//
// The fix relaxes the gate to length >= 1 and pre-fills the target's default/sole config when
// the owner changes. This test drives the dialog UI to confirm both effects.

const DEV_SEED_CALENDAR_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const DEV_SEED_ENTITY_URL = 'http://localhost:4000/dev/reassign/seed-entity';
const INBOX_URL = 'http://localhost:4173/inbox';

interface SeedCalendarResult {
    integrationId: string;
    configIds: string[];
}

async function seedCalendarForUser(
    userId: string,
    calendars: Array<{ configId: string; calendarId: string; displayName: string; isDefault: boolean }>,
): Promise<SeedCalendarResult> {
    const res = await fetch(DEV_SEED_CALENDAR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, calendars }),
    });
    if (!res.ok) {
        throw new Error(`seed calendar ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as SeedCalendarResult;
}

async function seedCalendarItemOnServer(userId: string, integrationId: string, configId: string, title: string): Promise<string> {
    const id = `seed-${Math.random().toString(36).slice(2, 10)}`;
    const now = dayjs().toISOString();
    const start = dayjs().add(1, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
    const end = dayjs().add(1, 'day').hour(9).minute(30).second(0).millisecond(0).toISOString();
    const doc = {
        _id: id,
        user: userId,
        status: 'calendar',
        title,
        timeStart: start,
        timeEnd: end,
        calendarEventId: `gcal-evt-${id}`,
        calendarIntegrationId: integrationId,
        calendarSyncConfigId: configId,
        createdTs: now,
        updatedTs: now,
    };
    const res = await fetch(DEV_SEED_ENTITY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'items', doc }),
    });
    if (!res.ok) {
        throw new Error(`seed item ${res.status}: ${await res.text()}`);
    }
    return id;
}

test.describe('EditItemDialog cross-account calendar picker', () => {
    // Each test scopes its /dev/reset to its unique stamped emails so concurrent specs in
    // other workers keep their session/user data.
    test('switching AccountPicker to a target account with one calendar shows the picker pre-filled with that calendar', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `cal-pick-a-${stamp}@example.com`;
        const emailB = `cal-pick-b-${stamp}@example.com`;
        // configIds carry the stamp so parallel workers don't collide on _id.
        const cfgAPrimary = `cfg-a-primary-${stamp}`;
        const cfgAOther = `cfg-a-other-${stamp}`;
        const cfgBSole = `cfg-b-sole-${stamp}`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            // Account A: two calendars (so the source-side Select is meaningful).
            const seedA = await seedCalendarForUser(active.userId, [
                { configId: cfgAPrimary, calendarId: 'primary', displayName: 'A Primary', isDefault: true },
                { configId: cfgAOther, calendarId: 'other-a', displayName: 'A Other', isDefault: false },
            ]);
            // Account B: exactly one calendar — pre-fix this hid the picker entirely (length > 1 gate).
            const seedB = await seedCalendarForUser(secondary.userId, [
                { configId: cfgBSole, calendarId: 'primary', displayName: 'B Primary', isDefault: true },
            ]);
            expect(seedB.configIds).toHaveLength(1);

            await seedCalendarItemOnServer(active.userId, seedA.integrationId, cfgAPrimary, 'Cross-account picker test');

            await page.goto(INBOX_URL);
            // Force a server pull so the seeded item shows up under the active account.
            await page.evaluate(async () => {
                await (window as unknown as { __gtd: { pull(): Promise<void> } }).__gtd.pull();
            });
            await page.goto('http://localhost:4173/calendar');
            await expect(page.getByText('Cross-account picker test')).toBeVisible({ timeout: 10_000 });

            // Open the dialog.
            await page.getByTestId('calendarItemEditButton').first().click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await expect(dialog).toBeVisible();

            // Verify the picker initially shows the source calendar. CalendarFields renders a raw
            // FormControl/InputLabel/Select without `htmlFor` linking, so the label is not a11y-
            // associated with the combobox — locate the FormControl by its label text and grab the
            // sibling Select trigger directly.
            const calendarSelect = dialog.locator('.MuiFormControl-root', { has: page.locator('label', { hasText: /^Calendar$/ }) }).locator('[role="combobox"]');
            await expect(calendarSelect).toBeVisible();

            // Switch the AccountPicker to the secondary account.
            await dialog.getByTestId('accountPicker').click();
            await page.getByRole('option', { name: new RegExp(emailB) }).click();

            // The Calendar select must remain visible (the target account has only 1 calendar —
            // the pre-fix gate `length > 1` would have hidden it here).
            await expect(calendarSelect).toBeVisible();

            // The pre-fill must point at the target's sole calendar so the user does not see
            // an empty Select after the owner switch — the bug under fix.
            await expect(calendarSelect).toHaveText(/B Primary/);

            // Sanity: changing back restores the original selection (item's own configId).
            await dialog.getByTestId('accountPicker').click();
            await page.getByRole('option', { name: new RegExp(emailA) }).click();
            await expect(calendarSelect).toHaveText(/A Primary/);
        });
    });
});
