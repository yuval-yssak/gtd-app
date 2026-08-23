import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// List pages share one <main> scroll container. Leaving a list saves its position
// (keyed by location, 5-minute sticky window) and returning restores it, re-anchored
// on the consensus of the rows that were visible at save time — so a single row an edit
// moved in the sort can't drag the viewport along. An item that just left the list
// renders once as a faded "ghost" row that lingers briefly and collapses away.

async function seedNextActions(page: Page, count: number, prefix: string): Promise<void> {
    for (let i = 1; i <= count; i++) {
        // Zero-padded so no title is a prefix of another — keeps hasText filters unambiguous.
        const inbox = await gtd.collect(page, `${prefix} ${String(i).padStart(2, '0')}`);
        await gtd.clarifyToNextAction(page, inbox, { energy: 'low', time: 5 });
    }
}

// The login helper presets clarify mode to 'dialog'; these flows need row clicks to
// navigate to the /item/:id page (the app's actual default), so switch it back.
async function usePageClarifyMode(page: Page): Promise<void> {
    await page.evaluate(() => localStorage.setItem('gtd:inlineClarifyMode', 'page'));
}

// The app shell grows with its content (min-height), so the *document* is the real
// scroll surface — matching what resolveScrollSurface() picks in the client hook.
async function scrollListToMiddle(page: Page): Promise<number> {
    return page.evaluate(() => {
        const scroller = document.scrollingElement;
        if (!scroller) throw new Error('no document scrolling element');
        scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
        return scroller.scrollTop;
    });
}

async function readListScrollTop(page: Page): Promise<number> {
    return page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
}

/**
 * Titles of rows FULLY visible in the viewport, top→bottom. Clicking a partially-visible
 * row makes Playwright auto-scroll (center) it first, moving the position the app then
 * faithfully saves — assertions would compare against a stale pre-click offset.
 * Deliberately stricter than the app's save-time anchor pick (which keeps partially
 * visible rows): every row returned here is guaranteed to be among the saved anchors.
 * `titleLength` trims row text (which includes chips) down to the seeded title.
 */
async function fullyVisibleRowTitles(page: Page, titleLength: number): Promise<string[]> {
    return page.evaluate((length) => {
        return [...document.querySelectorAll('[data-list-item-id]')]
            .filter((row) => {
                const rect = row.getBoundingClientRect();
                return rect.top > 10 && rect.bottom < window.innerHeight - 10;
            })
            .flatMap((row) => {
                const title = row.querySelector('[data-testid="nextActionItemRow"]')?.textContent;
                return title ? [title.slice(0, length)] : [];
            });
    }, titleLength);
}

async function fullyVisibleRowTitle(page: Page): Promise<string> {
    const [title] = await fullyVisibleRowTitles(page, 'Restore item 00'.length);
    if (!title) throw new Error('no fully visible next-action row found');
    return title;
}

