import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

function tomorrowAt(hour: number) {
    const start = dayjs().add(1, 'day').hour(hour).minute(0).second(0).millisecond(0);
    return { timeStart: start.toISOString(), timeEnd: start.add(30, 'minute').toISOString() };
}

// Still today however late the test runs — even if this slot has already passed, it is not a later day.
function lateToday() {
    const start = dayjs().endOf('day').subtract(10, 'minute').millisecond(0);
    return { timeStart: start.toISOString(), timeEnd: start.add(5, 'minute').toISOString() };
}

async function seedCalendarItem(page: Page, title: string, slot: { timeStart: string; timeEnd: string }) {
    const inbox = await gtd.collect(page, title);
    const calItem = await gtd.clarifyToCalendar(page, inbox, slot);
    await gtd.flush(page);
    return calItem;
}

// A direct row read: `listItems` first waits for the active account to settle, which blocks for up to
// 10s while the background sync a routine completion kicks off holds the session gate.
async function statusOf(page: Page, itemId: string) {
    return (await gtd.getItem(page, itemId))?.status;
}

const confirmDialog = (page: Page) => page.getByTestId('futureDoneConfirmDialog');

/** A daily calendar routine whose first occurrence is tomorrow at noon; returns that occurrence. */
async function seedRoutineStartingTomorrow(page: Page, title: string) {
    const routine = await gtd.createRoutine(page, {
        title,
        routineType: 'calendar',
        rrule: 'FREQ=DAILY',
        startDate: dayjs().add(1, 'day').format('YYYY-MM-DD'),
        calendarItemTemplate: { timeOfDay: '12:00', duration: 60 },
        template: {},
        active: true,
    });
    await gtd.generateCalendarItemsToHorizon(page, routine._id);
    await gtd.flush(page);
    const occurrences = (await gtd.listItems(page))
        .filter((item) => item.routineId === routine._id && item.status === 'calendar')
        .sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''));
    const [first] = occurrences;
    if (!first?.timeStart) throw new Error('expected a generated occurrence');
    expect(dayjs(first.timeStart).isSame(dayjs().add(1, 'day'), 'day')).toBe(true);
    return { routine, first };
}

