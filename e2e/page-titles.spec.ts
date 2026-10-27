import { expect, test } from '@playwright/test';
import { closeContextQuietly, withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// The browser tab title follows the page: "<page> · Done" on list pages, the entity's own title on
// item/person/routine pages, so a row of open tabs is tellable apart.

// Every page opens its outline with one h1 naming the page, for screen-reader heading navigation.
const PAGE_HEADINGS: Array<[path: string, heading: string]> = [
    ['/inbox', 'Inbox'],
    ['/next-actions', 'Next Actions'],
    ['/calendar', 'Calendar'],
    ['/waiting-for', 'Waiting For'],
    ['/tickler', 'Tickler'],
    ['/someday', 'Someday / Maybe'],
    ['/routines', 'Routines'],
    ['/people', 'People'],
    ['/work-contexts', 'Work Contexts'],
    ['/search', 'Search'],
    ['/done', 'Done'],
    ['/trash', 'Trash'],
    ['/settings', 'Settings'],
    ['/weekly-review', 'Weekly Review'],
    ['/process-inbox', 'Process Inbox'],
    ['/item/no-such-item-id', 'Edit item'],
    ['/person/no-such-person-id', 'Edit person'],
    ['/routine/no-such-routine-id', 'Edit routine'],
];

/** The heading may be followed by a count chip inside the same h1, so match it as a prefix. */
const startsWith = (heading: string) => new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`);

test.describe('page heading', () => {
    test('every page has exactly one h1, naming the page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-headings-${uniqueStamp()}@example.com`, async (page) => {
            for (const [path, heading] of PAGE_HEADINGS) {
                await page.goto(path);
                const h1 = page.getByRole('heading', { level: 1 });
                // Count first: with two h1s the text check would fail and hide the real cause.
                await expect(h1, path).toHaveCount(1);
                await expect(h1, path).toHaveText(startsWith(heading));
            }
        });
    });
});

test.describe('tab title', () => {
    test('follows the page through in-app navigation and deep links', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-titles-${uniqueStamp()}@example.com`, async (page) => {
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
        await withOneLoggedInDevice(browser, `page-titles-item-${uniqueStamp()}@example.com`, async (page) => {
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
        await withOneLoggedInDevice(browser, `page-titles-entity-${uniqueStamp()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Carmel' });
            const routine = await gtd.createRoutine(page, {
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
