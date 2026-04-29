import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// E2E coverage for Step 3 of the multi-account calendar plan: the unified view that pulls
// items from every signed-in account, AccountChip rendering, and the multi-account calendar
// picker. Sync still happens per-active-account in this step, so seeding under the secondary
// user requires writing IDB rows directly with the secondary's userId.

const INBOX_URL = 'http://localhost:4173/inbox';
// Reuse the encrypted-token seed endpoint added by the Step 2 retrofit so the integration
// reads through the production decrypt path on /calendar/all-sync-configs without 500ing.
const DEV_SEED_CALENDAR_URL = 'http://localhost:4000/dev/calendar/seed-integration';

/**
 * Inserts a seed StoredItem directly into the device's IDB tagged with the supplied userId.
 * Bypasses the `__gtd.collect` resolveUserId path so the active-account-based shortcut
 * doesn't force us to pivot Better Auth sessions just to materialize a row in IDB.
 */
async function seedItemForUser(page: Page, userId: string, title: string): Promise<string> {
    return page.evaluate(
        ({ userId, title }) => {
            // Inline IDB-row shape so we don't have to import types into the page context.
            type IDBItem = { _id: string; userId: string; status: string; title: string; createdTs: string; updatedTs: string };
            type DBHandle = { put(store: 'items', value: IDBItem): Promise<unknown> };
            const dbHandle = (window as unknown as { __gtd: { db: DBHandle } }).__gtd.db;
            const id = `seed-${Math.random().toString(36).slice(2, 10)}`;
            const now = new Date().toISOString();
            const item: IDBItem = { _id: id, userId, status: 'inbox', title, createdTs: now, updatedTs: now };
            return dbHandle.put('items', item).then(() => id);
        },
        { userId, title },
    );
}

/** Re-renders the inbox by navigating away and back so the AppDataProvider re-reads IDB after a seed. */
async function reloadInbox(page: Page): Promise<void> {
    await page.goto(INBOX_URL);
    // Wait for inbox to render at least its header so subsequent locator queries don't race.
    await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
}

interface SeedCalendarRequest {
    userId: string;
    integrationId?: string;
    calendars: Array<{ calendarId: string; displayName?: string; isDefault?: boolean }>;
}

