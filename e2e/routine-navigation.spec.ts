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

test.describe('Routines list — tabs, grouping and search', () => {
    test('tabs split the types with counts, URL-backed selection, and frequency buckets daily → annual', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-groups-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedGroupedRoutines(page);

            await page.goto('/routines');
            await page.waitForSelector('text=Water plants');

            // Default tab: next-action routines only, bucketed daily → annual, with per-type counts.
            await expect(page.getByTestId('routinesTabNextAction')).toContainText('(2)');
            await expect(page.getByTestId('routinesTabCalendar')).toContainText('(1)');
            await expect(page.getByTestId('routineFrequencyBucket')).toHaveText(['Daily', 'Annual']);
            expect(await routineRowTitles(page)).toEqual(['Water plants', 'Renew insurance']);

            // Calendar tab: selection lands in the URL, list swaps to calendar routines.
            await page.getByTestId('routinesTabCalendar').click();
            await expect(page).toHaveURL(/tab=calendar/);
            await expect(page.getByTestId('routineFrequencyBucket')).toHaveText(['Weekly']);
            expect(await routineRowTitles(page)).toEqual(['Pool session']);

            // Deep link restores the tab on load.
            await page.goto('/routines?tab=calendar');
            await page.waitForSelector('text=Pool session');
            expect(await routineRowTitles(page)).toEqual(['Pool session']);
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

            // Clearing the input drops the param and restores the tab's full list.
            await page.getByTestId('routinesSearchInput').fill('');
            await expect(page).not.toHaveURL(/q=/);
            expect(await routineRowTitles(page)).toHaveLength(2);

            // No match → dedicated empty state, not the "no routines yet" copy.
            await page.getByTestId('routinesSearchInput').fill('zzz');
            await expect(page.getByTestId('routinesEmptyState')).toHaveText('No routines match your search.');

            // Deep link restores filter + tab together.
            await page.goto('/routines?q=pool&tab=calendar');
            await page.waitForSelector('text=Pool session');
            expect(await routineRowTitles(page)).toEqual(['Pool session']);
        });
    });

    test('open-page icon navigates to the routine page; ESC returns to the exact list URL with the page kept in history', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-open-page-${dayjs().valueOf()}@example.com`, async (page) => {
            const { dailyNa } = await seedGroupedRoutines(page);

            await page.goto('/routines?q=water');
            await page.waitForSelector('text=Water plants');

            await page.getByTestId('routineRowOpenPageButton').click();
            await expect(page).toHaveURL(new RegExp(`/routine/${dailyNa._id}`));
            await expect(page.getByTestId('routinePageWrapper')).toBeVisible();

            // Gate on the editor being mounted — the ESC listener attaches in an effect.
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();
            await page.keyboard.press('Escape');
            // Back to the exact previous location, search param included.
            await expect(page).toHaveURL(/\/routines\?q=water/);

            // The routine page stayed in history — the browser Back button returns to it.
            await page.goBack();
            await expect(page).toHaveURL(new RegExp(`/routine/${dailyNa._id}`));
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

    test('ESC from an item reached via a routine page returns to the list, not the routine page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-esc-chain-${dayjs().valueOf()}@example.com`, async (page) => {
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

            // List → routine page → next-item link: two detail pages deep.
            await page.goto('/routines');
            await page.waitForSelector('text=Workout');
            await page.getByTestId('routineRowOpenPageButton').click();
            await expect(page).toHaveURL(new RegExp(`/routine/${routine._id}`));
            await page.getByTestId('routineNextItemLink').click();
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`));
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

            // ESC aims at the last *list* location — never the intermediate detail page, which
            // would trap the user ping-ponging between the two detail pages.
            await page.keyboard.press('Escape');
            await expect(page).toHaveURL(/\/routines$/);
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
