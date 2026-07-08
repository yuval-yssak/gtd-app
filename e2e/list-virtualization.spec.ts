import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// The list pages (next-actions, inbox, calendar, routines) render through virtua's
// WindowVirtualizer, so navigation stays fast regardless of list size — only rows near the
// viewport mount. Because offscreen rows are not in the DOM, browser find-in-page can't see
// them; each page carries an in-page search field as the replacement. These tests pin both
// halves of that contract: windowed mounting and live search filtering.
test.describe('Virtualized list pages with in-page search', () => {
    test('next actions render windowed and the header search button filters rows', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `virtual-na-${dayjs().valueOf()}@example.com`, async (page) => {
            // Zero-padded so no title is a prefix of another — keeps text lookups unambiguous.
            for (let i = 1; i <= 60; i++) {
                const item = await gtd.collect(page, `Errand ${String(i).padStart(2, '0')}`);
                await gtd.clarifyToNextAction(page, item);
            }

            await page.goto('/next-actions');
            await expect(page.getByTestId('nextActionItemRow').first()).toBeVisible();

            // All 60 items are in the list, but the window virtualizer should mount only the
            // rows near the viewport. Assert a comfortable margin rather than an exact count so
            // overscan tuning doesn't break the test.
            expect(await page.locator('[data-list-item-id]').count()).toBeLessThan(50);

            await page.getByTestId('nextActionsSearchButton').click();
            const searchInput = page.getByTestId('nextActionsSearchInput');
            await searchInput.fill('Errand 07');
            await expect(page.getByText('Errand 07')).toBeVisible();
            await expect(page.getByText('Errand 08')).toBeHidden();

            // The debounced URL write still happens (shareable filters) even though
            // filtering doesn't wait for it.
            await expect(page).toHaveURL(/[?&]q=/);

            // Closing the field clears the query and restores the full list.
            await page.getByLabel('Close search').click();
            await expect(page.getByTestId('nextActionsSearchInput')).toBeHidden();
            await expect(page).not.toHaveURL(/[?&]q=/);
            expect(await page.getByTestId('nextActionItemRow').count()).toBeGreaterThan(5);

            // A shared/bookmarked ?q= deep link opens the field pre-filled and pre-filtered.
            await page.goto('/next-actions?q=Errand%2003');
            await expect(page.getByTestId('nextActionsSearchInput')).toHaveValue('Errand 03');
            await expect(page.getByText('Errand 03')).toBeVisible();
            await expect(page.getByText('Errand 04')).toBeHidden();
        });
    });

    test('inbox renders windowed and search distinguishes no-results from inbox zero', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `virtual-inbox-${dayjs().valueOf()}@example.com`, async (page) => {
            for (let i = 1; i <= 60; i++) {
                await gtd.collect(page, `Note ${String(i).padStart(2, '0')}`);
            }

            await page.goto('/inbox');
            await expect(page.getByTestId('inboxItemRow').first()).toBeVisible();
            expect(await page.locator('[data-list-item-id]').count()).toBeLessThan(50);

            await page.getByTestId('inboxSearchButton').click();
            const searchInput = page.getByTestId('inboxSearchInput');
            await searchInput.fill('Note 42');
            await expect(page.getByText('Note 42')).toBeVisible();
            await expect(page.getByText('Note 41')).toBeHidden();

            // Deliberate semantics: Process Inbox batches only the searched subset.
            await expect(page.getByTestId('processInboxButton')).toHaveText('Process Inbox (1)');

            // A query that matches nothing reads as "no results", not "inbox zero".
            await searchInput.fill('zebra');
            await expect(page.getByText('No inbox items match your search.')).toBeVisible();
        });
    });

    test('calendar renders day groups windowed and search narrows across days', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `virtual-cal-${dayjs().valueOf()}@example.com`, async (page) => {
            // One timed item per day for 30 days — every item lands in its own day group.
            for (let i = 1; i <= 30; i++) {
                const item = await gtd.collect(page, `Meet ${String(i).padStart(2, '0')}`);
                const start = dayjs().add(i, 'day').hour(10).minute(0).second(0).millisecond(0);
                await gtd.clarifyToCalendar(page, item, { timeStart: start.toISOString(), timeEnd: start.add(1, 'hour').toISOString() });
            }

            await page.goto('/calendar');
            await expect(page.getByTestId('calendarItemRow').first()).toBeVisible();
            // 30 day groups exist, but only the groups near the viewport should be mounted.
            expect(await page.getByTestId('calendarItemRow').count()).toBeLessThan(25);

            await page.getByTestId('calendarSearchButton').click();
            const searchInput = page.getByTestId('calendarSearchInput');
            await searchInput.fill('Meet 17');
            await expect(page.getByText('Meet 17')).toBeVisible();
            await expect(page.getByText('Meet 16')).toBeHidden();

            await searchInput.fill('zebra');
            await expect(page.getByText('No calendar items match your search.')).toBeVisible();
        });
    });
});
