import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// New /routines page surfaces: the collapsed Paused section (per tab), the URL-backed Week view
// that lays fixed-weekly routines on a Mon–Sun grid with a "Less frequent" list underneath, and
// the compact row label combining the schedule with the next occurrence.

test.describe('Routines page — empty state', () => {
    test('a fresh account gets no tab/search/view chrome — just the empty-state copy', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routines-empty-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto('/routines');
            await expect(page.getByTestId('routinesEmptyState')).toHaveText('No routines yet. Routines auto-generate next actions on a schedule.');
            await expect(page.getByTestId('routinesTabNextAction')).toHaveCount(0);
            await expect(page.getByTestId('routinesSearchInput')).toHaveCount(0);
        });
    });
});

test.describe('Routines page — paused section', () => {
    test('paused routines live in a collapsed section, out of the main list', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routines-paused-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createRoutine(page, { title: 'Water plants', routineType: 'nextAction', rrule: 'FREQ=DAILY', template: {}, active: true });
            await gtd.createRoutine(page, { title: 'Old habit', routineType: 'nextAction', rrule: 'FREQ=DAILY', template: {}, active: false });

            await page.goto('/routines');
            await page.waitForSelector('text=Water plants');

            // Paused routine is not in the main list — only behind the collapsed section.
            await expect(page.getByText('Old habit')).toBeHidden();
            const toggle = page.getByTestId('routinePausedSectionToggle');
            await expect(toggle).toContainText('Paused (1)');

            await toggle.click();
            await expect(page.getByText('Old habit')).toBeVisible();
            // The paused row still offers the resume affordance.
            await expect(page.getByTestId('routineRowResumeButton')).toBeVisible();

            await toggle.click();
            await expect(page.getByText('Old habit')).toBeHidden();
        });
    });
});

test.describe('Routines page — week view', () => {
    test('week view lays fixed-weekly routines on the grid, lists the rest below, and is URL-backed', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routines-week-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createRoutine(page, { title: 'Morning pages', routineType: 'nextAction', rrule: 'FREQ=DAILY', template: {}, active: true });
            await gtd.createRoutine(page, { title: 'Pay rent', routineType: 'nextAction', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', template: {}, active: true });
            await gtd.createRoutine(page, {
                title: 'Pool session',
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                template: {},
                active: true,
                calendarItemTemplate: { timeOfDay: '18:00', duration: 60 },
            });

            await page.goto('/routines');
            await page.waitForSelector('text=Morning pages');

            await page.getByTestId('routinesViewWeekButton').click();
            await expect(page).toHaveURL(/view=week/);
            await expect(page.getByTestId('routineWeekGrid')).toBeVisible();
            const columns = page.getByTestId('routineWeekDayColumn');
            await expect(columns).toHaveCount(7);

            // A daily routine fires every day — one entry per column.
            await expect(page.getByTestId('routineWeekGridEntry').filter({ hasText: 'Morning pages' })).toHaveCount(7);
            // Monthly has no fixed weekday — listed below with its schedule label.
            await expect(page.getByTestId('routineWeekLessFrequentRow')).toContainText('Pay rent');

            // Switching tabs keeps the week view; the timed calendar routine sits in Thursday's column.
            await page.getByTestId('routinesTabCalendar').click();
            await expect(page).toHaveURL(/tab=calendar/);
            await expect(page).toHaveURL(/view=week/);
            await expect(columns.nth(3)).toContainText('18:00 Pool session');

            // Clicking an entry opens the routine editor.
            await page.getByTestId('routineWeekGridEntry').first().click();
            await expect(page.getByRole('dialog', { name: 'Edit routine' })).toBeVisible();
            await page.keyboard.press('Escape');

            // Deep link restores the view on load.
            await page.goto('/routines?view=week');
            await page.waitForSelector('text=Morning pages');
            await expect(page.getByTestId('routineWeekGrid')).toBeVisible();
        });
    });
});

test.describe('Routines page — compact row labels', () => {
    test('rows show the readable schedule plus the next occurrence date', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routines-row-label-${dayjs().valueOf()}@example.com`, async (page) => {
            const today = dayjs().format('YYYY-MM-DD');
            await gtd.createRoutine(page, {
                title: 'Workout',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
                startDate: today,
            });
            await gtd.materializePendingNextActionRoutines(page);

            await page.goto('/routines');
            await page.waitForSelector('text=Workout');

            // Routine-generated next actions carry expectedBy — surfaced as "next due <date>".
            await expect(page.getByTestId('routineRow').filter({ hasText: 'Workout' })).toContainText(/Every day · next due/);
        });
    });
});
