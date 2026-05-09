import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

const CLARIFY_MODE_KEY = 'gtd:inlineClarifyMode';

// Verifies that the editor-mode setting is honored on every list page (not just inbox). The
// settings page used to claim "applies to all other pages" but only inbox actually honoured
// expand/popover. After the editor unification, every list page reads the same setting and
// renders the matching variant.

test.describe('Item editor modes — non-inbox pages', () => {
    test('next-actions: expand mode renders inline body, not dialog', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `modes-expand-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Expand mode target');
            await gtd.clarifyToNextAction(page, inbox, { energy: 'low' });

            await page.goto('/next-actions');
            await page.waitForSelector('text=Expand mode target');

            // Set mode to 'expand' AFTER mount so the storage event handler propagates the change.
            await page.evaluate(
                (args) => {
                    localStorage.setItem(args.key, 'expand');
                    window.dispatchEvent(new StorageEvent('storage', { key: args.key, newValue: 'expand' }));
                },
                { key: CLARIFY_MODE_KEY },
            );

            await page.getByTestId('nextActionItemRow').filter({ hasText: 'Expand mode target' }).click();
            // No dialog should appear — the editor renders inline.
            await expect(page.getByRole('dialog', { name: 'Edit item' })).toBeHidden();
            // The body's title field should be visible inline.
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();
            // The status chips should also render inline (Save changes button proves it's the editor body).
            await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
        });
    });

    test('next-actions: page mode navigates to /item/:id', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `modes-page-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Page mode target');
            await gtd.clarifyToNextAction(page, inbox, { energy: 'low' });

            await page.goto('/next-actions');
            await page.waitForSelector('text=Page mode target');

            await page.evaluate(
                (args) => {
                    localStorage.setItem(args.key, 'page');
                    window.dispatchEvent(new StorageEvent('storage', { key: args.key, newValue: 'page' }));
                },
                { key: CLARIFY_MODE_KEY },
            );

            await page.getByTestId('nextActionItemRow').filter({ hasText: 'Page mode target' }).click();
            await expect(page).toHaveURL(new RegExp(`/item/${inbox._id}`));
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();
        });
    });

    test('waiting-for: dialog mode (default) opens the unified editor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `modes-dialog-wf-${dayjs().valueOf()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Alex' });
            const inbox = await gtd.collect(page, 'WF dialog target');
            await gtd.clarifyToWaitingFor(page, inbox, { waitingForPersonId: person._id });

            await page.goto('/waiting-for');
            await page.waitForSelector('text=WF dialog target');

            await page.getByTestId('waitingForItemRow').filter({ hasText: 'WF dialog target' }).click();
            await expect(page.getByRole('dialog', { name: 'Edit item' })).toBeVisible();
        });
    });
});
