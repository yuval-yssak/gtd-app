import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { openReviewDetailsForm } from './helpers/itemEditorLocators';
import { uniqueStamp } from './helpers/uniqueStamp';

// A routine whose occurrences piled up in the past: the Weekly Review's calendar card works through
// that backlog instead of closing after the first one, and asks whether the others were done or missed.

/** A daily calendar routine with its first three occurrences aged 3, 2 and 1 days into the past, still open. */
async function seedOverdueBacklog(page: Page, title: string) {
    const routine = await gtd.createRoutine(page, {
        title,
        routineType: 'calendar',
        rrule: 'FREQ=DAILY',
        startDate: dayjs().format('YYYY-MM-DD'),
        calendarItemTemplate: { timeOfDay: '12:00', duration: 15 },
        template: {},
        active: true,
    });
    await gtd.generateCalendarItemsToHorizon(page, routine._id);
    const generated = (await gtd.listItems(page))
        .filter((item) => item.routineId === routine._id && item.status === 'calendar')
        .sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''));
    const [first, second, third, ...upcoming] = generated;
    if (!first || !second || !third || upcoming.length === 0) {
        throw new Error('expected at least four generated occurrences');
    }
    const overdue = [first, second, third].map((occurrence, index) => {
        const start = dayjs()
            .startOf('day')
            .subtract(3 - index, 'day')
            .hour(12);
        return { ...occurrence, timeStart: start.format('YYYY-MM-DDTHH:mm:ss'), timeEnd: start.add(15, 'minute').format('YYYY-MM-DDTHH:mm:ss') };
    });
    // One write at a time: each queues a sync op, and the queue is not built for racing writers.
    for (const aged of overdue) {
        await gtd.updateItem(page, aged);
    }
    await gtd.flush(page); // never navigate mid-flush — see CLAUDE.md § E2E
    return { overdue, upcoming };
}

async function openCalendarStage(page: Page) {
    await page.goto('/weekly-review');
    await page.getByTestId('startReviewButton').click();
    await page.getByTestId('stageTravelNext').click();
    await page.getByTestId('stageTravelNext').click();
    await expect(page.getByTestId('reviewStageTitle')).toHaveText('Calendar');
}

async function statusesOf(page: Page, ids: ReadonlyArray<string>) {
    await gtd.flush(page);
    const items = await gtd.listItems(page);
    return ids.map((id) => items.find((item) => item._id === id)?.status);
}

const idsOf = (items: ReadonlyArray<{ _id: string }>) => items.map((item) => item._id);

