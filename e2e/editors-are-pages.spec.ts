import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// The item and routine editors are always pages: there is no "Item editor" setting any more, and
// no dialog / popover / inline / instant variant. Every list gesture that edits lands on
// /item/:id (or /routine/new, /routine/:id); a mode value left in storage by an older build is
// ignored.

const LEGACY_MODE_KEY = 'gtd:inlineClarifyMode';

async function expectItemPage(page: Page, itemId: string) {
    await expect(page).toHaveURL(new RegExp(`/item/${itemId}`));
    await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
}

test.describe('Editors are pages', () => {
    test('a row click on every list page opens the item page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pages-rows-${uniqueStamp()}@example.com`, async (page) => {
            const tomorrow = dayjs().add(1, 'day');
            const inbox = await gtd.collect(page, 'Row inbox');
            const nextAction = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Row next action'));
            const calendar = await gtd.clarifyToCalendar(page, await gtd.collect(page, 'Row calendar'), {
                timeStart: tomorrow.hour(9).minute(0).second(0).millisecond(0).toISOString(),
                timeEnd: tomorrow.hour(9).minute(30).second(0).millisecond(0).toISOString(),
            });
            const waitingFor = await gtd.clarifyToWaitingFor(page, await gtd.collect(page, 'Row waiting for'), {
                expectedBy: tomorrow.format('YYYY-MM-DD'),
            });
            const tickler = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Row tickler'), {
                ignoreBefore: dayjs().add(7, 'day').format('YYYY-MM-DD'),
            });
            const someday = await gtd.clarifyToSomedayMaybe(page, await gtd.collect(page, 'Row someday'));
            await gtd.flush(page);

            const cases = [
                { path: '/inbox', rowTestId: 'inboxItemRow', item: inbox },
                { path: '/next-actions', rowTestId: 'nextActionItemRow', item: nextAction },
                { path: '/calendar', rowTestId: 'calendarItemRow', item: calendar },
                { path: '/waiting-for', rowTestId: 'waitingForItemRow', item: waitingFor },
                { path: '/tickler', rowTestId: 'ticklerItemRow', item: tickler },
                { path: '/someday', rowTestId: 'somedayItemRow', item: someday },
            ];
            for (const { path, rowTestId, item } of cases) {
                await page.goto(path);
                await page.getByTestId(rowTestId).filter({ hasText: item.title }).click();
                await expectItemPage(page, item._id);
            }
        });
    });

    test('an inbox status chip opens the item page preset to that status — never an instant move', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pages-chips-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Chip target');
            await gtd.flush(page);
            // A value an older build saved ('instant' used to move the item with no editor at all).
            await page.evaluate((key) => localStorage.setItem(key, 'instant'), LEGACY_MODE_KEY);

            await page.goto('/inbox');
            const row = page.locator(`[data-list-item-id="${item._id}"]`);
            await row.getByRole('button', { name: 'Next Action' }).click();
            await expectItemPage(page, item._id);
            await expect(page).toHaveURL(/status=nextAction/);
            await expect(page.getByTestId('itemPageWrapper').getByRole('button', { name: 'Next Action', exact: true })).toHaveAttribute('aria-pressed', 'true');
            // Nothing moved: the chip only pre-selects the status in the editor.
            expect((await gtd.listItems(page)).find((i) => i._id === item._id)?.status).toBe('inbox');

            await page.goto('/inbox');
            await row.getByRole('button', { name: 'Calendar' }).click();
            await expectItemPage(page, item._id);
            await expect(page).toHaveURL(/status=calendar/);
        });
    });

    test('Settings no longer offers an Item editor choice', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pages-settings-${uniqueStamp()}@example.com`, async (page) => {
            await page.goto('/settings');
            await expect(page.getByText('Routine indicator')).toBeVisible();
            await expect(page.getByText('Item editor')).toHaveCount(0);
            await expect(page.getByText('Expand inline')).toHaveCount(0);
        });
    });

    test('"Create routine" opens /routine/new; creating lands on the new routine and Back returns to the list', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pages-new-routine-${uniqueStamp()}@example.com`, async (page) => {
            await page.goto('/routines');
            await page.getByTestId('newRoutineButton').click();
            await expect(page).toHaveURL(/\/routine\/new$/);
            await expect(page).toHaveTitle(/^New routine/);
            const editor = page.getByTestId('newRoutinePage');
            await editor.getByRole('textbox', { name: 'Title' }).fill('Water the plants');
            await editor.getByTestId('routineEditorSaveButton').click();

            await expect.poll(async () => (await gtd.listRoutines(page)).find((r) => r.title === 'Water the plants')?._id).toBeTruthy();
            const created = (await gtd.listRoutines(page)).find((r) => r.title === 'Water the plants');
            if (!created) throw new Error('expected the created routine');
            await expect(page).toHaveURL(new RegExp(`/routine/${created._id}$`));
            await expect(page.getByTestId('routinePageWrapper')).toBeVisible();

            // The create page was replaced in history, so Back skips it.
            await page.goBack();
            await expect(page).toHaveURL(/\/routines/);
        });
    });

    test('Cancel on /routine/new returns to the list without creating anything', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `pages-new-routine-cancel-${uniqueStamp()}@example.com`, async (page) => {
            await page.goto('/routines');
            await page.getByTestId('newRoutineButton').click();
            await expect(page).toHaveURL(/\/routine\/new$/);
            await page.getByTestId('newRoutinePage').getByRole('button', { name: 'Cancel' }).click();
            await expect(page).toHaveURL(/\/routines/);
            expect(await gtd.listRoutines(page)).toHaveLength(0);
        });
    });
});
