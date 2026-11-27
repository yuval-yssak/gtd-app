import { expect, type Page, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// The review's inline editors never navigate, so the router's unsaved-changes guard cannot prompt:
// every action that would leave an edited card is locked instead, and Discard is the deliberate way
// not to save. Focus lands on the card's next action, never on <body>.

async function startReviewAt(page: Page, stage: string, title: string) {
    await page.goto(`/weekly-review?stage=${stage}`);
    await page.getByTestId('startReviewButton').click();
    await expect(page.getByTestId('reviewStageTitle')).toHaveText(title);
}

test.describe('weekly review — Discard unsaved edits', () => {
    test('clarify: a status pick locks ◀ ▶; Discard reverts it and hands focus to Save & next', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-discard-clarify-${uniqueStamp()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Loose thought');
            await gtd.flush(page); // never navigate mid-flush — see CLAUDE.md § E2E
            await startReviewAt(page, 'clarify', 'Clarify');
            const stage = page.getByTestId('clarifyStage');

            await stage.getByRole('button', { name: 'Next Action' }).click();
            await expect(page.getByTestId('stageNavForward')).toBeDisabled();
            await expect(page.getByTestId('stageNavBack')).toBeDisabled();

            await page.getByTestId('clarifyDiscard').click();

            await expect(stage.getByRole('button', { name: 'Inbox' })).toHaveAttribute('aria-pressed', 'true');
            await expect(page.getByTestId('stageNavForward')).toBeEnabled();
            await expect(page.getByTestId('clarifyDiscard')).toHaveCount(0);
            await expect(page.getByTestId('clarifySaveNext')).toBeFocused();
            expect((await gtd.getItem(page, inbox._id))?.status).toBe('inbox');
        });
    });

    test('revisit: an edit of a decided item offers Discard, which reverts it and hands focus to ▶', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-discard-revisit-${uniqueStamp()}@example.com`, async (page) => {
            const action = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Call the plumber'), { energy: 'low', time: 15 });
            await gtd.flush(page);
            await startReviewAt(page, 'nextActions', 'Next Actions');
            await page.getByTestId('focusKeep').click();
            await page.getByTestId('stageNavBack').click();
            const revisit = page.getByTestId('revisitDecisionCard');
            await expect(revisit).toBeVisible();

            await revisit.getByRole('button', { name: 'Someday / Maybe' }).click();
            await expect(page.getByTestId('stageNavForward')).toBeDisabled();

            await page.getByTestId('revisitDiscard').click();

            await expect(revisit.getByRole('button', { name: 'Next Action' })).toHaveAttribute('aria-pressed', 'true');
            await expect(page.getByTestId('revisitSave')).toBeDisabled();
            await expect(page.getByTestId('stageNavForward')).toBeFocused();
            expect((await gtd.getItem(page, action._id))?.status).toBe('nextAction');
        });
    });
});
