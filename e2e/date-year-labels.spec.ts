import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// List pages show short dates ("Jan 8"); a date outside the current year must name its year, or
// last January's due date reads as next month's.
const nextYear = dayjs().year() + 1;
const lastYear = dayjs().year() - 1;
const thisYearDay = dayjs().startOf('year').add(6, 'month');

test.describe('Dates outside the current year show the year', () => {
    test('next actions: section header and due label', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `date-year-na-${uniqueStamp()}@example.com`, async (page) => {
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Next-year action'), { expectedBy: `${nextYear}-01-08` });
            await gtd.flush(page);

            await page.goto('/next-actions');
            await expect(page.getByTestId('nextActionSectionHeader').first()).toHaveText(dayjs(`${nextYear}-01-08`).format('ddd MMM D, YYYY'));
            await expect(page.getByTestId('nextActionItemRow').filter({ hasText: 'Next-year action' })).toContainText(`Due Jan 8, ${nextYear}`);
        });
    });

    test('waiting for: expected-by label names other years only', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `date-year-wf-${uniqueStamp()}@example.com`, async (page) => {
            await gtd.clarifyToWaitingFor(page, await gtd.collect(page, 'Last-year wait'), { expectedBy: `${lastYear}-12-30` });
            await gtd.clarifyToWaitingFor(page, await gtd.collect(page, 'This-year wait'), { expectedBy: thisYearDay.format('YYYY-MM-DD') });
            await gtd.flush(page);

            await page.goto('/waiting-for');
            await expect(page.getByText(`Expected by Dec 30, ${lastYear}`)).toBeVisible();
            // Anchored so a trailing ", YYYY" fails it; the " — overdue" suffix depends on today's date.
            await expect(page.getByText(new RegExp(`^Expected by ${thisYearDay.format('MMM D')}( — overdue)?$`))).toBeVisible();
        });
    });

    test('calendar: day header', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `date-year-cal-${uniqueStamp()}@example.com`, async (page) => {
            const day = `${nextYear}-01-08`;
            const exclusiveEnd = dayjs(day).add(1, 'day').format('YYYY-MM-DD');
            await gtd.clarifyToCalendar(page, await gtd.collect(page, 'Next-year event'), { timeStart: day, timeEnd: exclusiveEnd, allDay: true });
            await gtd.flush(page);

            await page.goto('/calendar');
            await expect(page.getByText(dayjs(day).format('dddd, MMM D, YYYY'), { exact: true })).toBeVisible();
        });
    });
});