test.describe('List scroll restoration + ghost rows', () => {
    test('marking an item done on its page and coming back restores the position and fades a ghost', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `scroll-restore-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedNextActions(page, 35, 'Restore item');

            await page.goto('/next-actions');
            await usePageClarifyMode(page);
            // Windowed rendering (virtua) mounts only rows near the viewport, so an exact
            // 35-row count never holds — a visible first row means the list data is loaded.
            await expect(page.getByTestId('nextActionItemRow').first()).toBeVisible();

            const savedScrollTop = await scrollListToMiddle(page);
            expect(savedScrollTop).toBeGreaterThan(200);
            const anchorTitle = await fullyVisibleRowTitle(page);

            // dispatchEvent instead of click(): Playwright's actionability pass scrolls the
            // target (centering it) before a real click, which would legitimately move the
            // position the app saves — the assertion below must compare against savedScrollTop.
            await page.getByTestId('nextActionItemRow').filter({ hasText: anchorTitle }).dispatchEvent('click');
            await expect(page).toHaveURL(/\/item\/[^/]+/);
            // The detail form starts at the top even though the list was scrolled deep.
            await expect.poll(() => readListScrollTop(page)).toBe(0);

            await page.getByRole('button', { name: 'Done' }).click();
            await page.getByRole('button', { name: 'Save changes' }).click();
            await expect(page).toHaveURL(/\/next-actions$/);

            // The completed item is still visible as a fading ghost in its old position…
            const ghost = page.getByTestId('ghostListRow');
            await expect(ghost).toBeVisible();
            await expect(ghost).toContainText(anchorTitle);

            // …and the list is back at (approximately) the saved position: the anchor row's
            // ghost still exists, so restoration should land within a row height or so.
            // Poll: the restore re-asserts over the router's own scroll reset across frames.
            await expect.poll(async () => Math.abs((await readListScrollTop(page)) - savedScrollTop)).toBeLessThan(150);

            // The ghost collapses away on its own and the item leaves the list for good.
            await expect(ghost).toHaveCount(0, { timeout: 5_000 });
            await expect(page.getByText(anchorTitle)).toHaveCount(0);
        });
    });

    test('in-list Mark done fades the row out in place instead of removing it instantly', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ghost-inlist-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedNextActions(page, 3, 'Fade item');

            await page.goto('/next-actions');
            await expect(page.getByTestId('nextActionItemRow')).toHaveCount(3);

            const targetRow = page.getByTestId('nextActionItemRow').filter({ hasText: 'Fade item 02' });
            await targetRow.locator('..').getByRole('button', { name: 'Mark done' }).click();

            const ghost = page.getByTestId('ghostListRow');
            await expect(ghost).toBeVisible();
            await expect(ghost).toContainText('Fade item 02');
            await expect(ghost).toHaveCount(0, { timeout: 5_000 });
            await expect(page.getByText('Fade item 02')).toHaveCount(0);
            await expect(page.getByTestId('nextActionItemRow')).toHaveCount(2);
        });
    });

    test('switching lists resets to top; returning within the sticky window restores the position', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `scroll-sticky-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedNextActions(page, 35, 'Sticky item');

            await page.goto('/next-actions');
            // Windowed rendering — readiness is "a row is visible", not an exact mounted count.
            await expect(page.getByTestId('nextActionItemRow').first()).toBeVisible();
            const savedScrollTop = await scrollListToMiddle(page);
            expect(savedScrollTop).toBeGreaterThan(200);

            // A list never visited this session starts at the top, not at the inherited offset.
            await page.getByRole('link', { name: 'Someday / Maybe' }).click();
            await expect(page).toHaveURL(/\/someday$/);
            await expect.poll(() => readListScrollTop(page)).toBe(0);

            // Returning via the nav (not back-navigation) is still "within the flow" — position sticks.
            await page.getByRole('link', { name: 'Next Actions' }).click();
            await expect(page).toHaveURL(/\/next-actions$/);
            await expect(page.getByTestId('nextActionItemRow').first()).toBeVisible();
            await expect.poll(async () => Math.abs((await readListScrollTop(page)) - savedScrollTop)).toBeLessThan(150);
        });
    });

    test('removing the expected date from the top visible item keeps the other items in place', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `scroll-reorder-${dayjs().valueOf()}@example.com`, async (page) => {
            // 28 dated items (ascending due dates → list order 01..28) + 6 undated ones that sort
            // to the no-date tier at the bottom. Removing a dated item's date drops it past all
            // remaining dated rows — far below the saved viewport.
            const baseDay = dayjs().add(30, 'day');
            for (let i = 1; i <= 34; i++) {
                const inbox = await gtd.collect(page, `Reorder item ${String(i).padStart(2, '0')}`);
                await gtd.clarifyToNextAction(page, inbox, {
                    energy: 'low',
                    time: 5,
                    ...(i <= 28 ? { expectedBy: baseDay.add(i, 'day').format('YYYY-MM-DD') } : {}),
                });
            }

            await page.goto('/next-actions');
            await usePageClarifyMode(page);
            await expect(page.getByTestId('nextActionItemRow').first()).toBeVisible();

            const savedScrollTop = await scrollListToMiddle(page);
            expect(savedScrollTop).toBeGreaterThan(200);
            // Windowed rendering: rows near the new offset mount a frame or two after the
            // programmatic scroll — wait until the viewport is actually populated.
            await expect.poll(async () => (await fullyVisibleRowTitles(page, 'Reorder item 00'.length)).length).toBeGreaterThanOrEqual(2);
            const [clickedTitle, neighborTitle] = await fullyVisibleRowTitles(page, 'Reorder item 00'.length);
            if (!clickedTitle || !neighborTitle) throw new Error('expected at least two fully visible rows');
            // Mid-list must land inside the dated block (or clearing the date would not reorder)
            // and below the first row (so unmoved rows exist above the clicked one too).
            expect(Number(clickedTitle.slice(-2))).toBeLessThanOrEqual(28);
            expect(Number(clickedTitle.slice(-2))).toBeGreaterThanOrEqual(2);

            // dispatchEvent instead of click(): see the comment in the first test.
            await page.getByTestId('nextActionItemRow').filter({ hasText: clickedTitle }).dispatchEvent('click');
            await expect(page).toHaveURL(/\/item\/[^/]+/);

            const expectedByField = page.getByLabel('Expected by');
            await expect(expectedByField).toHaveValue(/\d{4}-\d{2}-\d{2}/);
            await expectedByField.fill('');
            await page.getByRole('button', { name: 'Save changes' }).click();
            await expect(page).toHaveURL(/\/next-actions$/);

            // The edited item moved to the no-date tier, but the viewport must NOT follow it:
            // the surviving neighbors keep the list at (approximately) the saved position.
            await expect.poll(async () => Math.abs((await readListScrollTop(page)) - savedScrollTop)).toBeLessThan(150);
            await expect(page.getByTestId('nextActionItemRow').filter({ hasText: neighborTitle })).toBeInViewport();
            await expect(page.getByTestId('nextActionItemRow').filter({ hasText: clickedTitle })).not.toBeInViewport();
        });
    });

    test('calendar list restores its position when returning within the sticky window', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `scroll-calendar-${dayjs().valueOf()}@example.com`, async (page) => {
            for (let i = 1; i <= 30; i++) {
                const inbox = await gtd.collect(page, `Cal restore ${String(i).padStart(2, '0')}`);
                await gtd.clarifyToCalendar(page, inbox, {
                    timeStart: dayjs().add(i, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString(),
                    timeEnd: dayjs().add(i, 'day').hour(9).minute(30).second(0).millisecond(0).toISOString(),
                });
            }

            await page.goto('/calendar');
            await expect(page.getByTestId('calendarItemRow').first()).toBeVisible();
            const savedScrollTop = await scrollListToMiddle(page);
            expect(savedScrollTop).toBeGreaterThan(200);

            await page.getByRole('link', { name: 'Next Actions' }).click();
            await expect(page).toHaveURL(/\/next-actions$/);
            await expect.poll(() => readListScrollTop(page)).toBe(0);

            await page.getByRole('link', { name: 'Calendar' }).click();
            await expect(page).toHaveURL(/\/calendar$/);
            await expect(page.getByTestId('calendarItemRow').first()).toBeVisible();
            await expect.poll(async () => Math.abs((await readListScrollTop(page)) - savedScrollTop)).toBeLessThan(150);
        });
    });

    test('reloading the page restores the scroll position', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `scroll-reload-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedNextActions(page, 35, 'Reload item');

            await page.goto('/next-actions');
            await expect(page.getByTestId('nextActionItemRow').first()).toBeVisible();
            const savedScrollTop = await scrollListToMiddle(page);
            expect(savedScrollTop).toBeGreaterThan(200);

            // The rAF-throttled capture mirrors positions to sessionStorage — wait for the
            // write to land so the reload has something to hydrate from.
            await expect.poll(() => page.evaluate(() => sessionStorage.getItem('gtd:listScrollPositions') ?? '')).toContain('/next-actions');

            await page.reload();
            await expect(page.getByTestId('nextActionItemRow').first()).toBeVisible();
            await expect.poll(async () => Math.abs((await readListScrollTop(page)) - savedScrollTop)).toBeLessThan(150);
        });
    });

    test('back from an item page returns to the filtered list URL', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `scroll-filters-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedNextActions(page, 2, 'Filtered item');

            await page.goto('/next-actions');
            await usePageClarifyMode(page);
            await page.getByTestId('nextActionsEnergyFilterChip').filter({ hasText: 'Low energy' }).click();
            await expect(page).toHaveURL(/energy=low/);

            await page.getByTestId('nextActionItemRow').filter({ hasText: 'Filtered item 01' }).click();
            await expect(page).toHaveURL(/\/item\/[^/]+/);

            // Real history-back: the filter search params survive the round-trip.
            await page.getByRole('button', { name: 'Go back' }).click();
            await expect(page).toHaveURL(/\/next-actions\?.*energy=low/);
            await expect(page.getByTestId('nextActionItemRow').filter({ hasText: 'Filtered item 01' })).toBeVisible();
        });
    });
});
