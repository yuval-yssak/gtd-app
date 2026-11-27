import { expect, type Locator, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { formatDisplayDate } from '../client/src/lib/displayDate';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// The review card is mostly scanned, so it rests on a read-only summary of the item's details —
// only the fields that have a value — and swaps the detail form in only when asked (the pencil)
// or when another status is picked. Save paths, the dirty lock and the pinned action bar are the
// editor's own and must keep working through the swap.

async function startNextActionsReview(page: Page) {
    await page.goto('/weekly-review?stage=nextActions');
    await page.getByTestId('startReviewButton').click();
    await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');
    return page.getByTestId('focusStage');
}

const factsOf = (card: Locator) => card.getByTestId('itemDetailsFact');

/** The editor card's laid-out content height — the scroller's own height is viewport-capped. */
async function cardContentHeight(card: Locator) {
    return card.getByTestId('itemEditorBody').evaluate((el) => el.scrollHeight);
}

test.describe('Weekly review — read-only details summary', () => {
    test('summarises only the filled fields; the pencil opens the form in place and Save & next commits an edit', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-summary-${uniqueStamp()}@example.com`, async (page) => {
            const phone = await gtd.createWorkContext(page, 'phone');
            const expectedBy = dayjs().add(3, 'day');
            const action = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Call the plumber'), {
                workContextIds: [phone._id],
                energy: 'low',
                time: 15,
                expectedBy: expectedBy.format('YYYY-MM-DD'),
            });
            await gtd.flush(page);

            const card = await startNextActionsReview(page);
            await expect(card.getByRole('textbox', { name: 'Title' })).toHaveValue('Call the plumber');

            // Filled fields, in the form's order; the unset ones (people, urgency, tickler) are absent.
            await expect(factsOf(card)).toHaveText(['Contextsphone', 'EnergyLow', 'Time15 min', `Expected by${formatDisplayDate(expectedBy, 'MMM D')}`]);
            await expect(card.getByRole('group', { name: 'Energy' })).toHaveCount(0);
            await expect(card.getByText('Tickler — hide until')).toHaveCount(0);

            // The pencil swaps the form in and hands focus to its first control (no focus lost to <body>).
            await card.getByTestId('editDetailsButton').click();
            await expect(card.getByTestId('itemDetailsSummary')).toHaveCount(0);
            await expect(card.getByTestId('ignoreBeforeDate')).toBeFocused();

            // A structural edit through the form still locks travel and commits on Save & next.
            await card.getByRole('group', { name: 'Energy' }).getByRole('button', { name: 'High' }).click();
            await expect(page.getByTestId('stageTravelNext')).toBeDisabled();
            await expect(page.getByTestId('focusKeep')).toHaveText('Save & next');
            await page.getByTestId('focusKeep').click();
            await expect.poll(async () => (await gtd.getItem(page, action._id))?.energy).toBe('high');
        });
    });

    test('unsaved edits lock every action that would drop them; Discard reverts the card and frees them', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-summary-discard-${uniqueStamp()}@example.com`, async (page) => {
            const action = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Call the plumber'), { energy: 'low', time: 15 });
            await gtd.flush(page);

            const card = await startNextActionsReview(page);
            await card.getByTestId('editDetailsButton').click();
            await card.getByRole('group', { name: 'Energy' }).getByRole('button', { name: 'High' }).click();

            // Done and ◀ ▶ would leave the card and silently drop the edit: locked. Save & next or Discard decide.
            for (const testId of ['focusDone', 'stageNavBack', 'stageNavForward']) {
                await expect(page.getByTestId(testId)).toBeDisabled();
            }
            await expect(page.getByTestId('focusKeep')).toHaveText('Save & next');

            await page.getByTestId('focusDiscard').click();

            await expect(card.getByRole('group', { name: 'Energy' }).getByRole('button', { name: 'Low' })).toHaveAttribute('aria-pressed', 'true');
            await expect(page.getByTestId('focusKeep')).toHaveText('Looks good');
            // Discard unmounts with the edits it dropped: focus moves on to the primary, never <body>.
            await expect(page.getByTestId('focusKeep')).toBeFocused();
            await expect(page.getByTestId('focusDone')).toBeEnabled();
            await expect(page.getByTestId('stageNavForward')).toBeEnabled();
            await expect(page.getByTestId('focusDiscard')).toHaveCount(0);
            expect((await gtd.getItem(page, action._id))?.energy).toBe('low');
        });
    });

    test('a next action with nothing set says so, and picking another status opens that status form directly', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-summary-status-${uniqueStamp()}@example.com`, async (page) => {
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Bare action'), {});
            await gtd.flush(page);

            const card = await startNextActionsReview(page);
            await expect(card.getByTestId('itemDetailsSummary')).toContainText('No details set');

            await card.getByRole('button', { name: 'Waiting For' }).click();
            await expect(card.getByTestId('itemDetailsSummary')).toHaveCount(0);
            await expect(card.getByTestId('itemDetailsForm')).toBeVisible();
            await expect(card.getByLabel('Expected by')).toBeVisible();

            // Once a form was opened for editing it stays open, even when the selected status matches
            // the saved one again (re-picked here; a remote write landing the same status is the
            // same flip) — a summary must never cover a form the user has been working in.
            await card.getByRole('button', { name: 'Next Action' }).click();
            await expect(card.getByTestId('itemDetailsSummary')).toHaveCount(0);
            await expect(card.getByRole('group', { name: 'Energy' })).toBeVisible();
        });
    });

    test('the summary takes at most half the height of the detail form it folds, and the card shrinks with it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-summary-height-${uniqueStamp()}@example.com`, async (page) => {
            await page.setViewportSize({ width: 1920, height: 929 });
            // A typical next action: a context, a person, energy and time.
            const context = await gtd.createWorkContext(page, 'errands');
            const person = await gtd.createPerson(page, { name: 'Dana' });
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Pick up the frames'), {
                workContextIds: [context._id],
                peopleIds: [person._id],
                energy: 'medium',
                time: 20,
            });
            await gtd.flush(page);

            const card = await startNextActionsReview(page);
            const summary = card.getByTestId('itemDetailsSummary');
            await expect(summary).toBeVisible();
            const summaryHeight = await heightOf(summary);
            const cardWithSummary = await cardContentHeight(card);

            await card.getByTestId('editDetailsButton').click();
            const form = card.getByTestId('itemDetailsForm');
            await expect(form.getByRole('group', { name: 'Energy' })).toBeVisible();
            const heights = { summary: summaryHeight, form: await heightOf(form), cardWithSummary, cardWithForm: await cardContentHeight(card) };

            expect(heights.summary, JSON.stringify(heights)).toBeLessThanOrEqual(heights.form / 2);
            expect(heights.cardWithSummary, JSON.stringify(heights)).toBeLessThan(heights.cardWithForm - (heights.form - heights.summary) * 0.9);
        });
    });
});

