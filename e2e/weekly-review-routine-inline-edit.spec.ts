import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// The Weekly Review edits a calendar routine INSIDE its card (the editor is never a dialog): the walk
// stays on the same entry, stage travel is locked while the editor is open, and an unsaved schedule
// edit is still protected by the unsaved-changes guard when the user navigates away.

async function openRoutineCardInReview(page: Page) {
    const routine = await gtd.createRoutine(page, {
        title: 'Morning gym',
        routineType: 'calendar',
        rrule: 'FREQ=DAILY',
        startDate: dayjs().format('YYYY-MM-DD'),
        calendarItemTemplate: { timeOfDay: '06:00', duration: 30 },
        template: {},
        active: true,
    });
    await gtd.generateCalendarItemsToHorizon(page, routine._id);
    await gtd.flush(page); // never navigate mid-flush — see CLAUDE.md § E2E

    await page.goto('/weekly-review');
    await page.getByTestId('startReviewButton').click();
    // Travel arrows are free jumps — go straight to the calendar stage.
    await page.getByTestId('stageTravelNext').click();
    await page.getByTestId('stageTravelNext').click();
    await expect(page.getByTestId('reviewStageTitle')).toHaveText('Calendar');
    const card = page.getByTestId('routineReviewCard');
    await expect(card.getByTestId('routineCardTitle')).toHaveText('Morning gym');
    return { routine, card };
}

test.describe('Weekly review — inline routine editing', () => {
    test('Save in the card updates the routine and returns to the same, still-undecided entry', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-routine-inline-save-${uniqueStamp()}@example.com`, async (page) => {
            const { routine, card } = await openRoutineCardInReview(page);
            await expect(page.getByTestId('reviewStageCounter')).toContainText('0 of 1');

            await page.getByTestId('routineCardEdit').click();
            const title = card.getByRole('textbox', { name: 'Title' });
            // Pressing Edit puts the user in the form.
            await expect(title).toBeFocused();
            // Travel and the decision buttons are locked while the editor is open.
            await expect(page.getByTestId('routineCardLooksGood')).toBeDisabled();

            await title.fill('Morning gym (early)');
            await card.getByTestId('routineEditorSaveButton').click();

            await expect(card.getByTestId('routineEditorSaveButton')).toHaveCount(0);
            await expect(card.getByTestId('routineCardTitle')).toHaveText('Morning gym (early)');
            // Saving is an edit, not a review decision: same entry, unlocked, focus back on Edit.
            await expect(page.getByTestId('reviewStageCounter')).toContainText('0 of 1');
            await expect(page.getByTestId('routineCardLooksGood')).toBeEnabled();
            await expect(page.getByTestId('routineCardEdit')).toBeFocused();
            expect((await gtd.listRoutines(page)).find((r) => r._id === routine._id)?.title).toBe('Morning gym (early)');
        });
    });

    test('an unsaved schedule edit in the card is guarded when the user navigates away', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-routine-inline-guard-${uniqueStamp()}@example.com`, async (page) => {
            const { card } = await openRoutineCardInReview(page);

            await page.getByTestId('routineCardEdit').click();
            await card.getByLabel('Duration (min)').fill('45');
            await page.getByRole('link', { name: 'Inbox' }).first().click();

            const guard = page.getByTestId('unsavedChangesDialog');
            await expect(guard).toBeVisible();
            await page.getByTestId('unsavedChangesStay').click();
            await expect(guard).toBeHidden();
            await expect(page).toHaveURL(/\/weekly-review/);
            await expect(card.getByLabel('Duration (min)')).toHaveValue('45');
        });
    });
});
