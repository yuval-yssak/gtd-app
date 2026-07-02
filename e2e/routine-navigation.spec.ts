import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Routine navigation surface: /routines grouping + URL-backed search + open-page icon,
// the routine indicator deep link from next-actions, the routine page's next-item link,
// and the item editor's routine chip.

async function routineRowTitles(page: Page): Promise<string[]> {
    const visibleTitles = await page.getByTestId('routineRow').allInnerTexts();
    return visibleTitles.map((t) => t.split('\n')[0]?.trim() ?? '');
}

// Seeds routines across both types and several frequencies; returns those the assertions target.
async function seedGroupedRoutines(page: Page) {
    const dailyNa = await gtd.createRoutine(page, { title: 'Water plants', routineType: 'nextAction', rrule: 'FREQ=DAILY', template: {}, active: true });
    await gtd.createRoutine(page, { title: 'Renew insurance', routineType: 'nextAction', rrule: 'FREQ=YEARLY', template: {}, active: true });
    const weeklyCal = await gtd.createRoutine(page, {
        title: 'Pool session',
        routineType: 'calendar',
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
        template: {},
        active: true,
        calendarItemTemplate: { timeOfDay: '18:00', duration: 60 },
    });
    return { dailyNa, weeklyCal };
}

test.describe('Routines list — grouping and search', () => {
    test('sections are type-first (next action before calendar) with frequency buckets daily → annual', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-groups-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedGroupedRoutines(page);

            await page.goto('/routines');
            await page.waitForSelector('text=Water plants');

            await expect(page.getByTestId('routineTypeSectionTitle')).toHaveText(['Next Action Routines', 'Calendar Routines']);
            await expect(page.getByTestId('routineFrequencyBucket')).toHaveText(['Daily', 'Annual', 'Weekly']);
            expect(await routineRowTitles(page)).toEqual(['Water plants', 'Renew insurance', 'Pool session']);
        });
    });

    test('search filters by title, syncs to ?q=, deep-links, and shows a no-match state', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-search-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedGroupedRoutines(page);

            await page.goto('/routines');
            await page.waitForSelector('text=Water plants');

            await page.getByTestId('routinesSearchInput').fill('water');
            await expect(page).toHaveURL(/q=water/);
            expect(await routineRowTitles(page)).toEqual(['Water plants']);

            // Clearing the input drops the param and restores the full list.
            await page.getByTestId('routinesSearchInput').fill('');
            await expect(page).not.toHaveURL(/q=/);
            expect(await routineRowTitles(page)).toHaveLength(3);

            // No match → dedicated empty state, not the "no routines yet" copy.
            await page.getByTestId('routinesSearchInput').fill('zzz');
            await expect(page.getByTestId('routinesEmptyState')).toHaveText('No routines match your search.');

            // Deep link restores the filter on load.
            await page.goto('/routines?q=pool');
            await page.waitForSelector('text=Pool session');
            expect(await routineRowTitles(page)).toEqual(['Pool session']);
        });
    });

    test('open-page icon navigates to the routine page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-open-page-${dayjs().valueOf()}@example.com`, async (page) => {
            const { dailyNa } = await seedGroupedRoutines(page);

            await page.goto('/routines?q=water');
            await page.waitForSelector('text=Water plants');

            await page.getByTestId('routineRowOpenPageButton').click();
            await expect(page).toHaveURL(new RegExp(`/routine/${dailyNa._id}`));
            await expect(page.getByTestId('routinePageWrapper')).toBeVisible();
        });
    });
});

test.describe('Routine deep links from items', () => {
    test('routine icon on a next action, next-item link on the routine page, and the item editor chip all link through', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-links-${dayjs().valueOf()}@example.com`, async (page) => {
            const today = dayjs().format('YYYY-MM-DD');
            const routine = await gtd.createRoutine(page, {
                title: 'Workout',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
                startDate: today,
            });
            await gtd.materializePendingNextActionRoutines(page);
            const [item] = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'nextAction');
            if (!item) throw new Error('expected one materialized routine item');

            // 1. Routine indicator on the next-actions row → the routine's own page (not /routines).
            await page.goto('/next-actions');
            await page.waitForSelector('text=Workout');
            // Scope inside the row — the MUI ListItemButton row is itself role=button and would
            // also match the accessible name, tripping strict mode.
            await page.getByTestId('nextActionItemRow').getByRole('button', { name: 'Routine: Workout' }).click();
            await expect(page).toHaveURL(new RegExp(`/routine/${routine._id}`));

            // 2. Routine page shows a link to the immediate next item.
            const nextItemLink = page.getByTestId('routineNextItemLink');
            await expect(nextItemLink).toContainText('Workout');
            await nextItemLink.click();
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`));

            // 3. The item editor surfaces the routine chip linking back to the routine.
            const routineChip = page.getByTestId('itemEditorRoutineLink');
            await expect(routineChip).toBeVisible();
            await routineChip.getByText('Routine').click();
            await expect(page).toHaveURL(new RegExp(`/routine/${routine._id}`));
        });
    });

    test('routine page shows a disabled reason when no next item exists', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-no-next-${dayjs().valueOf()}@example.com`, async (page) => {
            const paused = await gtd.createRoutine(page, {
                title: 'Dormant routine',
                routineType: 'nextAction',
                rrule: 'FREQ=WEEKLY',
                template: {},
                active: false,
            });

            await page.goto(`/routine/${paused._id}`);
            await expect(page.getByTestId('routineNextItemEmpty')).toHaveText('No upcoming item — routine is paused');
            await expect(page.getByTestId('routineNextItemEmpty')).toBeDisabled();
        });
    });
});
