import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Cross-account reassign and active-account switching are the two mutations that can't join the
// offline sync queue (both need server round-trips that can't be replayed later). These tests lock
// in the graceful-block behavior: offline users get a disabled control + explanation up front, or
// a specific "You're offline" notice on a save-time attempt — never a doomed request.

test.describe('offline account actions — graceful block', () => {
    test('item editor: owner change picked online but saved offline shows the offline notice and moves nothing', async ({ browser }) => {
        const ts = dayjs().valueOf();
        const emailA = `off-reassign-a-${ts}@example.com`;
        const emailB = `off-reassign-b-${ts}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active }) => {
            // Wait for the multi-account boot to settle (one cursor row per user) before writing —
            // an op queued mid-boot can race the orchestrator's pull into the blocking Case-2
            // sync-recovery dialog, and a flush fired during recovery never drains.
            await expect.poll(async () => new Set((await gtd.syncState(page)).syncCursors.map((c) => c.userId)).size, { timeout: 15_000 }).toBe(2);
            const item = await gtd.collect(page, 'Offline move target');
            await gtd.flush(page);
            await expect.poll(async () => (await gtd.queuedOps(page)).length, { timeout: 10_000 }).toBe(0);
            await page.goto(`/item/${item._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();
            await expect(page.getByTestId('syncRecoveryDialog')).toBeHidden();

            // Pick the other owner while still online (the picker is disabled once offline), and
            // edit the title so the block has pending edits to protect.
            await page.getByTestId('accountPicker').click();
            await page.getByRole('option', { name: new RegExp(emailB) }).click();
            await page.getByRole('textbox', { name: 'Title' }).fill('Offline move target RENAMED');

            // The block must happen BEFORE any request — a fired-and-failed request would mean the
            // old doomed-attempt behavior, not the graceful block.
            const reassignRequests: string[] = [];
            page.on('request', (request) => {
                if (request.url().includes('/sync/reassign')) {
                    reassignRequests.push(request.url());
                }
            });

            // …then lose the network before saving.
            await page.context().setOffline(true);
            await page.getByRole('button', { name: 'Save changes' }).click();

            await expect(page.getByText(/You're offline — "Offline move target RENAMED" wasn't moved/)).toBeVisible();

            // The editor stayed open with the pending edits intact — closing would discard them.
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Offline move target RENAMED');
            expect(reassignRequests).toHaveLength(0);

            // The item never left the source account (IDB read — works offline).
            const after = (await gtd.listItems(page)).find((i) => i._id === item._id);
            expect(after?.userId).toBe(active.userId);
        });
    });

    test('person edit dialog: account picker is disabled offline with an explanation', async ({ browser }) => {
        const ts = dayjs().valueOf();
        const emailA = `off-person-a-${ts}@example.com`;
        const emailB = `off-person-b-${ts}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page) => {
            // Same boot-settle wait as above — writing before both cursor rows exist can race the
            // orchestrator into the blocking Case-2 sync-recovery dialog.
            await expect.poll(async () => new Set((await gtd.syncState(page)).syncCursors.map((c) => c.userId)).size, { timeout: 15_000 }).toBe(2);
            await gtd.createPerson(page, { name: 'Offline Dana' });
            await gtd.flush(page);
            await expect.poll(async () => (await gtd.queuedOps(page)).length, { timeout: 10_000 }).toBe(0);
            await page.goto('/people');
            await expect(page.getByText('Offline Dana')).toBeVisible();

            await page.context().setOffline(true);
            await page.getByTestId('personRowEditButton').first().click();

            // MUI marks both the Select root and its display node with Mui-disabled when disabled.
            const picker = page.getByTestId('accountPicker');
            await expect(picker).toHaveClass(/Mui-disabled/);
            await expect(page.getByTestId('accountPickerOfflineNote')).toBeVisible();
        });
    });

    test('person edit dialog: a server-rejected move keeps the dialog open with an inline error and no false success', async ({ browser }) => {
        const ts = dayjs().valueOf();
        const emailA = `rej-person-a-${ts}@example.com`;
        const emailB = `rej-person-b-${ts}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page) => {
            await expect.poll(async () => new Set((await gtd.syncState(page)).syncCursors.map((c) => c.userId)).size, { timeout: 15_000 }).toBe(2);
            await gtd.createPerson(page, { name: 'Rejected Dana' });
            await gtd.flush(page);
            await expect.poll(async () => (await gtd.queuedOps(page)).length, { timeout: 10_000 }).toBe(0);
            await page.goto('/people');
            await expect(page.getByText('Rejected Dana')).toBeVisible();

            // Force a server rejection without depending on server state — the client-side
            // handling (inline error, dialog stays open, no "Moved to …" snackbar) is what's
            // under test here.
            await page.route('**/sync/reassign', (route) =>
                route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'rejected by test' }) }),
            );

            await page.getByTestId('personRowEditButton').first().click();
            await page.getByTestId('accountPicker').click();
            await page.getByRole('option', { name: new RegExp(emailB) }).click();

            await expect(page.getByText(/Couldn't move "Rejected Dana" — rejected by test/)).toBeVisible();
            // Dialog still open (Close button present), and no false "Moved to …" undo snackbar.
            await expect(page.getByTestId('personEditClose')).toBeVisible();
            await expect(page.getByText(/Moved to/)).toHaveCount(0);
        });
    });

    test('account switcher offline: switching stays enabled (local-first); add-account and sign-out are blocked with an explanation', async ({ browser }) => {
        const ts = dayjs().valueOf();
        const emailA = `off-switch-a-${ts}@example.com`;
        const emailB = `off-switch-b-${ts}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await page.goto('/inbox');
            await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();

            await page.context().setOffline(true);
            const trigger = page.getByTestId('accountSwitcherTrigger').locator('visible=true').first();
            await trigger.click();

            // Switching is local-first (IDB write + reload) so BOTH account rows stay enabled
            // offline. The full offline-switch flow (cached data render + cookie reconcile on
            // reconnect) is covered by offline-account-switch.spec.ts — real setOffline can't
            // serve the dev-server shell across the reload, so we stop at the enabled state here.
            await expect(page.getByTestId(`accountSwitcherItem-${secondary.userId}`)).not.toHaveAttribute('aria-disabled', 'true');
            await expect(page.getByTestId(`accountSwitcherItem-${active.userId}`)).not.toHaveAttribute('aria-disabled', 'true');

            // Add-account (OAuth redirect) and sign-out (Better Auth teardown) genuinely need the
            // network — those stay blocked, with the subheader note explaining why.
            await expect(page.getByTestId('accountSwitcherOfflineNote')).toBeVisible();
            await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toHaveAttribute('aria-disabled', 'true');
        });
    });
});
