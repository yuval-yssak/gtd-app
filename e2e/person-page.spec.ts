import { expect, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// /person/:id is a full-page editor (same autosaving body as the /people edit dialog) so external
// deep links — e.g. the `url` the MCP server stamps on person tool responses — land somewhere real.

test.describe('Person editor — page mode', () => {
    test('deep link renders the full-page editor and edits autosave', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `person-page-${uniqueStamp()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Carmel', email: 'carmel@example.com' });

            await page.goto(`/person/${person._id}`);
            await expect(page.getByTestId('personPageWrapper')).toBeVisible();
            await expect(page.getByTestId('personEditName').locator('input')).toHaveValue('Carmel');
            await expect(page.getByTestId('personEditEmail').locator('input')).toHaveValue('carmel@example.com');

            // No Save button — the debounce commits and the undo snackbar appears.
            await page.getByTestId('personEditName').locator('input').fill('Carmel Blanca');
            await expect(page.getByTestId('undoSnackbar')).toBeVisible();
            await expect.poll(async () => (await gtd.listPeople(page)).map((p) => p.name)).toContain('Carmel Blanca');

            // Persisted, not just local state: a fresh load of the page shows the new name.
            await page.reload();
            await expect(page.getByTestId('personEditName').locator('input')).toHaveValue('Carmel Blanca');
        });
    });

    // The row body is a real button now (it was a click-only text block): keyboard users open the
    // person page with Enter, like every other list row.
    test('a people row opens the person page from the keyboard', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `person-page-keyboard-${uniqueStamp()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Keyboard Kim' });
            await gtd.flush(page);

            await page.goto('/people');
            await page.getByTestId('personRowText').filter({ hasText: 'Keyboard Kim' }).focus();
            await page.keyboard.press('Enter');

            await expect(page).toHaveURL(new RegExp(`/person/${person._id}$`));
            await expect(page.getByTestId('personEditName').locator('input')).toHaveValue('Keyboard Kim');
        });
    });

    test('the back arrow leaves the page to the people list', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `person-page-back-${uniqueStamp()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Backer' });

            // Deep link (no in-app history) — back falls back to /people.
            await page.goto(`/person/${person._id}`);
            await expect(page.getByTestId('personPageWrapper')).toBeVisible();
            await page.getByRole('button', { name: 'Go back' }).click();
            await expect(page).toHaveURL(/\/people$/);
            await expect(page.getByText('Backer')).toBeVisible();
        });
    });

    test('row click on /people opens the page; back restores the filtered list, query intact', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `person-page-nav-${uniqueStamp()}@example.com`, async (page) => {
            await gtd.createPerson(page, { name: 'Navvy' });
            await gtd.createPerson(page, { name: 'Other' });

            await page.goto('/people');
            await page.getByTestId('peopleSearchButton').click();
            await page.getByTestId('peopleSearchInput').fill('nav');
            // Wait for the debounced URL write — the recorded back target must carry ?q=nav.
            await expect(page).toHaveURL(/q=nav/);
            await expect(page.getByTestId('personRowText')).toHaveCount(1);

            await page.getByTestId('personRowText').click();
            await expect(page.getByTestId('personPageWrapper')).toBeVisible();
            await expect(page).toHaveURL(/\/person\//);

            // Back returns to the exact list location, search param (and thus the filter) intact.
            await page.getByRole('button', { name: 'Go back' }).click();
            await expect(page).toHaveURL(/\/people\?q=nav/);
            await expect(page.getByTestId('personRowText')).toHaveCount(1);
            await expect(page.getByTestId('personRowText')).toContainText('Navvy');
        });
    });

    test('an unknown id shows the not-found copy instead of a broken page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `person-page-404-${uniqueStamp()}@example.com`, async (page) => {
            await page.goto('/person/no-such-person-id');
            await expect(page.getByText('Person not found — they may have been deleted.')).toBeVisible();
            await page.getByRole('button', { name: 'Back to People' }).click();
            await expect(page).toHaveURL(/\/people$/);
        });
    });
});
