import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Every review tab rewrites the whole device-local draft from its own memory, so two live tabs
// erase each other's progress. One tab owns the review (a per-account Web Lock); the others show
// "Continue here", which takes it over and reloads the saved state.

async function seedTwoNextActions(page: Page) {
    // Distinct expectedBy dates pin the walk order (undated items tie under the page comparator).
    const first = await gtd.collect(page, 'First action');
    await gtd.clarifyToNextAction(page, first, { expectedBy: dayjs().add(7, 'day').format('YYYY-MM-DD') });
    const second = await gtd.collect(page, 'Second action');
    await gtd.clarifyToNextAction(page, second, { expectedBy: dayjs().add(8, 'day').format('YYYY-MM-DD') });
    await gtd.flush(page); // never navigate mid-flush — see CLAUDE.md § E2E
}

const reviewTitleField = (page: Page) => page.getByTestId('focusStage').getByRole('textbox', { name: 'Title' });

test.describe('weekly review — one tab at a time', () => {
    test('a second tab is told the review is open elsewhere; "Continue here" moves it, progress included, both ways', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-one-tab-${uniqueStamp()}@example.com`, async (firstTab) => {
            await seedTwoNextActions(firstTab);
            await firstTab.goto('/weekly-review?stage=nextActions');
            await firstTab.getByTestId('startReviewButton').click();
            await expect(reviewTitleField(firstTab)).toHaveValue('First action');

            const secondTab = await firstTab.context().newPage();
            await secondTab.goto('/weekly-review?stage=nextActions');
            await expect(secondTab.getByTestId('reviewOpenElsewhere')).toBeVisible();
            await expect(secondTab.getByTestId('focusStage')).toHaveCount(0);

            // Take over: the second tab lands in the saved review; the first steps aside.
            await secondTab.getByTestId('continueReviewHereButton').click();
            await expect(reviewTitleField(secondTab)).toHaveValue('First action');
            await expect(firstTab.getByTestId('reviewOpenElsewhere')).toBeVisible();
            await expect(firstTab.getByTestId('focusStage')).toHaveCount(0);

            // Progress made here must be what the first tab picks up — not its stale in-memory walk.
            await secondTab.getByTestId('focusKeep').click();
            await expect(reviewTitleField(secondTab)).toHaveValue('Second action');
            await firstTab.getByTestId('continueReviewHereButton').click();
            await expect(reviewTitleField(firstTab)).toHaveValue('Second action');
            await expect(firstTab.getByTestId('reviewStageCounter')).toContainText('2 of 2');
            await expect(secondTab.getByTestId('reviewOpenElsewhere')).toBeVisible();
            await secondTab.close();
        });
    });

    // The taking tab's own ?stage is stale (the other tab moved on); the takeover must land on the
    // saved stage and rewrite the URL, or the URL → flow sync would drag the review back.
    test('taking the review back lands on the stage the other tab reached, URL included', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-one-tab-stage-${uniqueStamp()}@example.com`, async (firstTab) => {
            await seedTwoNextActions(firstTab);
            await firstTab.goto('/weekly-review?stage=nextActions');
            await firstTab.getByTestId('startReviewButton').click();
            await expect(firstTab.getByTestId('reviewStageTitle')).toHaveText('Next Actions');

            const secondTab = await firstTab.context().newPage();
            await secondTab.goto('/weekly-review');
            await secondTab.getByTestId('continueReviewHereButton').click();
            await expect(secondTab.getByTestId('reviewStageTitle')).toHaveText('Next Actions');
            await secondTab.getByTestId('stageTravelNext').click();
            await expect(secondTab.getByTestId('reviewStageTitle')).not.toHaveText('Next Actions');
            const reachedTitle = await secondTab.getByTestId('reviewStageTitle').textContent();
            const reachedStage = new URL(secondTab.url()).searchParams.get('stage');
            if (!reachedTitle || !reachedStage) {
                throw new Error('expected the second tab on a later stage');
            }

            await firstTab.getByTestId('continueReviewHereButton').click();
            await expect(firstTab.getByTestId('reviewStageTitle')).toHaveText(reachedTitle);
            await expect(firstTab).toHaveURL(new RegExp(`stage=${reachedStage}`));
            // And it stays there — no bounce back to the stale stage once the URL settles.
            await expect(firstTab.getByTestId('reviewStageTitle')).toHaveText(reachedTitle);
            await secondTab.close();
        });
    });

    test('closing the tab that runs the review hands it to a waiting tab', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-one-tab-close-${uniqueStamp()}@example.com`, async (firstTab) => {
            await seedTwoNextActions(firstTab);
            const holder = await firstTab.context().newPage();
            await holder.goto('/weekly-review?stage=nextActions');
            await holder.getByTestId('startReviewButton').click();
            await expect(reviewTitleField(holder)).toHaveValue('First action');

            await firstTab.goto('/weekly-review');
            await expect(firstTab.getByTestId('reviewOpenElsewhere')).toBeVisible();

            await holder.close();
            // The waiting tab owns it now and offers the saved review.
            await expect(firstTab.getByTestId('resumeReviewButton')).toBeVisible();
        });
    });
});
