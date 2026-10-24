import { expect, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Verifies the item page (item.$itemId), however it is reached, exposes a header
// copy-to-clipboard button plus the readable ID in ItemEditorBody's bottom meta row — and that
// EXACTLY ONE copy affordance renders per screen (the body suppresses its meta-row copy via
// hasHostCopyIdButton; two identical buttons once shipped because distinct testids hid the
// duplicate).

test.describe('Copy item ID', () => {
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

    test('opened from a list row: the header copy button copies the item _id', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `copyid-row-${uniqueStamp()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Copy ID target');
            await gtd.clarifyToNextAction(page, inbox);

            await page.goto('/next-actions');
            await page.waitForSelector('text=Copy ID target');

            await page.getByTestId('nextActionItemRow').filter({ hasText: 'Copy ID target' }).click();
            const editor = page.getByTestId('itemPageWrapper');
            await expect(editor).toBeVisible();

            // The ID itself is readable, and only ONE copy button exists on the page —
            // by role+name, not testid, since distinct testids are what once hid a duplicate.
            await expect(editor.getByTestId('itemEditorId')).toContainText(inbox._id);
            await expect(editor.getByRole('button', { name: 'Copy item ID' })).toHaveCount(1);
            await editor.getByTestId('copyItemIdButton').click();
            const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
            expect(clipboardText).toBe(inbox._id);
        });
    });

    test('opened by deep link: the page header exposes the same single copy button', async ({ browser }) => {
        // The click→clipboard wiring is proven by the row test above; here we only assert that a
        // direct URL entry surfaces the same (single) button.
        await withOneLoggedInDevice(browser, `copyid-page-${uniqueStamp()}@example.com`, async (page) => {
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
        // the wizard/weekly-review hosts silently lose their only copy affordance.
        await withOneLoggedInDevice(browser, `copyid-wizard-${uniqueStamp()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Wizard copy-id target');

            await page.goto('/inbox');
            await page.waitForSelector('text=Wizard copy-id target');
            await page.getByTestId('processInboxButton').click();

            const wizard = page.getByTestId('processInboxPage');
            await expect(wizard.getByTestId('itemEditorId')).toContainText(inbox._id);
            await expect(wizard.getByRole('button', { name: 'Copy item ID' })).toHaveCount(1);
        });
    });
});
