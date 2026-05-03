import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Verifies that clicking anywhere on a list row opens the EditItemDialog (matching the
// calendar-page UX), and that clicking a button inside `secondaryAction` performs that
// action without bubbling up to the row's open-edit handler.

test.describe('List row click opens edit dialog', () => {
    test('next-actions: row click opens dialog; Mark done does not', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-row-click-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'NA row-click target');
            await gtd.clarifyToNextAction(page, inbox, { energy: 'low', time: 5 });
            const inbox2 = await gtd.collect(page, 'NA secondary-action target');
            await gtd.clarifyToNextAction(page, inbox2, { energy: 'low', time: 5 });

            await page.goto('/next-actions');
            await page.waitForSelector('text=NA row-click target');

            await page.getByTestId('nextActionItemRow').filter({ hasText: 'NA row-click target' }).click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await expect(dialog).toBeVisible();
            await dialog.getByRole('button', { name: 'Cancel' }).click();
            await expect(dialog).toBeHidden();

            // Clicking "Mark done" inside secondaryAction must complete the item — not open the dialog.
            const targetRow = page.getByTestId('nextActionItemRow').filter({ hasText: 'NA secondary-action target' });
            const doneButton = targetRow.locator('..').getByRole('button', { name: 'Mark done' });
            await doneButton.click();
            await expect(dialog).toBeHidden();
            await expect(page.getByText('NA secondary-action target')).toBeHidden();
        });
    });

    test('waiting-for: row click opens dialog; Received does not', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wf-row-click-${dayjs().valueOf()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Alex' });
            const inbox = await gtd.collect(page, 'WF row-click target');
            await gtd.clarifyToWaitingFor(page, inbox, { waitingForPersonId: person._id });
            const inbox2 = await gtd.collect(page, 'WF secondary-action target');
            await gtd.clarifyToWaitingFor(page, inbox2, { waitingForPersonId: person._id });

            await page.goto('/waiting-for');
            await page.waitForSelector('text=WF row-click target');

            await page.getByTestId('waitingForItemRow').filter({ hasText: 'WF row-click target' }).click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await expect(dialog).toBeVisible();
            await dialog.getByRole('button', { name: 'Cancel' }).click();
            await expect(dialog).toBeHidden();

            const targetRow = page.getByTestId('waitingForItemRow').filter({ hasText: 'WF secondary-action target' });
            const receivedButton = targetRow.locator('..').getByRole('button', { name: 'Received' });
            await receivedButton.click();
            await expect(dialog).toBeHidden();
            await expect(page.getByText('WF secondary-action target')).toBeHidden();
        });
    });

    test('tickler: row click opens dialog; Release now does not', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `tk-row-click-${dayjs().valueOf()}@example.com`, async (page) => {
            const future = dayjs().add(7, 'day').format('YYYY-MM-DD');
            const inbox = await gtd.collect(page, 'TK row-click target');
            await gtd.clarifyToNextAction(page, inbox, { ignoreBefore: future });
            const inbox2 = await gtd.collect(page, 'TK secondary-action target');
            await gtd.clarifyToNextAction(page, inbox2, { ignoreBefore: future });

            await page.goto('/tickler');
            await page.waitForSelector('text=TK row-click target');

            await page.getByTestId('ticklerItemRow').filter({ hasText: 'TK row-click target' }).click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await expect(dialog).toBeVisible();
            await dialog.getByRole('button', { name: 'Cancel' }).click();
            await expect(dialog).toBeHidden();

            const targetRow = page.getByTestId('ticklerItemRow').filter({ hasText: 'TK secondary-action target' });
            const releaseButton = targetRow.locator('..').getByRole('button', { name: 'Release now' });
            await releaseButton.click();
            await expect(dialog).toBeHidden();
            // After release, the item leaves the tickler (its ignoreBefore is removed).
            await expect(page.getByText('TK secondary-action target')).toBeHidden();
        });
    });

    test('someday: row click opens dialog', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `sm-row-click-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'SM row-click target');
            await gtd.clarifyToSomedayMaybe(page, inbox);

            await page.goto('/someday');
            await page.waitForSelector('text=SM row-click target');

            await page.getByTestId('somedayItemRow').filter({ hasText: 'SM row-click target' }).click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await expect(dialog).toBeVisible();
        });
    });
});
