import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

const CLIENT_URL = 'http://localhost:4173';

// Focus is set imperatively (useAutoFocus) in a useEffect once the route mounts past the
// Suspense boundary for `useAppData()`. On a cold IDB/bootstrap that can take several seconds
// under load, so these assertions use a generous timeout rather than the default 5s.
const AUTOFOCUS_TIMEOUT = 20_000;

test.describe('list page input autofocus', () => {
    test('inbox capture field is focused on arrival', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `autofocus-inbox-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            await expect(page.getByPlaceholder("What's on your mind?")).toBeFocused({ timeout: AUTOFOCUS_TIMEOUT });
        });
    });

    test('search field is focused on arrival', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `autofocus-search-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto(`${CLIENT_URL}/search`);
            await expect(page.getByPlaceholder('Search title and notes…')).toBeFocused({ timeout: AUTOFOCUS_TIMEOUT });
        });
    });

    test('routines search field is focused on arrival once routines exist', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `autofocus-routines-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createRoutine(page, { title: 'Water plants', routineType: 'nextAction', rrule: 'FREQ=DAILY;INTERVAL=1', template: {}, active: true });
            await gtd.flush(page);

            await page.goto(`${CLIENT_URL}/routines`);
            await expect(page.getByTestId('routinesSearchInput')).toBeFocused({ timeout: AUTOFOCUS_TIMEOUT });
        });
    });
});

test.describe('waiting-for sorting', () => {
    test('groups sort alphabetically by person and can switch to date sort', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `waiting-for-sort-${dayjs().valueOf()}@example.com`, async (page) => {
            const zoe = await gtd.createPerson(page, { name: 'Zoe' });
            const alice = await gtd.createPerson(page, { name: 'Alice' });

            const zoeInbox = await gtd.collect(page, 'Ask Zoe for the report');
            await gtd.clarifyToWaitingFor(page, zoeInbox, { waitingForPersonId: zoe._id, expectedBy: '2026-07-01' });

            const aliceInbox = await gtd.collect(page, 'Ask Alice for the invoice');
            await gtd.clarifyToWaitingFor(page, aliceInbox, { waitingForPersonId: alice._id, expectedBy: '2026-07-10' });

            const unassignedInbox = await gtd.collect(page, 'Await building permit');
            await gtd.clarifyToWaitingFor(page, unassignedInbox, { expectedBy: '2026-07-20' });

            await gtd.flush(page);

            await page.goto(`${CLIENT_URL}/waiting-for`);

            const groupHeaders = page.locator('.MuiTypography-subtitle2');
            await expect(groupHeaders).toHaveText(['Alice', 'Zoe', 'Unassigned']);

            // Person chips only render in the by-date view — grouping already names the person here.
            await expect(page.getByTestId('waitingForPersonChip')).toHaveCount(0);

            await page.getByTestId('waitingForSortByDate').click();
            await expect(page).toHaveURL(/sortBy=date/);

            const rows = page.getByTestId('waitingForItemRow');
            await expect(rows).toHaveText([/Ask Zoe for the report/, /Ask Alice for the invoice/, /Await building permit/]);

            // The flat date view surfaces the awaited person as a chip; unassigned rows get none.
            await expect(page.getByTestId('waitingForPersonChip')).toHaveText(['Zoe', 'Alice']);

            await page.getByTestId('waitingForSortByPerson').click();
            await expect(page).not.toHaveURL(/sortBy=/);
            await expect(groupHeaders).toHaveText(['Alice', 'Zoe', 'Unassigned']);
        });
    });
});
