import { expect, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// /work-context/:id is a full-page editor (same autosaving body as the /work-contexts rename
// dialog) so external deep links — e.g. the `url` the MCP server stamps on work-context tool
// responses — land somewhere real.

test.describe('Work context editor — page mode', () => {
    test('deep link renders the full-page editor and a rename autosaves', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wc-page-${uniqueStamp()}@example.com`, async (page) => {
            const workContext = await gtd.createWorkContext(page, '@phone');
            await gtd.flush(page);

            await page.goto(`/work-context/${workContext._id}`);
            await expect(page.getByTestId('workContextPageWrapper')).toBeVisible();
            const nameInput = page.getByTestId('workContextEditName').locator('input');
            await expect(nameInput).toHaveValue('@phone');
            await expect(page).toHaveTitle(/^@phone · /);

            // No Save button — the debounce commits and the undo snackbar appears.
            await nameInput.fill('@calls');
            await expect(page.getByTestId('undoSnackbar')).toBeVisible();
            await expect.poll(async () => (await gtd.listWorkContexts(page)).map((c) => c.name)).toContain('@calls');

            // Persisted, not just local state: a fresh load of the page shows the new name.
            await gtd.flush(page);
            await page.reload();
            await expect(page.getByTestId('workContextEditName').locator('input')).toHaveValue('@calls');
        });
    });

    test('Enter on the page saves without leaving it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wc-page-enter-${uniqueStamp()}@example.com`, async (page) => {
            const workContext = await gtd.createWorkContext(page, '@desk');
            await gtd.flush(page);

            await page.goto(`/work-context/${workContext._id}`);
            const nameInput = page.getByTestId('workContextEditName').locator('input');
            await nameInput.fill('@office');
            await nameInput.press('Enter');

            await expect.poll(async () => (await gtd.listWorkContexts(page)).map((c) => c.name)).toContain('@office');
            await expect(page).toHaveURL(new RegExp(`/work-context/${workContext._id}$`));
        });
    });

    // ESC leaves the page mid-debounce; the unmount flush must still land the rename.
    test('Escape leaves the page and keeps a rename typed just before it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wc-page-esc-${uniqueStamp()}@example.com`, async (page) => {
            const workContext = await gtd.createWorkContext(page, '@garden');
            await gtd.flush(page);

            await page.goto(`/work-context/${workContext._id}`);
            await page.getByTestId('workContextEditName').locator('input').fill('@yard');
            await page.keyboard.press('Escape');

            await expect(page).toHaveURL(/\/work-contexts$/);
            await expect.poll(async () => (await gtd.listWorkContexts(page)).map((c) => c.name)).toContain('@yard');
            await expect(page.getByTestId('workContextRowText').filter({ hasText: '@yard' })).toBeVisible();
        });
    });

    test('a work-context row opens the page from the keyboard; the pencil keeps the quick dialog', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wc-page-row-${uniqueStamp()}@example.com`, async (page) => {
            const workContext = await gtd.createWorkContext(page, '@errands');
            await gtd.flush(page);

            await page.goto('/work-contexts');
            await page.getByTestId('workContextRowEditButton').click();
            await expect(page.getByTestId('workContextEditClose')).toBeVisible();
            await expect(page).toHaveURL(/\/work-contexts$/);
            await page.getByTestId('workContextEditClose').click();

            await page.getByTestId('workContextRowText').filter({ hasText: '@errands' }).focus();
            await page.keyboard.press('Enter');
            await expect(page).toHaveURL(new RegExp(`/work-context/${workContext._id}$`));
            await expect(page.getByTestId('workContextEditName').locator('input')).toHaveValue('@errands');

            // Back returns to the list the row was opened from.
            await page.getByRole('button', { name: 'Go back' }).click();
            await expect(page).toHaveURL(/\/work-contexts$/);
        });
    });

    test('the back arrow on a cold deep link falls back to the work-contexts list', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wc-page-back-${uniqueStamp()}@example.com`, async (page) => {
            const workContext = await gtd.createWorkContext(page, '@home');
            await gtd.flush(page);

            await page.goto(`/work-context/${workContext._id}`);
            await expect(page.getByTestId('workContextPageWrapper')).toBeVisible();
            await page.getByRole('button', { name: 'Go back' }).click();
            await expect(page).toHaveURL(/\/work-contexts$/);
            await expect(page.getByTestId('workContextRowText').filter({ hasText: '@home' })).toBeVisible();
        });
    });

    test('an unknown id shows the not-found copy instead of a broken page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wc-page-404-${uniqueStamp()}@example.com`, async (page) => {
            await page.goto('/work-context/no-such-context-id');
            await expect(page.getByText('Work context not found — it may have been deleted.')).toBeVisible();
            await page.getByRole('button', { name: 'Back to Work Contexts' }).click();
            await expect(page).toHaveURL(/\/work-contexts$/);
        });
    });
});
