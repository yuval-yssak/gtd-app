import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// The search page filters on a deferred mirror of the input (useDeferredValue) rather than the
// debounced URL round-trip, and renders results through a memoized, window-virtualized list.
// These tests pin the user-visible contract of that pipeline: typing narrows results, the count
// chip tracks the filtered set, clearing restores it, and the URL still receives the query for
// shareability.
test.describe('Search page live filtering', () => {
    test('typing narrows results, clearing restores them, and the query lands in the URL', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `search-typing-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.collect(page, 'Alpha buy milk');
            await gtd.collect(page, 'Beta call plumber');
            await gtd.collect(page, 'Gamma call dentist');

            await page.goto('/search');
            const searchInput = page.getByPlaceholder('Search title and notes…');
            await expect(page.getByText('Alpha buy milk')).toBeVisible();
            await expect(page.getByText('Beta call plumber')).toBeVisible();

            await searchInput.fill('call');
            await expect(page.getByText('Beta call plumber')).toBeVisible();
            await expect(page.getByText('Gamma call dentist')).toBeVisible();
            await expect(page.getByText('Alpha buy milk')).toBeHidden();

            // The debounced URL write still happens (shareable searches) even though
            // filtering no longer waits for it.
            await expect(page).toHaveURL(/[?&]q=call/);

            await searchInput.fill('plumber');
            await expect(page.getByText('Gamma call dentist')).toBeHidden();
            await expect(page.getByText('Beta call plumber')).toBeVisible();

            await page.getByLabel('Clear search').click();
            await expect(page.getByText('Alpha buy milk')).toBeVisible();
            await expect(page.getByText('Gamma call dentist')).toBeVisible();
        });
    });

    test('a large result set renders windowed — offscreen rows are not mounted', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `search-virtual-${dayjs().valueOf()}@example.com`, async (page) => {
            // Zero-padded so no title is a prefix of another — keeps text lookups unambiguous.
            for (let i = 1; i <= 60; i++) {
                await gtd.collect(page, `Virtual row ${String(i).padStart(2, '0')}`);
            }

            await page.goto('/search');
            // Results sort by updatedTs descending, so the newest row (60) is at the top.
            await expect(page.getByText('Virtual row 60')).toBeVisible();

            // All 60 match the (empty) query, but the window virtualizer should mount only the
            // rows near the viewport. Assert a comfortable margin rather than an exact count so
            // overscan tuning doesn't break the test.
            const mountedRows = await page.locator('[data-list-item-id]').count();
            expect(mountedRows).toBeLessThan(50);

            // Scrolling the document brings the tail rows (the oldest) into the window.
            await page.evaluate(() => {
                const scroller = document.scrollingElement;
                if (scroller) scroller.scrollTop = scroller.scrollHeight;
            });
            await expect(page.getByText('Virtual row 01')).toBeVisible();
        });
    });
});
