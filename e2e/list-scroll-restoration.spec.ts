import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// List pages share one <main> scroll container. Leaving a list saves its position
// (keyed by location, 5-minute sticky window) and returning restores it, re-anchored
// on the topmost visible row. An item that just left the list renders once as a faded
// "ghost" row that lingers briefly and collapses away.

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
 * Title of a row FULLY visible in the viewport. Clicking a partially-visible row makes
 * Playwright auto-scroll (center) it first, moving the position the app then faithfully
 * saves — the assertion would compare against a stale pre-click offset.
 */
async function fullyVisibleRowTitle(page: Page): Promise<string> {
    return page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-list-item-id]')];
        const anchor = rows.find((row) => {
            const rect = row.getBoundingClientRect();
            return rect.top > 10 && rect.bottom < window.innerHeight - 10;
        });
        const title = anchor?.querySelector('[data-testid="nextActionItemRow"]')?.textContent;
        if (!title) throw new Error('no fully visible next-action row found');
        return title.slice(0, 'Restore item 00'.length);
    });
}

test.describe('List scroll restoration + ghost rows', () => {
    test('marking an item done on its page and coming back restores the position and fades a ghost', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `scroll-restore-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedNextActions(page, 35, 'Restore item');

            await page.goto('/next-actions');
            await usePageClarifyMode(page);
            await expect(page.getByTestId('nextActionItemRow')).toHaveCount(35);

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
            await expect(page.getByTestId('nextActionItemRow')).toHaveCount(35);
            const savedScrollTop = await scrollListToMiddle(page);
            expect(savedScrollTop).toBeGreaterThan(200);

            // A list never visited this session starts at the top, not at the inherited offset.
            await page.getByRole('link', { name: 'Someday / Maybe' }).click();
            await expect(page).toHaveURL(/\/someday$/);
            await expect.poll(() => readListScrollTop(page)).toBe(0);

            // Returning via the nav (not back-navigation) is still "within the flow" — position sticks.
            await page.getByRole('link', { name: 'Next Actions' }).click();
            await expect(page).toHaveURL(/\/next-actions$/);
            await expect(page.getByTestId('nextActionItemRow')).toHaveCount(35);
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
