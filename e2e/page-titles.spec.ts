import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { closeContextQuietly, withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// The browser tab title follows the page: "<page> · Done" on list pages, the entity's own title on
// item/person/routine pages, so a row of open tabs is tellable apart.

test.describe('tab title', () => {
    test('follows the page through in-app navigation and deep links', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-titles-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto('/inbox');
            await expect(page).toHaveTitle('Inbox · Done');

            // Client-side navigation (no reload) must rewrite the title too.
            await page.getByRole('link', { name: 'Next Actions' }).first().click();
            await expect(page).toHaveURL(/\/next-actions$/);
            await expect(page).toHaveTitle('Next Actions · Done');

            await page.goto('/settings');
            await expect(page).toHaveTitle('Settings · Done');
        });
    });

    test('an item page is titled after the item, and follows a rename typed into the open editor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-titles-item-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Renew passport');
            await gtd.flush(page);

            await page.goto(`/item/${item._id}`);
            await expect(page).toHaveTitle('Renew passport · Done');

            // No reload: the autosave refreshes `allItems`, and the title effect re-runs on the new title.
            await page.getByRole('textbox', { name: 'Title' }).fill('Renew passport (urgent)');
            await expect(page).toHaveTitle('Renew passport (urgent) · Done');
            // The autosave queued a sync op — never navigate mid-flush (wedges the IDB flush lock).
            await gtd.flush(page);

            await page.goto('/item/no-such-item-id');
            await expect(page).toHaveTitle('Edit item · Done');
        });
    });

    test('person and routine pages are titled after their entity', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-titles-entity-${dayjs().valueOf()}@example.com`, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            const person = await gtd.createPerson(page, { name: 'Carmel' });
            const routine = await gtd.createRoutine(page, {
                userId,
                title: 'Water the plants',
                routineType: 'nextAction',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                template: {},
                active: true,
            });
            await gtd.flush(page);

            await page.goto(`/person/${person._id}`);
            await expect(page).toHaveTitle('Carmel · Done');

            await page.goto(`/routine/${routine._id}`);
            await expect(page).toHaveTitle('Water the plants · Done');
        });
    });

    test('signed-out pages carry their own titles', async ({ browser }) => {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            await page.goto('/');
            await expect(page.getByRole('heading', { level: 1, name: 'Done', exact: true })).toBeVisible();
            await expect(page).toHaveTitle('Done');

            await page.goto('/login');
            await expect(page).toHaveTitle('Sign in · Done');

            await page.goto('/privacy');
            await expect(page).toHaveTitle('Privacy Policy · Done');
        } finally {
            await closeContextQuietly(ctx);
        }
    });
});
