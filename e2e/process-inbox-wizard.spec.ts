import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Verifies the Process Inbox wizard at /process-inbox. It hosts the full ItemEditorBody for each
// item (status chips, per-status forms, account picker), sequenced one item at a time — one shared
// code path with single-item editing. These tests pin:
// - "Process Inbox" opens the wizard page.
// - Save & next persists the per-item edits and advances to the next item.
// - Skip leaves the item in inbox and advances.
// - The terminal "Inbox clear!" screen appears after the last item, and Done returns to the inbox.
// - An active inbox search narrows the run to the matching items.

test.describe('Process Inbox wizard', () => {
    test('walks through three items, saving each via the body', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pi-walk-${dayjs().valueOf()}@example.com`, async (page) => {
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

            // Terminal "Inbox clear" screen, then back to the inbox.
            await expect(page.getByText('Inbox clear!')).toBeVisible();
            await page.getByTestId('processInboxDone').click();
            await expect(page).toHaveURL(/\/inbox$/);

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === c._id)?.status).toBe('nextAction');
            expect(items.find((i) => i._id === b._id)?.status).toBe('inbox');
            expect(items.find((i) => i._id === a._id)?.status).toBe('trash');
        });
    });

    test('with an inbox search active, walks only the matching items and returns to the searched inbox', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pi-search-${dayjs().valueOf()}@example.com`, async (page) => {
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

            await expect(page.getByText('Inbox clear!')).toBeVisible();
            await page.getByTestId('processInboxDone').click();
            await expect(page).toHaveURL(/\/inbox\?q=bank/);

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === bank._id)?.status).toBe('somedayMaybe');
            // Outside the search: never visited, still in the inbox.
            expect(items.find((i) => i._id === dana._id)?.status).toBe('inbox');
        });
    });
});
