import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

const CLIENT_URL = 'http://localhost:4173';

// Person + work-context edit dialogs are fully autosaving: no Save button, edits debounce into
// IDB writes with a "Saved — UNDO" snackbar, and Close is the only dialog action.

test.describe('people + work contexts autosave', () => {
    test('person rename autosaves without a Save button and Undo restores the old name', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `autosave-person-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createPerson(page, { name: 'Dana' });
            await page.goto(`${CLIENT_URL}/people`);

            await page.getByTestId('personRowEditButton').click();
            const nameField = page.getByTestId('personEditName').locator('input');
            await nameField.fill('Dana Lee');

            // No Save click — the debounce commits and the undo snackbar appears.
            await expect(page.getByTestId('undoSnackbar')).toBeVisible();
            await page.getByTestId('personEditClose').click();
            await expect(page.getByText('Dana Lee')).toBeVisible();

            // Persisted, not just re-rendered:
            const people = await gtd.listPeople(page);
            expect(people.map((p) => p.name)).toContain('Dana Lee');

            await page.getByTestId('undoSnackbarButton').click();
            await expect(page.getByText('Dana', { exact: true })).toBeVisible();
            const reverted = await gtd.listPeople(page);
            expect(reverted.map((p) => p.name)).toContain('Dana');
        });
    });

    test('person edits survive closing the dialog before the debounce settles (flush-on-unmount)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `autosave-person-flush-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createPerson(page, { name: 'Ben' });
            await page.goto(`${CLIENT_URL}/people`);

            await page.getByTestId('personRowEditButton').click();
            await page.getByTestId('personEditName').locator('input').fill('Ben Quick');
            // Close immediately — no debounce wait. The unmount flush must persist the rename.
            await page.getByTestId('personEditClose').click();

            await expect(page.getByText('Ben Quick')).toBeVisible();
            await expect.poll(async () => (await gtd.listPeople(page)).map((p) => p.name)).toContain('Ben Quick');
        });
    });

    test('an empty name is never persisted', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `autosave-person-blank-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createPerson(page, { name: 'Keepme' });
            await page.goto(`${CLIENT_URL}/people`);

            await page.getByTestId('personRowEditButton').click();
            const nameField = page.getByTestId('personEditName').locator('input');
            await nameField.fill('');
            await expect(page.getByText('Name is required — changes are not saved while empty.')).toBeVisible();
            await page.getByTestId('personEditClose').click();

            await expect.poll(async () => (await gtd.listPeople(page)).map((p) => p.name)).toContain('Keepme');
        });
    });

    test('work-context rename autosaves and Undo restores it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `autosave-ctx-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createWorkContext(page, '@office');
            await page.goto(`${CLIENT_URL}/work-contexts`);

            await page.getByTestId('workContextRowEditButton').click();
            await page.getByTestId('workContextEditName').locator('input').fill('@deep-work');

            await expect(page.getByTestId('undoSnackbar')).toBeVisible();
            await page.getByTestId('workContextEditClose').click();
            await expect(page.getByText('@deep-work')).toBeVisible();

            await page.getByTestId('undoSnackbarButton').click();
            await expect(page.getByText('@office')).toBeVisible();
        });
    });
});