test.describe('Marking a future calendar item done asks first', () => {
    test('calendar row: a later-day item asks; Cancel keeps it, confirming completes it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `future-done-row-${uniqueStamp()}@example.com`, async (page) => {
            const calItem = await seedCalendarItem(page, 'Tomorrow dentist', tomorrowAt(9));
            await page.goto('/calendar');
            await page.waitForSelector('text=Tomorrow dentist');

            await page.getByTestId('calendarItemMarkDoneButton').first().click();
            await expect(confirmDialog(page)).toContainText('Tomorrow dentist');
            await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
            await expect(confirmDialog(page)).toHaveCount(0);
            await expect(page.getByText('Tomorrow dentist')).toBeVisible();
            expect(await statusOf(page, calItem._id)).toBe('calendar');

            await page.getByTestId('calendarItemMarkDoneButton').first().click();
            await page.getByTestId('futureDoneConfirmButton').click();
            await expect(page.getByText('Tomorrow dentist')).toHaveCount(0);
            expect(await statusOf(page, calItem._id)).toBe('done');
        });
    });

    test('calendar row: an item today completes without asking', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `future-done-today-${uniqueStamp()}@example.com`, async (page) => {
            const calItem = await seedCalendarItem(page, 'Tonight call', lateToday());
            await page.goto('/calendar');
            await page.waitForSelector('text=Tonight call');

            await page.getByTestId('calendarItemMarkDoneButton').first().click();
            await expect(page.getByText('Tonight call')).toHaveCount(0);
            await expect(confirmDialog(page)).toHaveCount(0);
            expect(await statusOf(page, calItem._id)).toBe('done');
        });
    });

    test('item editor: saving a later-day item as Done asks, and confirming saves it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `future-done-editor-${uniqueStamp()}@example.com`, async (page) => {
            const calItem = await seedCalendarItem(page, 'Tomorrow review', tomorrowAt(10));
            await page.goto(`/item/${calItem._id}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();

            await page.getByRole('button', { name: 'Done', exact: true }).click();
            await page.getByRole('button', { name: 'Save changes' }).click();
            await expect(confirmDialog(page)).toContainText('Tomorrow review');
            expect(await statusOf(page, calItem._id)).toBe('calendar');

            await page.getByTestId('futureDoneConfirmButton').click();
            await expect.poll(() => statusOf(page, calItem._id)).toBe('done');
        });
    });

    test('weekly review: Done on a later-day calendar item asks, and confirming completes it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `future-done-review-${uniqueStamp()}@example.com`, async (page) => {
            const calItem = await seedCalendarItem(page, 'Tomorrow workshop', tomorrowAt(11));
            await page.goto('/weekly-review?stage=calendar');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Tomorrow workshop');

            await page.getByTestId('focusDone').click();
            await expect(confirmDialog(page)).toContainText('Tomorrow workshop');
            expect(await statusOf(page, calItem._id)).toBe('calendar');

            await page.getByTestId('futureDoneConfirmButton').click();
            await expect(page.getByTestId('stageEmptyCard')).toBeVisible();
            expect(await statusOf(page, calItem._id)).toBe('done');
        });
    });

    test('weekly review: saving the embedded editor as Done on a later-day item asks, then advances', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `future-done-review-save-${uniqueStamp()}@example.com`, async (page) => {
            const calItem = await seedCalendarItem(page, 'Tomorrow seminar', tomorrowAt(14));
            await page.goto('/weekly-review?stage=calendar');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Tomorrow seminar');

            // The status chip, not the stage's own Done button beside "Save & next".
            await page
                .getByTestId('itemEditorStatusChip')
                .and(page.getByRole('button', { name: 'Done', exact: true }))
                .click();
            await page.getByTestId('focusKeep').click();
            await expect(confirmDialog(page)).toContainText('Tomorrow seminar');
            await page.getByTestId('futureDoneConfirmButton').click();

            await expect(page.getByTestId('stageEmptyCard')).toContainText('Calendar — all reviewed!');
            expect(await statusOf(page, calItem._id)).toBe('done');
        });
    });

    test('weekly review routine card: Done on a later-day occurrence asks; Cancel keeps it, confirming completes it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `future-done-routine-card-${uniqueStamp()}@example.com`, async (page) => {
            const { first } = await seedRoutineStartingTomorrow(page, 'Daily standup');
            await page.goto('/weekly-review?stage=calendar');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('routineReviewCard')).toBeVisible();

            await page.getByTestId('routineCardDone').click();
            await expect(confirmDialog(page)).toContainText('Daily standup');
            await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
            await expect(confirmDialog(page)).toHaveCount(0);
            expect(await statusOf(page, first._id)).toBe('calendar');

            await page.getByTestId('routineCardDone').click();
            await page.getByTestId('futureDoneConfirmButton').click();
            await expect(page.getByTestId('stageEmptyCard')).toBeVisible();
            await expect.poll(() => statusOf(page, first._id)).toBe('done');
        });
    });

    test('routine page: Mark done on a next occurrence tomorrow asks, and confirming completes it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `future-done-routine-page-${uniqueStamp()}@example.com`, async (page) => {
            const { routine, first } = await seedRoutineStartingTomorrow(page, 'Morning pages');
            await page.goto(`/routine/${routine._id}`);
            await expect(page.getByTestId('routineNextItemLink')).toContainText('Morning pages');

            await page.getByTestId('routineNextItemMarkDone').click();
            await expect(confirmDialog(page)).toContainText('Morning pages');
            expect(await statusOf(page, first._id)).toBe('calendar');

            await page.getByTestId('futureDoneConfirmButton').click();
            await expect.poll(() => statusOf(page, first._id)).toBe('done');
        });
    });
});