test.describe('weekly review — a routine with several overdue occurrences', () => {
    test('Done asks about the other overdue occurrences, and "All done" completes every one of them', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-overdue-all-${uniqueStamp()}@example.com`, async (page) => {
            const { overdue, upcoming } = await seedOverdueBacklog(page, 'Daily standup');
            await openCalendarStage(page);

            const routineCard = page.getByTestId('routineReviewCard');
            await expect(routineCard.getByTestId('reviewRoutineBanner')).toContainText(`2 more overdue · ${upcoming.length} upcoming`);
            await page.getByTestId('routineCardDone').click();
            const dialog = page.getByTestId('overdueOccurrencesDialog');
            await expect(dialog).toContainText('3 past occurrences are still open');
            await page.getByTestId('overdueOccurrencesAllDone').click();

            await expect(page.getByTestId('stageEmptyCard')).toContainText('Calendar — all reviewed!');
            expect(await statusesOf(page, idsOf(overdue))).toEqual(['done', 'done', 'done']);
            expect(new Set(await statusesOf(page, idsOf(upcoming)))).toEqual(new Set(['calendar']));
        });
    });

    test('"This one, the rest missed" completes the shown occurrence and drops the other overdue ones', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-overdue-rest-missed-${uniqueStamp()}@example.com`, async (page) => {
            const { overdue, upcoming } = await seedOverdueBacklog(page, 'Evening walk');
            await openCalendarStage(page);

            await page.getByTestId('routineCardDone').click();
            await page.getByTestId('overdueOccurrencesRestMissed').click();

            await expect(page.getByTestId('stageEmptyCard')).toContainText('Calendar — all reviewed!');
            expect(await statusesOf(page, idsOf(overdue))).toEqual(['done', 'trash', 'trash']);
            expect(new Set(await statusesOf(page, idsOf(upcoming)))).toEqual(new Set(['calendar']));
        });
    });

    test('Missed drops one overdue occurrence and the card moves on to the next, deciding only once the backlog is clear', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-overdue-missed-${uniqueStamp()}@example.com`, async (page) => {
            const { overdue, upcoming } = await seedOverdueBacklog(page, 'Stretching');
            const [, second, third] = overdue;
            if (!second || !third) {
                throw new Error('expected three overdue occurrences');
            }
            await openCalendarStage(page);
            const routineCard = page.getByTestId('routineReviewCard');
            const banner = routineCard.getByTestId('reviewRoutineBanner');

            await page.getByTestId('routineCardMissed').click();
            await expect(banner).toContainText(`1 more overdue · ${upcoming.length} upcoming`);
            // Focus follows the backlog walk onto the next occurrence's Missed, not <body>.
            await expect(page.getByTestId('routineCardMissed')).toBeFocused();
            await openReviewDetailsForm(routineCard);
            await expect(routineCard.getByRole('textbox', { name: 'Date', exact: true })).toHaveValue((second.timeStart ?? '').slice(0, 10));

            await page.getByTestId('routineCardMissed').click();
            await expect(banner).toContainText(`${upcoming.length} more after this one`);
            // The last overdue occurrence has no other overdue one to ask about: Done completes it and decides the entry.
            await page.getByTestId('routineCardDone').click();
            await expect(page.getByTestId('stageEmptyCard')).toContainText('Calendar — all reviewed!');

            expect(await statusesOf(page, idsOf(overdue))).toEqual(['trash', 'trash', 'done']);
            expect(new Set(await statusesOf(page, idsOf(upcoming)))).toEqual(new Set(['calendar']));
        });
    });

    test('on a phone the action bar keeps one row and scrolls sideways, opening on its primary end', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-overdue-phone-${uniqueStamp()}@example.com`, async (page) => {
            await page.setViewportSize({ width: 390, height: 844 });
            await seedOverdueBacklog(page, 'Daily standup');
            await openCalendarStage(page);

            const looksGood = page.getByTestId('routineCardLooksGood');
            const pause = page.getByTestId('routineCardPause');
            await expect(looksGood).toBeInViewport();
            const slot = page.getByTestId('stageActionBarContent');
            const geometry = await slot.evaluate((element) => ({ overflows: element.scrollWidth > element.clientWidth, scrollLeft: element.scrollLeft }));
            // Six controls cannot fit 390px: the slot overflows and opens scrolled to its end.
            expect(geometry.overflows).toBe(true);
            expect(geometry.scrollLeft).toBeGreaterThan(0);
            // One row, never wrapped.
            const [pauseBox, primaryBox] = await Promise.all([pause.boundingBox(), looksGood.boundingBox()]);
            if (!pauseBox || !primaryBox) {
                throw new Error('expected both buttons rendered');
            }
            expect(Math.abs(pauseBox.y - primaryBox.y)).toBeLessThan(2);
            // Opened on its end, the row fades only its start edge — buttons hide that way.
            await expect(slot).toHaveAttribute('data-hidden-start');
            await expect(slot).not.toHaveAttribute('data-hidden-end');
            // The far start is reachable by scrolling, and the fade moves to the other edge.
            await slot.evaluate((element) => element.scrollTo({ left: 0 }));
            await expect(page.getByTestId('stageNavBack')).toBeInViewport();
            await expect(slot).toHaveAttribute('data-hidden-end');
            await expect(slot).not.toHaveAttribute('data-hidden-start');
        });
    });

    test("on a phone, Missed keeps the next occurrence's Missed focused AND scrolled into view", async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-overdue-phone-focus-${uniqueStamp()}@example.com`, async (page) => {
            await page.setViewportSize({ width: 390, height: 844 });
            const { upcoming } = await seedOverdueBacklog(page, 'Daily standup');
            await openCalendarStage(page);
            const slot = page.getByTestId('stageActionBarContent');
            const missed = page.getByTestId('routineCardMissed');
            await slot.evaluate((element) => element.scrollTo({ left: 0 }));
            await missed.scrollIntoViewIfNeeded();

            await missed.click();
            await expect(page.getByTestId('reviewRoutineBanner')).toContainText(`1 more overdue · ${upcoming.length} upcoming`);
            await expect(missed).toBeFocused();

            // Focus wins over the row's scroll-to-end: the focused button sits inside the visible slot.
            await expect(async () => {
                const [slotBox, missedBox] = await Promise.all([slot.boundingBox(), missed.boundingBox()]);
                if (!slotBox || !missedBox) {
                    throw new Error('expected the slot and Missed rendered');
                }
                expect(missedBox.x).toBeGreaterThanOrEqual(slotBox.x - 1);
                expect(missedBox.x + missedBox.width).toBeLessThanOrEqual(slotBox.x + slotBox.width + 1);
            }).toPass({ timeout: 2000 });
        });
    });

    test('unsaved edits on an occurrence lock Done, Missed and ◀ ▶; Discard reverts them', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-overdue-discard-${uniqueStamp()}@example.com`, async (page) => {
            await seedOverdueBacklog(page, 'Daily standup');
            await openCalendarStage(page);
            const title = page.getByTestId('routineReviewCard').getByRole('textbox', { name: 'Title' });

            await title.fill('Daily standup (moved)');

            for (const testId of ['routineCardDone', 'routineCardMissed', 'stageNavBack', 'stageNavForward']) {
                await expect(page.getByTestId(testId)).toBeDisabled();
            }
            await expect(page.getByTestId('routineCardLooksGood')).toHaveText('Save & next');

            await page.getByTestId('routineCardDiscard').click();

            await expect(title).toHaveValue('Daily standup');
            await expect(page.getByTestId('routineCardLooksGood')).toHaveText('Looks good');
            // Discard unmounts with the edits it dropped: focus moves on to the primary, never <body>.
            await expect(page.getByTestId('routineCardLooksGood')).toBeFocused();
            await expect(page.getByTestId('routineCardDone')).toBeEnabled();
            await expect(page.getByTestId('routineCardMissed')).toBeEnabled();
            await expect(page.getByTestId('routineCardDiscard')).toHaveCount(0);
        });
    });
});
