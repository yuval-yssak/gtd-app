import { expect, type Locator, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { compareByRank } from '../client/src/lib/compareNextActions';
import type { StoredItem } from '../client/src/types/MyDB';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// The Weekly Review card carries the editor's Position row (compact, one line), and the stage walk
// follows the list's manual order live: pushing the card on screen down hands the walk to the next
// item and re-offers the pushed one at its new place; pulling it up keeps it on screen. The row is
// held while structural edits are unsaved (a card swap would drop them), and the tickler stage,
// which walks by wake-up date, has no row.

const titleField = (page: Page) => page.getByTestId('focusStage').getByRole('textbox', { name: 'Title' });
const positionRow = (page: Page) => page.getByTestId('nextActionPositionRow');
/** The full-width wrapper that owns the stage's scroll — its overflow proves whether the card fits. */
const scrollerOf = (stage: Locator) => stage.getByTestId('stageCardScroller');

async function storedOrder(page: Page, status: StoredItem['status']): Promise<string[]> {
    return (await gtd.listItems(page))
        .filter((item) => item.status === status)
        .sort(compareByRank)
        .map((item) => item.title);
}

async function seedNextActions(page: Page, titles: readonly string[]) {
    for (const title of titles) {
        await gtd.clarifyToNextAction(page, await gtd.collect(page, title), {});
    }
    await gtd.flush(page); // never navigate mid-flush
}

async function startNextActionsStage(page: Page) {
    await page.goto('/weekly-review?stage=nextActions');
    await page.getByTestId('startReviewButton').click();
    await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');
}

test.describe('Weekly review — priority from the card', () => {
    test('Bottom on the card on screen moves the walk on and re-offers the item last; the compact row keeps the full card on screen', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-pos-down-${uniqueStamp()}@example.com`, async (page) => {
            // The card-fits budget: at the reported 1920x929 the whole item — Position row included —
            // must be visible at once. Charlie (the first card) carries the metadata-heavy shape.
            await page.setViewportSize({ width: 1920, height: 929 });
            const context = await gtd.createWorkContext(page, 'anywhere');
            await seedNextActions(page, ['Alpha', 'Bravo']);
            const charlie = await gtd.collect(page, 'Charlie');
            await gtd.clarifyToNextAction(
                page,
                { ...charlie, notes: ['- Benjamin', '- Nir', '- Primos', '- Yonatan'].join('\n') },
                { workContextIds: [context._id], energy: 'low', time: 15 },
            );
            await gtd.flush(page);

            await startNextActionsStage(page); // newest first: Charlie, Bravo, Alpha
            await expect(titleField(page)).toHaveValue('Charlie');
            await expect(page.getByTestId('reviewStageCounter')).toHaveText('1 of 3');
            await expect(positionRow(page)).toBeVisible();
            await expect(page.getByTestId('nextActionPositionText')).toHaveText('1 of 3');
            expect(await scrollerOf(page.getByTestId('focusStage')).evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);

            await page.getByTestId('nextActionPositionBottom').click();
            // The walk hands over to the next item; nothing was decided or skipped, so the counter holds.
            await expect(titleField(page)).toHaveValue('Bravo');
            await expect(page.getByTestId('reviewStageCounter')).toHaveText('1 of 3');
            await expect.poll(() => storedOrder(page, 'nextAction')).toEqual(['Bravo', 'Alpha', 'Charlie']);

            await page.getByTestId('focusKeep').click();
            await expect(titleField(page)).toHaveValue('Alpha');
            await page.getByTestId('focusKeep').click();
            await expect(titleField(page)).toHaveValue('Charlie');
            await expect(page.getByTestId('reviewStageCounter')).toHaveText('3 of 3');
        });
    });

    test('Top on the card on screen keeps it on screen; a ▶-skipped item above it stays behind the cursor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-pos-up-${uniqueStamp()}@example.com`, async (page) => {
            await seedNextActions(page, ['Alpha', 'Bravo', 'Charlie']);
            await startNextActionsStage(page);
            await expect(titleField(page)).toHaveValue('Charlie');
            await page.getByTestId('stageNavForward').click(); // skip past Charlie
            await expect(titleField(page)).toHaveValue('Bravo');
            await expect(page.getByTestId('reviewStageCounter')).toHaveText('2 of 3');

            await page.getByTestId('nextActionPositionTop').click();
            await expect.poll(() => storedOrder(page, 'nextAction')).toEqual(['Bravo', 'Charlie', 'Alpha']);
            await expect(titleField(page)).toHaveValue('Bravo');
            await expect(page.getByTestId('reviewStageCounter')).toHaveText('2 of 3');
            await expect(page.getByTestId('nextActionPositionText')).toHaveText('1 of 3');

            // Charlie now ranks below Bravo but was already walked past: the walk goes on to Alpha.
            await page.getByTestId('focusKeep').click();
            await expect(titleField(page)).toHaveValue('Alpha');
            await expect(page.getByTestId('reviewStageCounter')).toHaveText('3 of 3');
        });
    });

    test('unsaved structural edits hold the row; Save & next commits them and frees it on the next card', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-pos-lock-${uniqueStamp()}@example.com`, async (page) => {
            await seedNextActions(page, ['Alpha', 'Bravo']);
            await startNextActionsStage(page);
            await expect(titleField(page)).toHaveValue('Bravo');
            await expect(page.getByTestId('nextActionPositionBottom')).toBeEnabled();

            await page.getByRole('group', { name: 'Energy' }).getByRole('button', { name: 'High' }).click();
            await expect(positionRow(page)).toHaveAttribute('data-locked', 'true');
            await expect(page.getByTestId('nextActionPositionBottom')).toBeDisabled();
            // The Alt+Shift+↓ shortcut targets an enabled button only — the lock holds for the keyboard
            // too (focus outside a text field; Escape would step past the card instead).
            await page.getByTestId('focusKeep').focus();
            await page.keyboard.press('Alt+Shift+ArrowDown');
            await expect(titleField(page)).toHaveValue('Bravo');

            await expect(page.getByTestId('focusKeep')).toHaveText('Save & next');
            await page.getByTestId('focusKeep').click();
            await expect(titleField(page)).toHaveValue('Alpha');
            await expect(positionRow(page)).not.toHaveAttribute('data-locked', 'true');
            await expect.poll(async () => (await gtd.listItems(page)).find((item) => item.title === 'Bravo')?.energy).toBe('high');
        });
    });

    test('Up on a card that a mid-review capture already outranks keeps the card on screen; Down hands over to the capture', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-pos-capture-${uniqueStamp()}@example.com`, async (page) => {
            await gtd.collect(page, 'First thought');
            await gtd.collect(page, 'Second thought');
            await gtd.flush(page);

            await page.goto('/weekly-review?stage=clarify');
            await page.getByTestId('startReviewButton').click();
            const clarifyTitle = page.getByTestId('clarifyStage').getByRole('textbox', { name: 'Title' });
            await expect(clarifyTitle).toHaveValue('Second thought');

            // A capture made while the stage is open is minted at the top of the inbox — above the card.
            await page.getByTestId('quickCaptureFab').click();
            await page.getByTestId('quickCaptureInput').fill('Fresh arrival');
            await page.getByTestId('quickCaptureInput').press('Enter');
            await page.getByTestId('quickCaptureClose').click();
            await expect(page.getByTestId('reviewStageCounter')).toContainText('1 of 3');
            await expect(clarifyTitle).toHaveValue('Second thought');

            await page.getByTestId('nextActionPositionUp').click();
            await expect.poll(() => storedOrder(page, 'inbox')).toEqual(['Second thought', 'Fresh arrival', 'First thought']);
            await expect(clarifyTitle).toHaveValue('Second thought'); // raised, and still the card on screen

            await page.getByTestId('nextActionPositionDown').click();
            await expect.poll(() => storedOrder(page, 'inbox')).toEqual(['Fresh arrival', 'Second thought', 'First thought']);
            await expect(clarifyTitle).toHaveValue('Fresh arrival'); // pushed down: the walk follows the list
            await expect(page.getByTestId('reviewStageCounter')).toContainText('1 of 3');
        });
    });

    test('Clarify and Someday / Maybe rank their lists; a one-item section shows no row; the tickler stage never does', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-pos-stages-${uniqueStamp()}@example.com`, async (page) => {
            await gtd.collect(page, 'Older thought');
            await gtd.collect(page, 'Newer thought');
            await gtd.clarifyToSomedayMaybe(page, await gtd.collect(page, 'Only dream'), {});
            await gtd.clarifyToSomedayMaybe(page, await gtd.collect(page, 'Second dream'), {});
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Lone action'), {});
            const snoozed = await gtd.collect(page, 'Snoozed action');
            await gtd.clarifyToNextAction(page, snoozed, { ignoreBefore: dayjs().add(4, 'day').format('YYYY-MM-DD') });
            await gtd.flush(page);

            await page.goto('/weekly-review?stage=clarify');
            await page.getByTestId('startReviewButton').click();
            const clarifyTitle = page.getByTestId('clarifyStage').getByRole('textbox', { name: 'Title' });
            await expect(clarifyTitle).toHaveValue('Newer thought');
            await page.getByTestId('nextActionPositionBottom').click();
            await expect(clarifyTitle).toHaveValue('Older thought');
            await expect.poll(() => storedOrder(page, 'inbox')).toEqual(['Older thought', 'Newer thought']);

            await gtd.flush(page); // the reorder queued an op — never navigate mid-flush
            // A review is in progress: the landing offers to resume it; the URL's stage still wins.
            await page.goto('/weekly-review?stage=somedayMaybe');
            await page.getByTestId('resumeReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Someday / Maybe');
            await expect(titleField(page)).toHaveValue('Second dream');
            await page.getByTestId('nextActionPositionDown').click();
            await expect(titleField(page)).toHaveValue('Only dream');
            await expect.poll(() => storedOrder(page, 'somedayMaybe')).toEqual(['Only dream', 'Second dream']);

            await gtd.flush(page);
            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('resumeReviewButton').click();
            await expect(titleField(page)).toHaveValue('Lone action');
            await expect(positionRow(page)).toHaveCount(0); // alone in its section: nothing to reorder

            await page.goto('/weekly-review?stage=tickler');
            await page.getByTestId('resumeReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Tickler');
            await expect(titleField(page)).toHaveValue('Snoozed action');
            await expect(positionRow(page)).toHaveCount(0);
        });
    });
});
