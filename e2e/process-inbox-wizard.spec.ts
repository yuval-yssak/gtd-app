import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

const CLARIFY_MODE_KEY = 'gtd:inlineClarifyMode';

// Verifies the unified Process Inbox wizard. The wizard now hosts the full ItemEditorBody for
// each item (status chips, per-status forms, account picker), sequenced one item at a time —
// one shared code path with single-item editing. These tests pin:
// - Save & next persists the per-item edits and advances to the next item.
// - Skip leaves the item in inbox and advances.
// - The terminal "Inbox clear!" screen appears after the last item.
// - The Item-editor setting routes "page" mode to /process-inbox.

test.describe('Process Inbox wizard', () => {
    test('walks through three items, saving each via the body', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pi-walk-${dayjs().valueOf()}@example.com`, async (page) => {
            const a = await gtd.collect(page, 'PI item A');
            const b = await gtd.collect(page, 'PI item B');
            const c = await gtd.collect(page, 'PI item C');

            await page.goto('/inbox');
            await page.waitForSelector('text=PI item A');

            await page.getByTestId('processInboxButton').click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            await expect(dialog.getByText('1 of 3')).toBeVisible();

            // Item 1 — switch to Next Action and save.
            await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue('PI item C');
            // Inbox sort is by createdTs DESC, so order is C, B, A. Pin to the actual order.
            await dialog.getByRole('button', { name: 'Next Action' }).click();
            await dialog.getByTestId('processInboxSaveNext').click();

            await expect(dialog.getByText('2 of 3')).toBeVisible();
            await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue('PI item B');

            // Item 2 — Skip without saving.
            await dialog.getByTestId('processInboxSkip').click();

            await expect(dialog.getByText('3 of 3')).toBeVisible();
            await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue('PI item A');

            // Item 3 — Trash chip + Save & finish.
            await dialog.getByRole('button', { name: 'Trash' }).click();
            await dialog.getByTestId('processInboxSaveNext').click();

            // Terminal "Inbox clear" screen.
            await expect(dialog.getByText('Inbox clear!')).toBeVisible();
            await dialog.getByTestId('processInboxDone').click();
            await expect(dialog).toBeHidden();

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === c._id)?.status).toBe('nextAction');
            expect(items.find((i) => i._id === b._id)?.status).toBe('inbox');
            expect(items.find((i) => i._id === a._id)?.status).toBe('trash');
        });
    });

    test('honors the page-mode setting by routing to /process-inbox and persisting saves', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pi-page-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'PI page item');
            await page.goto('/inbox');
            await page.waitForSelector('text=PI page item');

            await page.evaluate(
                (args) => {
                    localStorage.setItem(args.key, 'page');
                    window.dispatchEvent(new StorageEvent('storage', { key: args.key, newValue: 'page' }));
                },
                { key: CLARIFY_MODE_KEY },
            );

            await page.getByTestId('processInboxButton').click();
            await expect(page).toHaveURL(/\/process-inbox/);
            // The page-mode wizard exposes the same editor body — title field + Save & finish button.
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('PI page item');
            await expect(page.getByTestId('processInboxSaveNext')).toBeVisible();

            // Pin save-persistence: switch to Next Action and verify the underlying mutation lands.
            await page.getByRole('button', { name: 'Next Action' }).click();
            await page.getByTestId('processInboxSaveNext').click();
            await expect(page.getByText('Inbox clear!')).toBeVisible();

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === inbox._id)?.status).toBe('nextAction');
        });
    });

    test('collapses popover/expand/instant settings to the in-place dialog', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pi-expand-fallback-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.collect(page, 'PI expand fallback');
            await page.goto('/inbox');
            await page.waitForSelector('text=PI expand fallback');

            await page.evaluate(
                (args) => {
                    localStorage.setItem(args.key, 'expand');
                    window.dispatchEvent(new StorageEvent('storage', { key: args.key, newValue: 'expand' }));
                },
                { key: CLARIFY_MODE_KEY },
            );

            await page.getByTestId('processInboxButton').click();
            // Stays on /inbox — the dialog wizard is what the user sees, not navigation.
            await expect(page).toHaveURL(/\/inbox$/);
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            await expect(dialog.getByText('Process Inbox')).toBeVisible();
        });
    });
});
