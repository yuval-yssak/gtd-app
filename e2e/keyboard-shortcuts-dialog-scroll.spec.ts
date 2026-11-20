import { expect, type Locator, type Page, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { uniqueStamp } from './helpers/uniqueStamp';

// The shortcuts legend is longer than a laptop screen and holds no controls — the keyboard must
// still scroll it (WCAG scrollable-region-focusable), the same keys as any scrolling page.

async function openLegend(page: Page) {
    await page.goto('/next-actions');
    // `?` before the authenticated shell mounts its shortcut listener would be a lost keypress.
    await expect(page.getByRole('heading', { name: 'Next Actions', level: 1 })).toBeVisible();
    await page.locator('body').click();
    await page.keyboard.press('Shift+?');
    await expect(page.getByTestId('keyboardShortcutsDialog')).toBeVisible();
}

function scrollTopOf(list: Locator) {
    return list.evaluate((element) => element.scrollTop);
}

test.describe('Keyboard shortcuts legend', () => {
    test.use({ viewport: { width: 1000, height: 500 } });

    test('opens with its list focused, and the keyboard scrolls it down and back up', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `kb-legend-scroll-${uniqueStamp()}@example.com`, async (page) => {
            await openLegend(page);

            const list = page.getByTestId('keyboardShortcutsList');
            await expect(list).toBeFocused();
            // The test only means something while the list overflows the short viewport.
            expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

            await page.keyboard.press('ArrowDown');
            await expect.poll(() => scrollTopOf(list)).toBeGreaterThan(0);
            await page.keyboard.press('End');
            await expect.poll(() => list.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true);
            await page.keyboard.press('Home');
            await expect.poll(() => scrollTopOf(list)).toBe(0);
            await page.keyboard.press('PageDown');
            await expect.poll(() => scrollTopOf(list)).toBeGreaterThan(0);
        });
    });

    test('Escape still closes the legend from the focused list', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `kb-legend-esc-${uniqueStamp()}@example.com`, async (page) => {
            await openLegend(page);
            await expect(page.getByTestId('keyboardShortcutsList')).toBeFocused();

            await page.keyboard.press('Escape');
            await expect(page.getByTestId('keyboardShortcutsDialog')).toHaveCount(0);
        });
    });
});
