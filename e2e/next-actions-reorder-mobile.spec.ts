import { type CDPSession, expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredItem } from '../client/src/types/MyDB';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { longPressDrag, PHONE, touch } from './helpers/touch';

// Phase 4 — mobile reorder. Playwright's `touchscreen` only taps, so the long-press drag is driven
// through CDP `Input.dispatchTouchEvent`. A phone context (touch + coarse pointer) also turns on the
// always-visible handle and the "Move to…" overflow (one `(hover: none) and (pointer: coarse)` predicate).
const rowTitles = async (page: Page) => (await page.getByTestId('nextActionItemRow').allInnerTexts()).map((t) => t.split('\n')[0]?.trim() ?? '');

async function seedUndated(page: Page, titles: string[]): Promise<StoredItem[]> {
    const items: StoredItem[] = [];
    for (const title of titles) {
        items.push(await gtd.clarifyToNextAction(page, await gtd.collect(page, title), {}));
    }
    await gtd.flush(page);
    return items;
}

async function rowCenterY(page: Page, title: string): Promise<number> {
    const box = await page.getByTestId('nextActionItemRow').filter({ hasText: title }).boundingBox();
    if (!box) throw new Error(`no row for ${title}`);
    return box.y + box.height / 2;
}

/** Long-press the row's handle, glide to `targetY`, release. */
async function longPressDragRow(page: Page, cdp: CDPSession, itemId: string, targetY: number): Promise<void> {
    await longPressDrag(page, cdp, page.locator(`[data-item-id="${itemId}"]`).getByTestId('nextActionDragHandle'), targetY);
}

test.describe('Next actions — mobile reorder', () => {
    test('long-press on the handle drags a row to a new slot; the order persists', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `na-mobile-drag-${dayjs().valueOf()}@example.com`,
            async (page) => {
                const [a, _b, _c] = await seedUndated(page, ['Alpha', 'Bravo', 'Charlie']); // displayed newest first: Charlie, Bravo, Alpha
                await page.goto('/next-actions');
                await page.waitForSelector('text=Alpha');
                expect(await rowTitles(page)).toEqual(['Charlie', 'Bravo', 'Alpha']);
                await expect(page.getByTestId('nextActionDragHandle').first()).toBeVisible();

                const cdp = await page.context().newCDPSession(page);
                // Drop Alpha just above Charlie's midpoint → slot 0.
                if (!a) throw new Error('seed');
                await longPressDragRow(page, cdp, a._id, (await rowCenterY(page, 'Charlie')) - 10);
                await expect.poll(() => rowTitles(page)).toEqual(['Alpha', 'Charlie', 'Bravo']);
                await gtd.flush(page);
                await page.reload();
                await page.waitForSelector('text=Alpha');
                expect(await rowTitles(page)).toEqual(['Alpha', 'Charlie', 'Bravo']);
            },
            PHONE,
        );
    });

    test('a vertical swipe on the row body scrolls the page instead of dragging', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `na-mobile-swipe-${dayjs().valueOf()}@example.com`,
            async (page) => {
                const titles = Array.from({ length: 30 }, (_, i) => `Scroll row ${String(i).padStart(2, '0')}`);
                await seedUndated(page, titles);
                await page.goto('/next-actions');
                await page.waitForSelector('text=Scroll row 29');
                const before = await rowTitles(page);
                const cdp = await page.context().newCDPSession(page);
                const y = await rowCenterY(page, 'Scroll row 27');
                const row = page.getByTestId('nextActionItemRow').filter({ hasText: 'Scroll row 27' });
                const box = await row.boundingBox();
                if (!box) throw new Error('no row box');
                const x = box.x + box.width / 2;
                await touch(cdp, 'touchStart', [{ x, y }]);
                for (let i = 1; i <= 10; i++) {
                    await touch(cdp, 'touchMove', [{ x, y: y - i * 40 }]);
                    await page.waitForTimeout(16);
                }
                await touch(cdp, 'touchEnd', []);
                await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(50);
                await gtd.flush(page);
                expect(await gtd.queuedOps(page)).toHaveLength(0);
                await page.evaluate(() => window.scrollTo(0, 0));
                // Poll: virtua remounts the top rows a frame after the scroll lands.
                await expect.poll(async () => (await rowTitles(page)).slice(0, 5)).toEqual(before.slice(0, 5));
            },
            PHONE,
        );
    });

    test('"Move to…" sheet: top / bottom / above a picked item, all within the section', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `na-mobile-sheet-${dayjs().valueOf()}@example.com`,
            async (page) => {
                const [a, _b, _c, _d] = await seedUndated(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']); // Delta, Charlie, Bravo, Alpha
                const today = dayjs().format('YYYY-MM-DD');
                await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Dated today'), { expectedBy: today });
                await gtd.flush(page);
                await page.goto('/next-actions');
                await page.waitForSelector('text=Alpha');
                if (!a) throw new Error('seed');
                const alphaRow = page.locator(`[data-item-id="${a._id}"]`);

                // Top of section.
                await alphaRow.getByTestId('nextActionMoveToButton').click();
                await expect(page.getByTestId('nextActionMoveToSheet')).toBeVisible();
                await page.getByTestId('nextActionMoveToTop').click();
                await expect.poll(() => rowTitles(page)).toEqual(['Dated today', 'Alpha', 'Delta', 'Charlie', 'Bravo']);
                // The sheet goes through the same commit path as a drag: queued, and announced.
                await expect(page.getByTestId('nextActionsReorderLive')).toHaveText('Moved Alpha — position 1 of 4');

                // Bottom of section.
                await alphaRow.getByTestId('nextActionMoveToButton').click();
                await page.getByTestId('nextActionMoveToBottom').click();
                await expect.poll(() => rowTitles(page)).toEqual(['Dated today', 'Delta', 'Charlie', 'Bravo', 'Alpha']);

                // Above a picked item, found through the search field; the picker never offers the other section.
                await alphaRow.getByTestId('nextActionMoveToButton').click();
                await page.getByTestId('nextActionMoveToAbove').click();
                await expect(page.getByTestId('nextActionMoveToTarget')).toHaveCount(3);
                await page.getByTestId('nextActionMoveToSearch').fill('char');
                await expect(page.getByTestId('nextActionMoveToTarget')).toHaveCount(1);
                await page.getByTestId('nextActionMoveToTarget').click();
                await expect.poll(() => rowTitles(page)).toEqual(['Dated today', 'Delta', 'Alpha', 'Charlie', 'Bravo']);

                await gtd.flush(page);
                const items = await gtd.listItems(page);
                expect(items.find((i) => i._id === a._id)?.expectedBy).toBeUndefined();
            },
            PHONE,
        );
    });
});
