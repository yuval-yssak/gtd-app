import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

const CLARIFY_MODE_KEY = 'gtd:inlineClarifyMode';

// The routine editor mirrors the item editor: same `gtd:inlineClarifyMode` setting drives both.
// These tests pin the user-visible behaviour for each chrome variant + the row-click affordance
// + the copy-id button on the routine row.
test.describe('Routine editor — chrome modes', () => {
    test('row click opens the dialog in default mode', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-row-click-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createRoutine(page, {
                title: 'Routine row-click target',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
            });

            await page.goto('/routines');
            await page.waitForSelector('text=Routine row-click target');

            await page.getByTestId('routineRow').filter({ hasText: 'Routine row-click target' }).click();
            const dialog = page.getByRole('dialog', { name: 'Edit routine' });
            await expect(dialog).toBeVisible();

            // Status chips from the item editor must NOT appear — routines have a Type toggle, not statuses.
            await expect(dialog.getByRole('button', { name: 'Waiting For' })).toHaveCount(0);
            await expect(dialog.getByRole('button', { name: 'Done' })).toHaveCount(0);
            await expect(dialog.getByRole('button', { name: 'Trash' })).toHaveCount(0);

            await dialog.getByRole('button', { name: 'Cancel' }).click();
            await expect(dialog).toBeHidden();
        });
    });

    test('clicking edit / pause / delete buttons in secondaryAction does not bubble to the row', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-secondary-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createRoutine(page, {
                title: 'Routine icon-click target',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
            });

            await page.goto('/routines');
            await page.waitForSelector('text=Routine icon-click target');

            // Pause icon opens the pause confirm dialog, not the editor.
            const targetRow = page.getByTestId('routineRow').filter({ hasText: 'Routine icon-click target' });
            await targetRow.locator('..').getByTestId('routineRowPauseButton').click();
            const pauseDialog = page.getByRole('dialog', { name: 'Pause routine?' });
            await expect(pauseDialog).toBeVisible();
            await pauseDialog.getByRole('button', { name: 'Cancel' }).click();
            await expect(pauseDialog).toBeHidden();

            // Edit icon opens the editor as expected.
            await targetRow.locator('..').getByTestId('routineRowEditButton').click();
            await expect(page.getByRole('dialog', { name: 'Edit routine' })).toBeVisible();
        });
    });

    test('page mode navigates to /routine/:id on row click', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-page-mode-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Routine page-mode target',
                routineType: 'nextAction',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                template: {},
                active: true,
            });

            await page.goto('/routines');
            await page.waitForSelector('text=Routine page-mode target');

            await page.evaluate(
                (args) => {
                    localStorage.setItem(args.key, 'page');
                    window.dispatchEvent(new StorageEvent('storage', { key: args.key, newValue: 'page' }));
                },
                { key: CLARIFY_MODE_KEY },
            );

            await page.getByTestId('routineRow').filter({ hasText: 'Routine page-mode target' }).click();
            await expect(page).toHaveURL(new RegExp(`/routine/${routine._id}`));
            await expect(page.getByTestId('routinePageWrapper')).toBeVisible();
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Routine page-mode target');
        });
    });

    test('expand mode opens inline under the row', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-expand-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createRoutine(page, {
                title: 'Routine expand target',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
            });

            // Wide viewport so the mobile breakpoint doesn't fall through to dialog.
            await page.setViewportSize({ width: 1400, height: 900 });
            await page.goto('/routines');
            await page.waitForSelector('text=Routine expand target');

            await page.evaluate(
                (args) => {
                    localStorage.setItem(args.key, 'expand');
                    window.dispatchEvent(new StorageEvent('storage', { key: args.key, newValue: 'expand' }));
                },
                { key: CLARIFY_MODE_KEY },
            );

            await page.getByTestId('routineRow').filter({ hasText: 'Routine expand target' }).click();

            // Editor renders inline — no dialog shell, but the title field is present.
            await expect(page.getByRole('dialog', { name: 'Edit routine' })).toHaveCount(0);
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Routine expand target');
            await expect(page.getByTestId('routineEditorSaveButton')).toBeVisible();
        });
    });
});

test.describe('Routine editor — copy ID button on rows', () => {
    test('each row exposes a copy-id button', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-copy-id-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Routine with copy id',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
            });

            await page.goto('/routines');
            await page.waitForSelector('text=Routine with copy id');

            // The row exposes the copyIdButton via testid; click + verify a Snackbar surfaces the ID.
            const targetRow = page.getByTestId('routineRow').filter({ hasText: 'Routine with copy id' });
            await targetRow.locator('..').getByTestId('routineRowCopyIdButton').click();
            await expect(page.getByText(`Copied: ${routine._id}`)).toBeVisible();
        });
    });
});

test.describe('Routine editor — page mode notes markdown', () => {
    test('notes default to preview when non-empty and switch to editor on click', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-notes-md-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Routine with notes',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: { notes: 'Hello **routine**' },
                active: true,
            });

            await page.goto(`/routine/${routine._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

            // Markdown preview renders the bold word from the template's notes field.
            const preview = page.getByTestId('pageNotesPreview');
            await expect(preview).toBeVisible();
            await expect(preview.locator('strong')).toHaveText('routine');

            await page.getByRole('button', { name: 'Edit notes' }).click();
            const notesEditor = page.getByPlaceholder('Supports **bold**, _italic_, `code`, lists, etc.');
            await expect(notesEditor).toBeVisible();
            await expect(notesEditor).toHaveValue('Hello **routine**');
        });
    });
});
