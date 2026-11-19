import { expect, type Locator, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { openReviewDetailsForm } from './helpers/itemEditorLocators';
import { uniqueStamp } from './helpers/uniqueStamp';

// The next-action fields' narrow controls flow into a grid so the whole item fits without
// scrolling — in the Weekly Review card and on the item page alike (one layout for both). Geometry,
// not attributes: removing the grid rule must fail this spec.

async function topOf(locator: Locator) {
    const box = await locator.boundingBox();
    if (!box) throw new Error('expected a laid-out element');
    return box.y;
}

test.describe('Weekly review — dense next-action fields', () => {
    // No contexts or people are seeded, so the grid's first row holds both dates and Energy.
    test('the tickler and energy share a row in the review card and on the item page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-dense-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Plan the offsite'), { energy: 'low', time: 30 });
            await gtd.flush(page);

            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');
            // The dense grid is the review's detail FORM, behind the summary's pencil.
            await openReviewDetailsForm(page.getByTestId('focusStage'));
            const energy = page.getByRole('group', { name: 'Energy' });
            const tickler = page.getByText('Tickler — hide until');
            await expect(energy).toBeVisible();
            // Polled: the two reads are separate round-trips, and the notes editor swapping in for its
            // loading skeleton can shift the card between them.
            await expect.poll(async () => Math.abs((await topOf(energy)) - (await topOf(tickler)))).toBeLessThan(4);

            await page.goto(`/item/${item._id}`);
            await expect(page.getByRole('group', { name: 'Energy' })).toBeVisible();
            await expect
                .poll(async () => Math.abs((await topOf(page.getByRole('group', { name: 'Energy' }))) - (await topOf(page.getByText('Tickler — hide until')))))
                .toBeLessThan(4);
        });
    });
});
