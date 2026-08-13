import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Structural edits (status, schedule, contexts, …) only persist on explicit Save. Navigating
// away used to drop them silently — now an unsaved-changes dialog pauses in-app navigation.
// Autosaved text is exempt: navigation flushes it, so nothing is lost and nothing prompts.

const DAILY = { routineType: 'nextAction' as const, rrule: 'FREQ=DAILY;INTERVAL=1', template: {}, active: true };

test.describe('unsaved-changes guard — item editor', () => {
    test('status change + navigation prompts; Keep editing stays, Discard leaves without saving', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `guard-item-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Guard me');
            await page.goto(`/item/${item._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

            // Structural edit: pick a status chip, then try to leave via the back arrow.
            await page.getByRole('button', { name: 'Next Action' }).click();
            await page.getByRole('button', { name: 'Go back' }).click();

            const guardDialog = page.getByTestId('unsavedChangesDialog');
            await expect(guardDialog).toBeVisible();
            await page.getByTestId('unsavedChangesStay').click();
            await expect(guardDialog).toHaveCount(0);
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`)); // navigation was cancelled

            await page.getByRole('button', { name: 'Go back' }).click();
            await expect(guardDialog).toBeVisible();
            await page.getByTestId('unsavedChangesDiscard').click();
            await expect(page).toHaveURL(/\/inbox/);

            // The unsaved status change was discarded, not silently applied.
            const after = (await gtd.listItems(page)).find((i) => i._id === item._id);
            expect(after?.status).toBe('inbox');
        });
    });

    test('ESC with a pending structural edit triggers the guard, same as the back arrow', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `guard-esc-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Guard me via ESC');
            await page.goto(`/item/${item._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

            // Structural edit, then ESC — must route through the guarded navigation, not bypass it.
            await page.getByRole('button', { name: 'Next Action' }).click();
            await page.keyboard.press('Escape');

            const guardDialog = page.getByTestId('unsavedChangesDialog');
            await expect(guardDialog).toBeVisible();
            await page.getByTestId('unsavedChangesStay').click();
            await expect(guardDialog).toHaveCount(0);
            // The guard dialog is a MUI modal — wait for its exit so the next ESC isn't swallowed.
            // (:not() skips AppNav's keep-mounted mobile drawer, which is always in the DOM.)
            await expect(page.locator('.MuiModal-root:not([aria-hidden="true"])')).toHaveCount(0);
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`)); // navigation was cancelled

            await page.keyboard.press('Escape');
            await expect(guardDialog).toBeVisible();
            await page.getByTestId('unsavedChangesDiscard').click();
            await expect(page).toHaveURL(/\/inbox/);

            // The unsaved status change was discarded, not silently applied.
            const after = (await gtd.listItems(page)).find((i) => i._id === item._id);
            expect(after?.status).toBe('inbox');
        });
    });

    test('explicit Cancel never prompts — it is a deliberate discard', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `guard-cancel-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Cancel me');
            await page.goto(`/item/${item._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

            await page.getByRole('button', { name: 'Someday / Maybe' }).click();
            await page.getByRole('button', { name: 'Cancel' }).click();

            await expect(page).toHaveURL(/\/inbox/);
            await expect(page.getByTestId('unsavedChangesDialog')).toHaveCount(0);
        });
    });

    test('an owner change alone triggers the guard; Discard leaves ownership untouched', async ({ browser }) => {
        const ts = dayjs().valueOf();
        const emailA = `guard-owner-a-${ts}@example.com`;
        const emailB = `guard-owner-b-${ts}@example.com`;
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active }) => {
            // Wait for the multi-account boot to settle (one cursor row per user) before writing —
            // an op queued mid-boot can race the orchestrator's pull into the blocking Case-2
            // sync-recovery dialog (same guard as offline-reassign.spec.ts).
            await expect.poll(async () => new Set((await gtd.syncState(page)).syncCursors.map((c) => c.userId)).size, { timeout: 15_000 }).toBe(2);
            const item = await gtd.collect(page, 'Owner guard target');
            await page.goto(`/item/${item._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

            // Structural edit: repoint the owner via the AccountPicker, then try to leave.
            await page.getByTestId('accountPicker').click();
            await page.getByRole('option', { name: new RegExp(emailB) }).click();
            await page.getByRole('button', { name: 'Go back' }).click();

            await expect(page.getByTestId('unsavedChangesDialog')).toBeVisible();
            await page.getByTestId('unsavedChangesDiscard').click();
            await expect(page).toHaveURL(/\/inbox/);

            // The unsaved owner change was discarded — no reassign fired.
            const after = (await gtd.listItems(page)).find((i) => i._id === item._id);
            expect(after?.userId).toBe(active.userId);
        });
    });

    test('a title-only edit passes through — autosave flushes it on the way out', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `guard-title-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Rename me');
            await page.goto(`/item/${item._id}`);
            await page.getByRole('textbox', { name: 'Title' }).fill('Renamed on the way out');

            await page.getByRole('button', { name: 'Go back' }).click();
            await expect(page).toHaveURL(/\/inbox/); // no prompt — text is autosaved, not at risk
            await expect(page.getByTestId('unsavedChangesDialog')).toHaveCount(0);

            await expect.poll(async () => (await gtd.listItems(page)).map((i) => i.title)).toContain('Renamed on the way out');
        });
    });
});

test.describe('unsaved-changes guard — routine editor', () => {
    test('schedule change + sidebar navigation prompts; Discard leaves the schedule untouched', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `guard-routine-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, { ...DAILY, title: 'Guard routine' });
            // Page mode — the dialog chrome's modal backdrop would swallow sidebar clicks.
            await page.goto(`/routine/${routine._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

            await page.getByRole('button', { name: 'After N' }).click();

            await page.getByRole('link', { name: 'Inbox' }).click();
            const guardDialog = page.getByTestId('unsavedChangesDialog');
            await expect(guardDialog).toBeVisible();
            await page.getByTestId('unsavedChangesStay').click();
            await expect(guardDialog).toHaveCount(0);
            await expect(page).toHaveURL(new RegExp(`/routine/${routine._id}`)); // navigation was cancelled

            await page.getByRole('link', { name: 'Inbox' }).click();
            await expect(guardDialog).toBeVisible();
            await page.getByTestId('unsavedChangesDiscard').click();
            await expect(page).toHaveURL(/\/inbox/);

            const after = (await gtd.listRoutines(page)).find((r) => r._id === routine._id);
            expect(after?.rrule).toBe('FREQ=DAILY;INTERVAL=1');
        });
    });
});
