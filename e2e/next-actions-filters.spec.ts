import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// /next-actions filter chips persist in URL search params (context / person / energy / time),
// people get their own chip row, chip rows are alphabetical, and rows flag focus + under-clarified state.

async function rowTitles(page: Page): Promise<string[]> {
    const visibleTitles = await page.getByTestId('nextActionItemRow').allInnerTexts();
    return visibleTitles.map((t) => t.split('\n')[0]?.trim() ?? '');
}

// Seeds two contexts, two people and two fully-tagged items; returns the ids the assertions need.
async function seedFilterFixtures(page: Page) {
    const phone = await gtd.createWorkContext(page, 'Phone');
    const errands = await gtd.createWorkContext(page, 'Errands');
    const bob = await gtd.createPerson(page, { name: 'Bob' });
    const alice = await gtd.createPerson(page, { name: 'Alice' });
    await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Call landlord'), {
        workContextIds: [phone._id],
        peopleIds: [alice._id],
        energy: 'low',
        time: 5,
    });
    await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Buy stamps'), {
        workContextIds: [errands._id],
        peopleIds: [bob._id],
        energy: 'high',
        time: 60,
    });
    return { phone, alice };
}

test.describe('Next actions — URL-backed filter chips', () => {
    test('chip clicks write the URL, filter the list, and clear on second click', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-filters-${dayjs().valueOf()}@example.com`, async (page) => {
            const { phone, alice } = await seedFilterFixtures(page);

            await page.goto('/next-actions');
            await page.waitForSelector('text=Call landlord');

            // Chip rows are alphabetical by name (case-insensitive), not insertion order.
            await expect(page.getByTestId('nextActionsContextFilterChip')).toHaveText(['Errands', 'Phone']);
            await expect(page.getByTestId('nextActionsPersonFilterChip')).toHaveText(['Alice', 'Bob']);

            // Work-context chip → ?context=<id> and the list narrows.
            await page.getByTestId('nextActionsContextFilterChip').filter({ hasText: 'Phone' }).click();
            await expect(page).toHaveURL(new RegExp(`context=${phone._id}`));
            expect(await rowTitles(page)).toEqual(['Call landlord']);

            // Person chip stacks on top → ?person=<id> as well.
            await page.getByTestId('nextActionsPersonFilterChip').filter({ hasText: 'Alice' }).click();
            await expect(page).toHaveURL(new RegExp(`person=${alice._id}`));
            expect(await rowTitles(page)).toEqual(['Call landlord']);

            // Clicking the active chips again clears each filter and drops its URL param.
            await page.getByTestId('nextActionsContextFilterChip').filter({ hasText: 'Phone' }).click();
            await expect(page).not.toHaveURL(/context=/);
            await page.getByTestId('nextActionsPersonFilterChip').filter({ hasText: 'Alice' }).click();
            await expect(page).not.toHaveURL(/person=/);
            expect((await rowTitles(page)).sort()).toEqual(['Buy stamps', 'Call landlord']);
        });
    });

    test('deep links restore filters; invalid params are stripped without crashing', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-deeplink-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedFilterFixtures(page);

            // energy + time arrive from the URL and immediately filter the list.
            await page.goto('/next-actions?energy=low&time=5');
            await page.waitForSelector('text=Call landlord');
            expect(await rowTitles(page)).toEqual(['Call landlord']);

            // Junk params are stripped by validateSearch — the page renders unfiltered instead of crashing.
            await page.goto('/next-actions?energy=bogus&time=7&context=&person=');
            await page.waitForSelector('text=Call landlord');
            expect((await rowTitles(page)).sort()).toEqual(['Buy stamps', 'Call landlord']);
        });
    });
});

test.describe('Next actions — row indicators', () => {
    test('focus bullseye and under-clarified warning respect the work-context nuance', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-indicators-${dayjs().valueOf()}@example.com`, async (page) => {
            // No work contexts exist yet — the missing-work-context criterion must not fire.
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Fully clarified'), { energy: 'low', time: 5 });
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Bare focused item'), { focus: true });

            await page.goto('/next-actions');
            await page.waitForSelector('text=Fully clarified');

            const clarifiedRow = page.getByTestId('nextActionItemRow').filter({ hasText: 'Fully clarified' });
            const bareRow = page.getByTestId('nextActionItemRow').filter({ hasText: 'Bare focused item' });

            await expect(bareRow.getByTestId('focusIndicator')).toBeVisible();
            await expect(bareRow.getByTestId('unclarifiedWarning')).toBeVisible(); // missing energy + time
            await expect(clarifiedRow.getByTestId('focusIndicator')).toHaveCount(0);
            await expect(clarifiedRow.getByTestId('unclarifiedWarning')).toHaveCount(0);

            // Once the user defines a work context, an item without one counts as under-clarified.
            await gtd.createWorkContext(page, 'Office');
            await page.goto('/next-actions');
            await page.waitForSelector('text=Fully clarified');
            await expect(clarifiedRow.getByTestId('unclarifiedWarning')).toBeVisible();
        });
    });
});
