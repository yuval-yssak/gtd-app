import { expect, type Locator, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { briefInputOf, titleInputOf } from './helpers/itemEditorLocators';

// A long title and a long brief must be readable in full in a single view — in the item editor
// and in the weekly review, which renders the same editor body. They used to be single-line
// inputs, so anything past the first line was reachable only by scrolling inside the field.

const LONG_TITLE =
    'GTD App – in the item edit, and in weekly review, the title is limited to one line, which is ok provided the brief is not, but it is too, so a single view cannot show the full picture';
const LONG_BRIEF =
    'Title and brief both truncate to one line in the edit and weekly review views, forcing the reviewer to scroll inside the field before the sentence can be read at all.';
const LONG_NOTES = [
    'Renewal form is half filled in — the personal details section is done but the travel history page is still blank.',
    'Need two new passport photos and the previous passport for the appointment; the old photos are more than six months old.',
    'The June trip is the hard deadline; processing is quoted at four to six weeks, so this has to be submitted by early May.',
].join(' ');

/**
 * The field shows all of its text at once: no hidden overflow to scroll to, and it really did
 * wrap onto more than one line rather than growing one very wide line.
 */
async function expectWrappedAndFullyVisible(field: Locator) {
    const box = await field.evaluate((el) => {
        // Only properties every HTMLElement has — the helper stays usable if a field's tag changes.
        const { scrollHeight, clientHeight, scrollWidth, clientWidth } = el;
        return { scrollHeight, clientHeight, scrollWidth, clientWidth, lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight) };
    });
    // Nothing clipped vertically or horizontally — the whole value is on screen.
    expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight + 1);
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    // …because it wrapped: the box is taller than one line of text.
    expect(box.clientHeight).toBeGreaterThan(box.lineHeight * 1.5);
}

test.describe('Item title and brief wrap instead of clipping to one line', () => {
    test('item page shows a long title and a long brief in full', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wrap-page-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, LONG_TITLE);
            const item = await gtd.clarifyToNextAction(page, { ...inbox, notes: LONG_NOTES }, {});
            await gtd.setUserBrief(page, item, LONG_BRIEF);
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto(`/item/${item._id}`);
            const title = titleInputOf(page);
            await expect(title).toHaveValue(LONG_TITLE);
            await expectWrappedAndFullyVisible(title);

            const brief = briefInputOf(page);
            await expect(brief).toHaveValue(LONG_BRIEF);
            await expectWrappedAndFullyVisible(brief);
        });
    });

    test('Enter in the title commits without inserting a newline', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wrap-enter-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Short title');
            await gtd.flush(page);

            await page.goto(`/item/${item._id}`);
            const title = titleInputOf(page);
            await title.click();
            await title.press('End');
            await title.pressSequentially(' edited');
            await title.press('Enter');

            // A multiline field would otherwise take the Enter as a line break.
            await expect(title).toHaveValue('Short title edited');
            await expect.poll(async () => (await gtd.listItems(page)).find((i) => i._id === item._id)?.title).toBe('Short title edited');
        });
    });

    test('a pasted multi-line title collapses to one line', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wrap-paste-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Placeholder');
            await gtd.flush(page);

            await page.goto(`/item/${item._id}`);
            const title = titleInputOf(page);
            await expect(title).toHaveValue('Placeholder');

            // Insert newline-bearing text in one shot — the same single input event a paste
            // produces, and the path the typed-Enter guard cannot see. (navigator.clipboard would
            // need a permission grant; a hand-dispatched ClipboardEvent is untrusted and no-ops.)
            await title.click();
            await title.press('ControlOrMeta+a');
            await page.keyboard.insertText('Renew passport\nbefore the June trip');

            await expect(title).toHaveValue('Renew passport before the June trip');
            await expect.poll(async () => (await gtd.listItems(page)).find((i) => i._id === item._id)?.title).toBe('Renew passport before the June trip');
        });
    });

    test('Enter in the brief commits it without inserting a newline', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wrap-brief-enter-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Brief Enter guard');
            const item = await gtd.clarifyToNextAction(page, { ...inbox, notes: LONG_NOTES }, {});
            await gtd.flush(page);

            await page.goto(`/item/${item._id}`);
            const brief = briefInputOf(page);
            await brief.click();
            await page.keyboard.insertText('Photos are the blocker');
            await brief.press('Enter');

            await expect(brief).toHaveValue('Photos are the blocker');
            // Enter commits as well as swallowing the newline — the brief reaches IDB.
            await expect.poll(async () => (await gtd.getItemBrief(page, item._id))?.text).toBe('Photos are the blocker');
        });
    });

    test('a long routine title wraps in the routine editor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wrap-routine-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createRoutine(page, { routineType: 'nextAction', rrule: 'FREQ=DAILY;INTERVAL=1', template: {}, active: true, title: LONG_TITLE });
            await gtd.flush(page);

            await page.goto('/routines');
            await page.getByTestId('routineRow').filter({ hasText: LONG_TITLE }).click();
            const dialog = page.getByRole('dialog', { name: 'Edit routine' });
            const title = titleInputOf(dialog);
            await expect(title).toHaveValue(LONG_TITLE);
            await expectWrappedAndFullyVisible(title);
        });
    });

    test('weekly review card shows a long title in full', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wrap-review-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, LONG_TITLE);
            const item = await gtd.clarifyToNextAction(page, { ...inbox, notes: LONG_NOTES }, {});
            await gtd.setUserBrief(page, item, LONG_BRIEF);
            await gtd.flush(page);

            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');

            const card = page.getByTestId('focusStage');
            const title = titleInputOf(card);
            await expect(title).toHaveValue(LONG_TITLE);
            await expectWrappedAndFullyVisible(title);

            // The brief line is a Typography that already wrapped before this fix, so its text
            // content proves nothing about clipping — it is asserted here only as the precondition
            // for switching to the field variant, which IS the element this fix changed.
            await expect(card.getByTestId('briefLine')).toHaveText(LONG_BRIEF);

            // "Show briefs" off swaps the line for the ordinary brief field — the review's only
            // rendering of the changed TextField, and otherwise untested for wrapping.
            await page.getByTestId('reviewHeaderStrip').click();
            await page.getByTestId('showBriefsToggle').click();
            const reviewBrief = briefInputOf(card);
            await expect(reviewBrief).toHaveValue(LONG_BRIEF);
            await expectWrappedAndFullyVisible(reviewBrief);
        });
    });
});
