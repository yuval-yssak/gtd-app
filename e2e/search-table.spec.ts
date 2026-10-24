import { expect, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// The search page's table view: a real <table> with a column picker, a title link per row (the
// keyboard way in) and the whole row clickable with a pointer.

test.describe('Search — table view', () => {
    test('switches to the table, toggles a column from the picker, and opens an item by link or row', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `search-table-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Tabled tulip');
            await gtd.flush(page);

            await page.goto('/search?q=tulip');
            await page.getByRole('button', { name: 'Table' }).click();
            await expect(page).toHaveURL(/view=table/);

            const table = page.getByRole('table');
            await expect(table.getByRole('columnheader')).toHaveText(['Title', 'Status', 'Updated', 'Expected by']);
            await expect(page.getByTestId('searchTableRow')).toHaveCount(1);
            await expect(page.getByTestId('searchTableRow').getByRole('cell').nth(1)).toHaveText('Inbox');

            // The picker adds a column and keeps it on the next visit (persisted per device).
            await page.getByTestId('searchColumnsButton').click();
            await page.getByRole('menuitemcheckbox', { name: 'Created' }).click();
            await expect(page.getByRole('menuitemcheckbox', { name: 'Created' })).toHaveAttribute('aria-checked', 'true');
            // Title is structural: it cannot be switched off.
            await expect(page.getByRole('menuitemcheckbox', { name: 'Title' })).toHaveAttribute('aria-disabled', 'true');
            await page.keyboard.press('Escape');
            await expect(table.getByRole('columnheader')).toHaveText(['Title', 'Status', 'Updated', 'Created', 'Expected by']);

            // Keyboard: the title is a link to the item page.
            await page.getByTestId('searchTableTitleLink').focus();
            await page.keyboard.press('Enter');
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`));

            // Pointer: a click anywhere on the row opens it too.
            await page.goBack();
            await expect(table.getByRole('columnheader')).toHaveText(['Title', 'Status', 'Updated', 'Created', 'Expected by']);
            await page.getByTestId('searchTableRow').getByRole('cell').nth(1).click();
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`));
        });
    });
});