async function seedServerCalendarIntegration(req: SeedCalendarRequest): Promise<{ integrationId: string; configIds: string[] }> {
    const res = await fetch(DEV_SEED_CALENDAR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
    });
    if (!res.ok) {
        throw new Error(`POST /dev/calendar/seed-with-config ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as { integrationId: string; configIds: string[] };
}

test.describe('unified view — items + AccountChips', () => {
    test('inbox shows items from both signed-in accounts with AccountChips visible', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `unified-a-${stamp}@example.com`;
        const emailB = `unified-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            // Seed one item per user, both visible in IDB on the same device.
            await seedItemForUser(page, active.userId, 'A — buy milk');
            await seedItemForUser(page, secondary.userId, 'B — call dentist');
            await reloadInbox(page);

            // Both titles should be visible in the unified inbox.
            await expect(page.getByText('A — buy milk')).toBeVisible();
            await expect(page.getByText('B — call dentist')).toBeVisible();

            // AccountChips should appear next to each item — one per account email.
            const chipA = page.getByTestId('accountChip').filter({ hasText: emailA });
            const chipB = page.getByTestId('accountChip').filter({ hasText: emailB });
            await expect(chipA).toHaveCount(1);
            await expect(chipB).toHaveCount(1);
        });
    });

    test('signing one account out hides its items and removes its AccountChips', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `signout-a-${stamp}@example.com`;
        const emailB = `signout-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await seedItemForUser(page, active.userId, 'A — write report');
            await seedItemForUser(page, secondary.userId, 'B — review draft');
            await reloadInbox(page);

            // Sanity check both rendered.
            await expect(page.getByText('A — write report')).toBeVisible();
            await expect(page.getByText('B — review draft')).toBeVisible();

            // Drop the secondary account from IDB — that's the unified-view source of truth for
            // logged-in accounts. After a reload, the provider re-reads accounts and excludes
            // entities owned by users no longer in the list.
            await page.evaluate(async (uid) => {
                type DBHandle = {
                    delete(store: 'accounts', key: string): Promise<unknown>;
                    getAll(store: 'items'): Promise<Array<{ _id: string; userId: string }>>;
                    delete(store: 'items', key: string): Promise<unknown>;
                };
                const dbHandle = (window as unknown as { __gtd: { db: DBHandle } }).__gtd.db;
                await dbHandle.delete('accounts', uid);
                // Tearing down the IDB row mirrors what removeAccount does in production. Items
                // owned by the secondary still live in IDB but the cross-user reads ignore them.
            }, secondary.userId);
            await reloadInbox(page);

            // The secondary account's item disappears from the unified list.
            await expect(page.getByText('B — review draft')).toHaveCount(0);
            // Active item still visible.
            await expect(page.getByText('A — write report')).toBeVisible();
            // Only one account left → AccountChips are hidden entirely.
            await expect(page.getByTestId('accountChip')).toHaveCount(0);
        });
    });
});

test.describe('unified view — multi-account calendar picker', () => {
    test('all-sync-configs returns one bundle per signed-in account, each with its calendars', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `calpicker-a-${stamp}@example.com`;
        const emailB = `calpicker-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            // Seed an integration + sync configs for each user via the dev endpoint. The endpoint
            // bypasses real Google OAuth — we only need rows in calendarIntegrations + calendarSyncConfigs
            // so the unified-picker server endpoint has data to return.
            await seedServerCalendarIntegration({
                userId: active.userId,
                calendars: [
                    { calendarId: 'primary', displayName: 'A Primary', isDefault: true },
                    { calendarId: 'holidays-a', displayName: 'A Holidays' },
                ],
            });
            await seedServerCalendarIntegration({
                userId: secondary.userId,
                calendars: [{ calendarId: 'primary', displayName: 'B Primary', isDefault: true }],
            });

            // Read the unified bundles via the dev-tools wrapper (calls the same endpoint the
            // CalendarFields picker hits). Asserting at this layer is enough — the picker UI
            // is purely a function of these bundles.
            await reloadInbox(page);
            const bundles = await gtd.getAllSyncConfigs(page);
            expect(bundles).toHaveLength(2);

            const bundleA = bundles.find((b) => b.userId === active.userId);
            const bundleB = bundles.find((b) => b.userId === secondary.userId);
            expect(bundleA?.accountEmail).toBe(emailA);
            expect(bundleB?.accountEmail).toBe(emailB);
            expect(bundleA?.integrations).toHaveLength(1);
            expect(bundleA?.integrations[0]?.syncConfigs.map((c) => c.displayName).sort()).toEqual(['A Holidays', 'A Primary']);
            expect(bundleB?.integrations[0]?.syncConfigs.map((c) => c.displayName)).toEqual(['B Primary']);
        });
    });

    test('calendar picker dropdown groups calendars by owning account', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `dropdown-a-${stamp}@example.com`;
        const emailB = `dropdown-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await seedServerCalendarIntegration({
                userId: active.userId,
                calendars: [{ calendarId: 'primary', displayName: 'A Primary', isDefault: true }],
            });
            await seedServerCalendarIntegration({
                userId: secondary.userId,
                calendars: [{ calendarId: 'primary', displayName: 'B Primary', isDefault: true }],
            });

            // Use the Routines page rather than driving Inbox → Clarify → Calendar Select. The
            // routine dialog reuses the same multi-account picker logic, but it's reachable in
            // one click (Add routine button) so the test is far less timing-sensitive than the
            // chained inbox-row → calendar-action → dialog-mount flow.
            await page.goto(`http://localhost:4173/routines`);
            await expect(page.getByRole('heading', { name: 'Routines' })).toBeVisible();
            await page.getByRole('button', { name: 'Create routine' }).click();

            // Routine dialog mounts with the routineType ToggleButtonGroup defaulting to nextAction.
            // Switch to Calendar so the CalendarPicker renders below the schedule section.
            await expect(page.getByRole('dialog')).toBeVisible();
            await page.getByRole('button', { name: 'Calendar' }).click();

            // Open the Calendar Select to materialize its options. MUI exposes the closed-state
            // trigger as role=combobox with the field label as the accessible name.
            await page.getByRole('combobox', { name: 'Calendar' }).click();
            const listbox = page.getByRole('listbox');
            await expect(listbox).toBeVisible();

            // The listbox renders per-account headers (disabled MenuItems with the email) plus a
            // standard option per calendar plus the shared Default option. We don't constrain the
            // role of the headers — depending on MUI version they may surface as option or just text.
            await expect(listbox.getByText(emailA)).toBeVisible();
            await expect(listbox.getByText(emailB)).toBeVisible();
            await expect(listbox.getByText('A Primary')).toBeVisible();
            await expect(listbox.getByText('B Primary')).toBeVisible();
            await expect(listbox.getByText('Default')).toBeVisible();

            // Close the menu so test cleanup unmounts cleanly.
            await page.keyboard.press('Escape');
        });
    });
});
