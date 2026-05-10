import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

const CLARIFY_MODE_KEY = 'gtd:inlineClarifyMode';

// /calendar used to lack a row-level "mark done" affordance — only Edit + Copy-id were exposed.
// Page-mode save additionally jumped to the destination bucket (so a calendar item marked done
// stranded the user on /done). Both surfaces should now keep the user on /calendar.
test.describe('Calendar list — mark done', () => {
    test('row-level Mark done button completes the item without leaving /calendar', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-row-done-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Mark done from row');
            const calItem = await gtd.clarifyToCalendar(page, inbox, {
                timeStart: dayjs().add(1, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString(),
                timeEnd: dayjs().add(1, 'day').hour(9).minute(30).second(0).millisecond(0).toISOString(),
            });

            await page.goto('/calendar');
            await page.waitForSelector('text=Mark done from row');

            await page.getByTestId('calendarItemMarkDoneButton').first().click();

            // The row drops out of /calendar; the user stays on /calendar (no navigation away).
            await expect(page).toHaveURL(/\/calendar$/);
            await expect(page.getByText('Mark done from row')).toHaveCount(0);

            // The persisted status is `done`.
            const items = await gtd.listItems(page);
            const updated = items.find((i) => i._id === calItem._id);
            expect(updated?.status).toBe('done');
        });
    });

    test('page-mode save of calendar → done returns to /calendar (not /done)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-page-done-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Page-mode calendar done');
            const calItem = await gtd.clarifyToCalendar(page, inbox, {
                timeStart: dayjs().add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString(),
                timeEnd: dayjs().add(1, 'day').hour(10).minute(30).second(0).millisecond(0).toISOString(),
            });

            await page.goto('/calendar');
            await page.waitForSelector('text=Page-mode calendar done');

            // Flip to page mode so clicking a row navigates into /item/:id.
            await page.evaluate(
                (args) => {
                    localStorage.setItem(args.key, 'page');
                    window.dispatchEvent(new StorageEvent('storage', { key: args.key, newValue: 'page' }));
                },
                { key: CLARIFY_MODE_KEY },
            );

            await page.getByTestId('calendarItemRow').filter({ hasText: 'Page-mode calendar done' }).click();
            await expect(page).toHaveURL(new RegExp(`/item/${calItem._id}`));
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();

            await page.getByRole('button', { name: 'Done' }).click();
            await page.getByRole('button', { name: 'Save changes' }).click();

            // Source-bucket policy: a calendar item saved as done returns to /calendar.
            await expect(page).toHaveURL(/\/calendar$/);

            // Sanity: the persisted status is `done` even though we landed back on /calendar.
            const items = await gtd.listItems(page);
            const updated = items.find((i) => i._id === calItem._id);
            expect(updated?.status).toBe('done');
        });
    });
});
