import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Verifies both edit-item surfaces (Dialog editor and the item.$itemId page) expose a header
// copy-to-clipboard button plus the readable ID in ItemEditorBody's bottom meta row — and that
// EXACTLY ONE copy affordance renders per screen (the body suppresses its meta-row copy via
// hasHostCopyIdButton; two identical buttons once shipped because distinct testids hid the
// duplicate).

test.describe('Copy item ID', () => {
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

    test('dialog header: copy button copies item _id to clipboard', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `copyid-dialog-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Copy ID target');
            await gtd.clarifyToNextAction(page, inbox);

            await page.goto('/next-actions');
            await page.waitForSelector('text=Copy ID target');

            await page.getByTestId('nextActionItemRow').filter({ hasText: 'Copy ID target' }).click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await expect(dialog).toBeVisible();

            // The ID itself is readable, and only ONE copy button exists in the editor dialog —
            // by role+name, not testid, since distinct testids are what once hid a duplicate.
            // (Scoped to the dialog: the list rows behind it carry their own per-row buttons.)
            await expect(dialog.getByTestId('itemEditorId')).toContainText(inbox._id);
            await expect(dialog.getByRole('button', { name: 'Copy item ID' })).toHaveCount(1);
            await dialog.getByTestId('copyItemIdButton').click();
            const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
            expect(clipboardText).toBe(inbox._id);
        });
    });

    test('page mode: the page header exposes the copy button', async ({ browser }) => {
        // The CopyIdButton component itself is exercised in the dialog test above; here we
        // only assert that page mode surfaces the same (single) button — the dialog test
        // already proves the click→clipboard wiring works.
        await withOneLoggedInDevice(browser, `copyid-page-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Copy ID page-mode target');
            await gtd.clarifyToNextAction(page, inbox);

            await page.goto(`/item/${inbox._id}`);
            // The page renders the title as a TextField value, not a text node, so a
            // text= selector wouldn't match — wait for the editor's Title input by role.
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Copy ID page-mode target');
            await expect(page.getByTestId('copyItemIdButton')).toBeVisible();
            await expect(page.getByTestId('itemEditorId')).toContainText(inbox._id);
            await expect(page.getByRole('button', { name: 'Copy item ID' })).toHaveCount(1);
        });
    });

    test('wizard chrome: the body meta row still owns the copy button', async ({ browser }) => {
        // Counterpart to the two host-header tests above: hosts that pass no `hasHostCopyIdButton`
        // must keep ItemEditorBody's meta-row button. Pins the OTHER branch of the suppression
        // gate — without this, inverting the condition would leave the whole suite green while
        // the wizard/weekly-review/expand/popover hosts silently lose their only copy affordance.
        await withOneLoggedInDevice(browser, `copyid-wizard-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Wizard copy-id target');

            await page.goto('/inbox');
            await page.waitForSelector('text=Wizard copy-id target');
            await page.getByTestId('processInboxButton').click();

            const dialog = page.getByRole('dialog');
            await expect(dialog.getByTestId('itemEditorId')).toContainText(inbox._id);
            await expect(dialog.getByRole('button', { name: 'Copy item ID' })).toHaveCount(1);
        });
    });
});