test.describe('Item editor — one layout for every status', () => {
    test('the status chips hold one line on the review card, and the position row is one line on the item page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `editor-density-${uniqueStamp()}@example.com`, async (page) => {
            await page.setViewportSize({ width: 1920, height: 929 });
            const item = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Dense'), {});
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Second, so the row has somewhere to move'), {});
            await gtd.flush(page);

            const card = await startNextActionsReview(page);
            const chips = card.getByTestId('itemEditorStatusChip');
            await expect(chips.first()).toBeVisible();
            expect(Math.abs((await topOf(chips.first())) - (await topOf(chips.last())))).toBeLessThan(2);

            await page.goto(`/item/${item._id}`);
            const row = page.getByTestId('nextActionPositionRow');
            await expect(row).toBeVisible();
            const labelBox = await row.getByText(/^Position in/).boundingBox();
            const buttonBox = await page.getByTestId('nextActionPositionTop').boundingBox();
            if (!labelBox || !buttonBox) throw new Error('expected the position label and buttons to lay out');
            // Same line: the label's vertical centre falls inside the button's height.
            expect(labelBox.y + labelBox.height / 2).toBeGreaterThan(buttonBox.y);
            expect(labelBox.y + labelBox.height / 2).toBeLessThan(buttonBox.y + buttonBox.height);
        });
    });

    test('notes sit below the status details for a next action, a calendar event and a waiting-for', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `editor-layout-${uniqueStamp()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Omer' });
            const tomorrow = dayjs().add(1, 'day').hour(10).minute(0).second(0);
            const nextAction = await gtd.clarifyToNextAction(page, { ...(await gtd.collect(page, 'NA')), notes: 'na notes' }, { energy: 'low' });
            const event = await gtd.clarifyToCalendar(
                page,
                { ...(await gtd.collect(page, 'Event')), notes: 'event notes' },
                {
                    timeStart: tomorrow.format('YYYY-MM-DDTHH:mm:ss'),
                    timeEnd: tomorrow.add(1, 'hour').format('YYYY-MM-DDTHH:mm:ss'),
                },
            );
            const waiting = await gtd.clarifyToWaitingFor(page, { ...(await gtd.collect(page, 'WF')), notes: 'wf notes' }, { waitingForPersonId: person._id });
            await gtd.flush(page);

            for (const [item, detailControl] of [
                [nextAction, (p: Page) => p.getByRole('group', { name: 'Energy' })],
                [event, (p: Page) => p.getByRole('textbox', { name: 'Date', exact: true })],
                [waiting, (p: Page) => p.getByLabel('Expected by')],
            ] as const) {
                await page.goto(`/item/${item._id}`);
                const notes = page.getByTestId('pageNotesPreview');
                await expect(notes).toBeVisible();
                const statusTop = await topOf(page.getByRole('button', { name: 'Next Action' }));
                const detailTop = await topOf(detailControl(page));
                const notesTop = await topOf(notes);
                expect(statusTop, item.title).toBeLessThan(detailTop);
                expect(detailTop, item.title).toBeLessThan(notesTop);
            }
        });
    });

    test('with a brief on show, the item page folds the notes behind "Show notes"', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `editor-fold-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.clarifyToNextAction(page, { ...(await gtd.collect(page, 'Renew passport')), notes: 'Form half filled; photos needed.' }, {});
            await gtd.setUserBrief(page, item, 'Passport renewal before the June trip');
            await gtd.flush(page);

            await page.goto(`/item/${item._id}`);
            await expect(page.getByTestId('pageNotesPreview')).toHaveCount(0);
            await page.getByTestId('showNotesButton').click();
            await expect(page.getByTestId('pageNotesPreview')).toContainText('Form half filled');
        });
    });
});

async function heightOf(locator: Locator) {
    const box = await locator.boundingBox();
    if (!box) throw new Error('expected a laid-out element');
    return box.height;
}

async function topOf(locator: Locator) {
    const box = await locator.boundingBox();
    if (!box) throw new Error('expected a laid-out element');
    return box.y;
}
