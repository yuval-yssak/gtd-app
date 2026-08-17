import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// The /people list is alphabetical (archived parked at the bottom) and gets the same collapsible
// in-page search field the virtualized list pages use.

/** Person rows only — the nav drawer renders <li>s too, so scope by the archive button. */
function personRows(page: import('@playwright/test').Page) {
    return page.locator('li').filter({ has: page.getByTestId('personRowArchiveButton') });
}

test.describe('People list — order and search', () => {
    test('list is alphabetical regardless of case and creation order; archived sink to the bottom', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `people-order-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createPerson(page, { name: 'charlie' });
            await gtd.createPerson(page, { name: 'Alice' });
            await gtd.createPerson(page, { name: 'bob' });

            await page.goto('/people');
            await expect(personRows(page)).toContainText(['Alice', 'bob', 'charlie']);

            // Archiving Alice parks her at the bottom; the actives stay alphabetical.
            await personRows(page).filter({ hasText: 'Alice' }).getByTestId('personRowArchiveButton').click();
            await expect(personRows(page)).toContainText(['bob', 'charlie', 'Alice']);
        });
    });

    test('search filters by name and email, shows empty copy on no match, and clears on close', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `people-search-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createPerson(page, { name: 'Alice', email: 'alice@corp.example' });
            await gtd.createPerson(page, { name: 'Bob', phone: '555-0100' });

            await page.goto('/people');
            await page.getByTestId('peopleSearchButton').click();
            const searchInput = page.getByTestId('peopleSearchInput');

            await searchInput.fill('bob');
            await expect(personRows(page)).toContainText(['Bob']);
            await expect(personRows(page)).toHaveCount(1);

            // Email matches too — the query spans name/email/phone/notes.
            await searchInput.fill('corp.example');
            await expect(personRows(page)).toContainText(['Alice']);
            await expect(personRows(page)).toHaveCount(1);

            await searchInput.fill('zzz-no-match');
            await expect(page.getByTestId('peopleSearchEmpty')).toBeVisible();
            await expect(personRows(page)).toHaveCount(0);

            // Closing the field clears the query and restores the full list.
            await page.getByRole('button', { name: 'Close search' }).click();
            await expect(personRows(page)).toContainText(['Alice', 'Bob']);
        });
    });
});
