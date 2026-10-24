import { expect, type Locator, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// The Weekly Review card pairs the next-action fields' narrow controls into two columns so the
// whole item fits without scrolling (the dense layout); the item page keeps one column. Geometry,
// not attributes: removing the dense grid rule must fail this spec.

async function topOf(locator: Locator) {
    const box = await locator.boundingBox();
    if (!box) throw new Error('expected a laid-out element');
    return box.y;
}

test.describe('Weekly review — dense next-action fields', () => {
    // No contexts or people are seeded, so the grid's first row pairs the tickler block with Energy.
    test('the tickler and energy share a row in the review card, and stack on the item page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-dense-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Plan the offsite'), { energy: 'low', time: 30 });
            await gtd.flush(page);

            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');
            const energy = page.getByRole('group', { name: 'Energy' });
            const tickler = page.getByText('Tickler — hide until');
            await expect(energy).toBeVisible();
            expect(Math.abs((await topOf(energy)) - (await topOf(tickler)))).toBeLessThan(4);

            await page.goto(`/item/${item._id}`);
            await expect(page.getByRole('group', { name: 'Energy' })).toBeVisible();
            expect((await topOf(page.getByRole('group', { name: 'Energy' }))) - (await topOf(page.getByText('Tickler — hide until')))).toBeGreaterThan(40);
        });
    });
});
