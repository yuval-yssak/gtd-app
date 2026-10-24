import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Verifies that clicking anywhere on a list row opens the item page (matching the
// calendar-page UX), and that clicking a button inside `secondaryAction` performs that
// action without bubbling up to the row's open-edit handler.

test.describe('List row click opens the item editor', () => {
    test('next-actions: row click opens editor; Mark done does not', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-row-click-${uniqueStamp()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'NA row-click target');
            await gtd.clarifyToNextAction(page, inbox, { energy: 'low', time: 5 });
            const inbox2 = await gtd.collect(page, 'NA secondary-action target');
            await gtd.clarifyToNextAction(page, inbox2, { energy: 'low', time: 5 });

            await page.goto('/next-actions');
            await page.waitForSelector('text=NA row-click target');

            await page.getByTestId('nextActionItemRow').filter({ hasText: 'NA row-click target' }).click();
            const editor = page.getByTestId('itemPageWrapper');
            await expect(editor).toBeVisible();
            await editor.getByRole('button', { name: 'Cancel' }).click();
            await expect(editor).toBeHidden();

            // Clicking "Mark done" inside secondaryAction must complete the item — not open the editor.
            const targetRow = page.getByTestId('nextActionItemRow').filter({ hasText: 'NA secondary-action target' });
            const doneButton = targetRow.locator('..').getByRole('button', { name: 'Mark done' });
            await doneButton.click();
            await expect(editor).toBeHidden();
            await expect(page.getByText('NA secondary-action target')).toBeHidden();
        });
    });

    test('waiting-for: row click opens editor; Received does not', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wf-row-click-${uniqueStamp()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Alex' });
            const inbox = await gtd.collect(page, 'WF row-click target');
            await gtd.clarifyToWaitingFor(page, inbox, { waitingForPersonId: person._id });
            const inbox2 = await gtd.collect(page, 'WF secondary-action target');
            await gtd.clarifyToWaitingFor(page, inbox2, { waitingForPersonId: person._id });

            await page.goto('/waiting-for');
            await page.waitForSelector('text=WF row-click target');

            await page.getByTestId('waitingForItemRow').filter({ hasText: 'WF row-click target' }).click();
            const editor = page.getByTestId('itemPageWrapper');
            await expect(editor).toBeVisible();
            await editor.getByRole('button', { name: 'Cancel' }).click();
            await expect(editor).toBeHidden();

            const targetRow = page.getByTestId('waitingForItemRow').filter({ hasText: 'WF secondary-action target' });
            const receivedButton = targetRow.locator('..').getByRole('button', { name: 'Received' });
            await receivedButton.click();
            await expect(editor).toBeHidden();
            await expect(page.getByText('WF secondary-action target')).toBeHidden();
        });
    });

    test('tickler: row click opens editor; Release now does not', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `tk-row-click-${uniqueStamp()}@example.com`, async (page) => {
            const future = dayjs().add(7, 'day').format('YYYY-MM-DD');
            const inbox = await gtd.collect(page, 'TK row-click target');
            await gtd.clarifyToNextAction(page, inbox, { ignoreBefore: future });
            const inbox2 = await gtd.collect(page, 'TK secondary-action target');
            await gtd.clarifyToNextAction(page, inbox2, { ignoreBefore: future });

            await page.goto('/tickler');
            await page.waitForSelector('text=TK row-click target');

            await page.getByTestId('ticklerItemRow').filter({ hasText: 'TK row-click target' }).click();
            const editor = page.getByTestId('itemPageWrapper');
            await expect(editor).toBeVisible();
            await editor.getByRole('button', { name: 'Cancel' }).click();
            await expect(editor).toBeHidden();

            const targetRow = page.getByTestId('ticklerItemRow').filter({ hasText: 'TK secondary-action target' });
            const releaseButton = targetRow.locator('..').getByRole('button', { name: 'Release now' });
            await releaseButton.click();
            await expect(editor).toBeHidden();
            // After release, the item leaves the tickler (its ignoreBefore is removed).
            await expect(page.getByText('TK secondary-action target')).toBeHidden();
        });
    });

    test('someday: row click opens editor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `sm-row-click-${uniqueStamp()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'SM row-click target');
            await gtd.clarifyToSomedayMaybe(page, inbox);

            await page.goto('/someday');
            await page.waitForSelector('text=SM row-click target');

            await page.getByTestId('somedayItemRow').filter({ hasText: 'SM row-click target' }).click();
            const editor = page.getByTestId('itemPageWrapper');
            await expect(editor).toBeVisible();
        });
    });

    // Inbox previously had no row-body click handler (only chip icons + bottom sheet on mobile).
    // After unifying editors, desktop row click now opens the same editor as everywhere else.
    test('inbox: desktop row click opens editor; chip icons do not bubble', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ix-row-click-${uniqueStamp()}@example.com`, async (page) => {
            await gtd.collect(page, 'IX row-click target');
            await gtd.collect(page, 'IX chip-action target');

            await page.goto('/inbox');
            await page.waitForSelector('text=IX row-click target');

            // Row body click — opens the item page.
            await page.getByTestId('inboxItemRow').filter({ hasText: 'IX row-click target' }).click();
            const editor = page.getByTestId('itemPageWrapper');
            await expect(editor).toBeVisible();
            await editor.getByRole('button', { name: 'Cancel' }).click();
            await expect(editor).toBeHidden();

            // Clicking the per-row Trash icon must NOT open the editor — it should trash directly.
            const targetRow = page.getByTestId('inboxItemRow').filter({ hasText: 'IX chip-action target' });
            const trashButton = targetRow.locator('..').getByRole('button', { name: 'Trash' });
            await trashButton.click();
            await expect(editor).toBeHidden();
            await expect(page.getByText('IX chip-action target')).toBeHidden();
        });
    });
});
