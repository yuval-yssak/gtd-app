import { expect, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Verifies the Process Inbox wizard at /process-inbox. It hosts the full ItemEditorBody for each
// item (status chips, per-status forms, account picker), sequenced one item at a time — one shared
// code path with single-item editing. These tests pin:
// - "Process Inbox" opens the wizard page.
// - Save & next persists the per-item edits and advances to the next item.
// - Skip leaves the item in inbox and advances.
// - After the last item the run returns to the inbox with a toast summing it up.
// - An active inbox search narrows the run to the matching items.

test.describe('Process Inbox wizard', () => {
    test('walks through three items, saving each via the body', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pi-walk-${uniqueStamp()}@example.com`, async (page) => {
            const a = await gtd.collect(page, 'PI item A');
            const b = await gtd.collect(page, 'PI item B');
            const c = await gtd.collect(page, 'PI item C');
            await gtd.flush(page);

            await page.goto('/inbox');
            await page.waitForSelector('text=PI item A');

            await page.getByTestId('processInboxButton').click();
            await expect(page).toHaveURL(/\/process-inbox/);
            await expect(page.getByText('1 of 3')).toBeVisible();

            // Item 1 — switch to Next Action and save.
            // The wizard walks the inbox's manual order — captures are minted newest-first: C, B, A.
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('PI item C');
            await page.getByRole('button', { name: 'Next Action' }).click();
            await page.getByTestId('processInboxSaveNext').click();

            await expect(page.getByText('2 of 3')).toBeVisible();
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('PI item B');

            // Item 2 — Skip without saving.
            await page.getByTestId('processInboxSkip').click();

            await expect(page.getByText('3 of 3')).toBeVisible();
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('PI item A');

            // Item 3 — Trash chip + Save & finish.
            await page.getByRole('button', { name: 'Trash' }).click();
            await page.getByTestId('processInboxSaveNext').click();

            // Finishing returns to the inbox, where the toast reports the run.
            await expect(page).toHaveURL(/\/inbox$/);
            // Item B was skipped, so the run reports it as still in the inbox rather than claiming it clear.
            await expect(page.getByTestId('appNoticeToast')).toHaveText('Processed 2 of 3 — 1 still in the inbox.');

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === c._id)?.status).toBe('nextAction');
            expect(items.find((i) => i._id === b._id)?.status).toBe('inbox');
            expect(items.find((i) => i._id === a._id)?.status).toBe('trash');
        });
    });

    // Escape closes the body without saving: the wizard steps past the item, which stays in the
    // inbox — so it counts as skipped, never as processed.
    test('an item left with Escape counts as still in the inbox', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pi-escape-${uniqueStamp()}@example.com`, async (page) => {
            const first = await gtd.collect(page, 'PI escape first');
            const second = await gtd.collect(page, 'PI escape second');
            await gtd.flush(page);

            await page.goto('/inbox');
            await page.getByTestId('processInboxButton').click();
            await expect(page.getByText('1 of 2')).toBeVisible();
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('PI escape second');
            await page.keyboard.press('Escape');

            await expect(page.getByText('2 of 2')).toBeVisible();
            await page.getByRole('button', { name: 'Next Action' }).click();
            await page.getByTestId('processInboxSaveNext').click();

            await expect(page).toHaveURL(/\/inbox$/);
            await expect(page.getByTestId('appNoticeToast')).toHaveText('Processed 1 of 2 — 1 still in the inbox.');

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === second._id)?.status).toBe('inbox');
            expect(items.find((i) => i._id === first._id)?.status).toBe('nextAction');
        });
    });

    test('with an inbox search active, walks only the matching items and returns to the searched inbox', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pi-search-${uniqueStamp()}@example.com`, async (page) => {
            const bank = await gtd.collect(page, 'Call the bank');
            const dana = await gtd.collect(page, 'Email Dana');
            await gtd.flush(page);

            await page.goto('/inbox?q=bank');
            await expect(page.getByTestId('processInboxButton')).toHaveText('Process Inbox (1)');
            await page.getByTestId('processInboxButton').click();

            await expect(page).toHaveURL(/\/process-inbox\?q=bank/);
            await expect(page.getByText('1 of 1')).toBeVisible();
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Call the bank');
            await page.getByRole('button', { name: 'Someday / Maybe' }).click();
            await page.getByTestId('processInboxSaveNext').click();

            await expect(page).toHaveURL(/\/inbox\?q=bank/);
            await expect(page.getByTestId('appNoticeToast')).toHaveText('Inbox clear! All 1 item processed.');

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === bank._id)?.status).toBe('somedayMaybe');
            // Outside the search: never visited, still in the inbox.
            expect(items.find((i) => i._id === dana._id)?.status).toBe('inbox');
        });
    });
});
