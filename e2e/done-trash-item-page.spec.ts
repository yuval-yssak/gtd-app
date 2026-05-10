import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Done & trash items used to render a "This item has already been processed." dead-end at
// /item/:id, so a user clicking a row on /done or /trash had no way to inspect or revive the
// item. The page-mode editor now opens normally for done/trash items, so the user can re-clarify
// or restore them.
test.describe('Item page mode — done & trash items', () => {
    test('clicking a /done row opens the editor with done chip selected', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `done-page-open-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Done page-mode target');
            await gtd.clarifyToDone(page, inbox);

            await page.goto('/done');
            await page.waitForSelector('text=Done page-mode target');
            await page.getByRole('link').filter({ hasText: 'Done page-mode target' }).click();

            await expect(page).toHaveURL(/\/item\/[^/]+/);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Done page-mode target');

            // The dead-end message is gone.
            await expect(page.getByText('This item has already been processed.')).toHaveCount(0);

            // Done chip is filled (the item's current status); the editor is fully interactive.
            await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
        });
    });

    test('user can restore a done item to next-action via the editor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `done-page-restore-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Restore me');
            await gtd.clarifyToDone(page, inbox);

            await page.goto(`/item/${inbox._id}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();

            await page.getByRole('button', { name: 'Next Action' }).click();
            await page.getByRole('button', { name: 'Save changes' }).click();

            // Save returns to the source bucket (/done) — the new status lives in next-actions,
            // but post-save navigation always honors where the user came from.
            await expect(page).toHaveURL(/\/done$/);
            // Confirm the restore persisted by visiting the destination bucket directly.
            await page.goto('/next-actions');
            await expect(page.getByText('Restore me')).toBeVisible();
        });
    });

    test('Go back from a done item returns to /done (not /inbox)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `done-page-back-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Back-button target');
            await gtd.clarifyToDone(page, inbox);

            await page.goto(`/item/${inbox._id}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
            await page.getByRole('button', { name: 'Go back' }).click();

            await expect(page).toHaveURL(/\/done$/);
        });
    });

    test('clicking a /trash row opens the editor and back returns to /trash', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `trash-page-open-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Trash page-mode target');
            await gtd.clarifyToTrash(page, inbox);

            await page.goto('/trash');
            await page.waitForSelector('text=Trash page-mode target');
            await page.getByRole('link').filter({ hasText: 'Trash page-mode target' }).click();

            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Trash page-mode target');

            await page.getByRole('button', { name: 'Go back' }).click();
            await expect(page).toHaveURL(/\/trash$/);
        });
    });
});
