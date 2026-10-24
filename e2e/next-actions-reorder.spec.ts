import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredItem } from '../client/src/types/MyDB';
import { withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

// Phase 3 — desktop reorder on /next-actions: native pointer drag from the row handle, keyboard
// grab mode (Space / arrows / Space / Escape) and the Alt+arrow nudge. Every assertion that is
// about ORDER checks geometry (row bounding boxes top→bottom), not just text, and the persisted
// `rank` keys — a text-only check would pass with the rows merely re-painted.

const rowTitles = async (page: Page) => (await page.getByTestId('nextActionItemRow').allInnerTexts()).map((t) => t.split('\n')[0]?.trim() ?? '');

/** Row titles ordered by their rendered y position — the geometric order on screen. */
async function geometricOrder(page: Page): Promise<string[]> {
    const rows = page.getByTestId('nextActionItemRow');
    const count = await rows.count();
    const entries = await Promise.all(
        Array.from({ length: count }, async (_, i) => {
            const row = rows.nth(i);
            const box = await row.boundingBox();
            return { y: box?.y ?? Number.POSITIVE_INFINITY, title: ((await row.innerText()).split('\n')[0] ?? '').trim() };
        }),
    );
    return entries.sort((a, b) => a.y - b.y).map((entry) => entry.title);
}

async function seedUndated(page: Page, titles: string[]): Promise<StoredItem[]> {
    const items: StoredItem[] = [];
    for (const title of titles) {
        items.push(await gtd.clarifyToNextAction(page, await gtd.collect(page, title), {}));
    }
    await gtd.flush(page);
    return items;
}

const handleOf = (page: Page, itemId: string) => page.locator(`[data-item-id="${itemId}"]`).getByTestId('nextActionDragHandle');

async function rowCenterY(page: Page, title: string): Promise<number> {
    const box = await page.getByTestId('nextActionItemRow').filter({ hasText: title }).boundingBox();
    if (!box) throw new Error(`no row for ${title}`);
    return box.y + box.height / 2;
}

/** Resolves once `scrollY` has not changed for 300 ms — the browser's own scroll animations (wheel, smooth) have ended. */
async function waitForScrollRest(page: Page): Promise<void> {
    let previous = await page.evaluate(() => window.scrollY);
    for (let attempt = 0; attempt < 20; attempt++) {
        await page.waitForTimeout(150);
        const next = await page.evaluate(() => window.scrollY);
        if (next === previous) {
            await page.waitForTimeout(150);
            if ((await page.evaluate(() => window.scrollY)) === next) {
                return;
            }
        }
        previous = next;
    }
    throw new Error('scroll never came to rest');
}

/**
 * The handle's bounding box once it is settled: two reads 100 ms apart agree AND the element is
 * what a hit test at its centre returns. virtua remounts rows for a few frames after a scroll jump
 * (a freshly mounted row is laid out but not yet hit-testable), so a press aimed at a box that is
 * merely laid out can land on the bare list behind it.
 */
async function settledHandleBox(page: Page, handle: ReturnType<Page['locator']>): Promise<{ x: number; y: number; width: number; height: number }> {
    let previous = await handle.boundingBox();
    for (let attempt = 0; attempt < 30; attempt++) {
        await page.waitForTimeout(100);
        const next = await handle.boundingBox();
        if (!previous || !next || previous.y !== next.y || previous.x !== next.x) {
            previous = next;
            continue;
        }
        const isHit = await handle.evaluate((el, point) => document.elementsFromPoint(point.x, point.y).includes(el), {
            x: next.x + next.width / 2,
            y: next.y + next.height / 2,
        });
        if (isHit) {
            return next;
        }
        previous = next;
    }
    throw new Error('drag handle never settled');
}

/** Mouse drag from the handle of `itemId` to `targetY`, in steps so every pointermove re-targets.
 *  `pauseMs` holds the pointer still before releasing — long enough for the displaced rows' shift
 *  transition to finish, which is when a geometry read that included its own transform would lie. */
async function mouseDrag(page: Page, itemId: string, targetY: number, pauseMs = 0): Promise<void> {
    const handle = handleOf(page, itemId);
    // Bounded so a hover that cannot settle reports WHY (occluded / unstable) instead of "Test ended".
    await handle.hover({ timeout: 5_000 });
    const box = await settledHandleBox(page, handle);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 2, { steps: 2 });
    await page.mouse.move(x, targetY, { steps: 15 });
    if (pauseMs > 0) {
        await page.waitForTimeout(pauseMs);
    }
    await page.mouse.up();
}

async function rankOf(page: Page, itemId: string): Promise<string> {
    const items = await gtd.listItems(page);
    return items.find((i) => i._id === itemId)?.rank ?? '';
}

test.describe('Next actions — reorder (desktop)', () => {
    test('mouse drag moves an undated item from 4th to 2nd; the order survives a reload and reaches a second device', async ({ browser }) => {
        await withTwoLoggedInDevices(browser, `na-reorder-drag-${dayjs().valueOf()}@example.com`, async (page, other) => {
            const [a, b, c, d] = await seedUndated(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']); // newest first: Delta, Charlie, Bravo, Alpha
            if (!a || !b || !c || !d) throw new Error('seed');
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            expect(await geometricOrder(page)).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha']);

            // Drop Alpha between Delta and Charlie: just above Charlie's midpoint.
            await mouseDrag(page, a._id, (await rowCenterY(page, 'Charlie')) - 8);
            await expect.poll(() => geometricOrder(page)).toEqual(['Delta', 'Alpha', 'Charlie', 'Bravo']);

            // One field on one item: Alpha's rank sits strictly between Delta's and Charlie's; the rest are untouched.
            const [rankA, rankC, rankD] = await Promise.all([rankOf(page, a._id), rankOf(page, c._id), rankOf(page, d._id)]);
            expect(rankD < rankA && rankA < rankC).toBe(true);
            expect(rankC).toBe(c.rank);
            expect(rankD).toBe(d.rank);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === a._id)?.expectedBy).toBeUndefined();

            await gtd.flush(page);
            await page.reload();
            await page.waitForSelector('text=Alpha');
            expect(await geometricOrder(page)).toEqual(['Delta', 'Alpha', 'Charlie', 'Bravo']);

            await gtd.pull(other);
            await other.goto('/next-actions');
            await other.waitForSelector('text=Alpha');
            expect(await geometricOrder(other)).toEqual(['Delta', 'Alpha', 'Charlie', 'Bravo']);
        });
    });

    test('a drag across a section header snaps back and writes nothing; a completed drop does not open the editor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-reorder-wall-${dayjs().valueOf()}@example.com`, async (page) => {
            const today = dayjs().format('YYYY-MM-DD');
            const dated = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Dated today'), { expectedBy: today });
            const [a, _b] = await seedUndated(page, ['Alpha', 'Bravo']); // Today: Dated today | No date: Bravo, Alpha
            if (!a) throw new Error('seed');
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            expect(await rowTitles(page)).toEqual(['Dated today', 'Bravo', 'Alpha']);

            // Drag Alpha up past the "No date" header onto the Today row and release there.
            await mouseDrag(page, a._id, (await rowCenterY(page, 'Dated today')) - 4);
            await expect(page.getByTestId('nextActionsReorderLive')).toHaveText('Reorder cancelled');
            expect(await rowTitles(page)).toEqual(['Dated today', 'Bravo', 'Alpha']);
            expect(await gtd.queuedOps(page)).toHaveLength(0);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === a._id)?.expectedBy).toBeUndefined();
            expect(items.find((i) => i._id === a._id)?.rank).toBe(a.rank);
            expect(items.find((i) => i._id === dated._id)?.expectedBy).toBe(today);

            // A completed drop inside the section must not open the item editor.
            await mouseDrag(page, a._id, (await rowCenterY(page, 'Bravo')) - 8);
            await expect.poll(() => rowTitles(page)).toEqual(['Dated today', 'Alpha', 'Bravo']);
            await page.waitForTimeout(400);
            await expect(page.getByTestId('itemPageWrapper')).toHaveCount(0);
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveCount(0);
        });
    });

    test('keyboard: Space lifts, arrows move, Space drops, Escape cancels; Alt+Up nudges one slot', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-reorder-keys-${dayjs().valueOf()}@example.com`, async (page) => {
            const [a, _b, _c, d] = await seedUndated(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']); // Delta, Charlie, Bravo, Alpha
            if (!a || !d) throw new Error('seed');
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            const live = page.getByTestId('nextActionsReorderLive');

            // Grab Alpha (4th), move up twice, drop → 2nd.
            await handleOf(page, a._id).focus();
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowUp');
            await expect(live).toHaveText('Alpha — position 3 of 4');
            await page.keyboard.press('ArrowUp');
            await expect(live).toHaveText('Alpha — position 2 of 4');
            await page.keyboard.press('Space');
            await expect.poll(() => geometricOrder(page)).toEqual(['Delta', 'Alpha', 'Charlie', 'Bravo']);
            await expect(live).toHaveText('Moved Alpha — position 2 of 4');

            // Escape cancels a grab without writing.
            await gtd.flush(page);
            await handleOf(page, d._id).focus();
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Escape');
            await expect(live).toHaveText('Reorder cancelled');
            expect(await geometricOrder(page)).toEqual(['Delta', 'Alpha', 'Charlie', 'Bravo']);
            expect(await gtd.queuedOps(page)).toHaveLength(0);

            // Alt+ArrowUp on the focused row commits one slot immediately.
            await page.getByTestId('nextActionItemRow').filter({ hasText: 'Bravo' }).focus();
            await page.keyboard.press('Alt+ArrowUp');
            await expect.poll(() => geometricOrder(page)).toEqual(['Delta', 'Alpha', 'Bravo', 'Charlie']);
            await expect(live).toHaveText('Moved Bravo — position 3 of 4');
        });
    });

    test('D5: dragging under an active filter mints the key between the VISIBLE neighbours', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-reorder-filter-${dayjs().valueOf()}@example.com`, async (page) => {
            const low1 = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Low one'), { energy: 'low' });
            const high = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'High between'), { energy: 'high' });
            const low2 = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Low two'), { energy: 'low' });
            const low3 = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Low three'), { energy: 'low' });
            await gtd.flush(page);
            // Full order (newest first): Low three, Low two, High between, Low one.
            await page.goto('/next-actions?energy=low');
            await page.waitForSelector('text=Low one');
            expect(await rowTitles(page)).toEqual(['Low three', 'Low two', 'Low one']);

            // Drag Low one between Low three and Low two (High between is hidden).
            await mouseDrag(page, low1._id, (await rowCenterY(page, 'Low two')) - 8);
            await expect.poll(() => rowTitles(page)).toEqual(['Low three', 'Low one', 'Low two']);
            const rank = await rankOf(page, low1._id);
            expect((low3.rank ?? '') < rank && rank < (low2.rank ?? '')).toBe(true);
            // Unfiltered, the hidden row keeps its own place below Low two.
            await page.goto('/next-actions');
            await page.waitForSelector('text=High between');
            expect(await rowTitles(page)).toEqual(['Low three', 'Low one', 'Low two', 'High between']);
            expect(await rankOf(page, high._id)).toBe(high.rank);
        });
    });

    test('a drop between two rows that share a rank succeeds (the section is re-keyed first)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-reorder-shared-${dayjs().valueOf()}@example.com`, async (page) => {
            const [a, b, c] = await seedUndated(page, ['Alpha', 'Bravo', 'Charlie']);
            if (!a || !b || !c) throw new Error('seed');
            // Two devices minting "top" offline would both produce the same key — seed that state,
            // with Alpha below them so the drop is a real move.
            await gtd.updateItem(page, { ...a, rank: 'a1' });
            await gtd.updateItem(page, { ...b, rank: 'a0' });
            await gtd.updateItem(page, { ...c, rank: 'a0' });
            await gtd.flush(page);
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            const before = await rowTitles(page); // Bravo/Charlie share 'a0' → their order is by _id, i.e. arbitrary; Alpha last
            expect(before[2]).toBe('Alpha');
            const target = before.filter((title) => title !== 'Alpha'); // the two shared-rank rows, in display order
            if (target.length !== 2) throw new Error('rows');

            // Drop Alpha between the two shared-rank rows.
            await mouseDrag(page, a._id, (await rowCenterY(page, target[1] ?? '')) - 8);
            await expect.poll(() => rowTitles(page)).toEqual([target[0], 'Alpha', target[1]]);
            await gtd.flush(page);
            const items = await gtd.listItems(page);
            const ranks = [target[0], 'Alpha', target[1]].map((title) => items.find((i) => i.title === title)?.rank ?? '');
            expect(ranks.every(Boolean)).toBe(true);
            expect(ranks[0] < ranks[1] && ranks[1] < ranks[2]).toBe(true);
        });
    });

    test("drops at the top and at the bottom slot land after a pause (the measured geometry excludes the rows' own shift)", async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-reorder-edges-${dayjs().valueOf()}@example.com`, async (page) => {
            const [a, _b, _c, d] = await seedUndated(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']); // Delta, Charlie, Bravo, Alpha
            if (!a || !d) throw new Error('seed');
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');

            // Alpha (last) to the very top, holding still for longer than the shift transition before releasing.
            await mouseDrag(page, a._id, (await rowCenterY(page, 'Delta')) - 12, 400);
            await expect.poll(() => geometricOrder(page)).toEqual(['Alpha', 'Delta', 'Charlie', 'Bravo']);

            // Delta (now 2nd) to the very bottom, same pause.
            await mouseDrag(page, d._id, (await rowCenterY(page, 'Bravo')) + 12, 400);
            await expect.poll(() => geometricOrder(page)).toEqual(['Alpha', 'Charlie', 'Bravo', 'Delta']);
            await gtd.flush(page);
            expect(await gtd.queuedOps(page)).toHaveLength(0);
        });
    });

    test('Escape mid-drag snaps back; a grab abandoned by scrolling away still lets the next gesture work', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `na-reorder-recover-${dayjs().valueOf()}@example.com`,
            async (page) => {
                const titles = Array.from({ length: 14 }, (_, i) => `Row ${String(i).padStart(2, '0')}`);
                const items = await seedUndated(page, titles); // displayed newest first: Row 13 … Row 00
                const oldest = items[0]; // 'Row 00', the bottom row
                const newest = items[13]; // 'Row 13', the top row
                if (!newest || !oldest) throw new Error('seed');
                await page.goto('/next-actions');
                await page.waitForSelector('text=Row 13');
                const live = page.getByTestId('nextActionsReorderLive');

                // Escape during a pointer drag on the bottom row — scrolled into virtua's range first
                // (an unmounted row has no handle to hover).
                await page.mouse.wheel(0, 6000);
                await expect(page.getByTestId('nextActionItemRow').filter({ hasText: 'Row 00' })).toBeVisible();
                const handle = handleOf(page, oldest._id);
                await handle.hover();
                const box = await handle.boundingBox();
                if (!box) throw new Error('no handle box');
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                await page.mouse.down();
                await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 8 });
                await page.keyboard.press('Escape');
                await page.mouse.up();
                await expect(live).toHaveText('Reorder cancelled');
                expect(await gtd.queuedOps(page)).toHaveLength(0);
                expect(await page.evaluate(() => document.body.classList.contains('nextActionsDragging'))).toBe(false);

                // Grab with the keyboard, then scroll far away (the handle leaves virtua's range) and click elsewhere.
                await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
                await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
                await handleOf(page, newest._id).focus();
                await page.keyboard.press('Space');
                await page.keyboard.press('ArrowDown');
                await expect(live).toHaveText('Row 13 — position 2 of 14');
                await page.mouse.wheel(0, 6000);
                // A wheel scroll animates; let it come to rest before cancelling and scrolling back, or the
                // tail of the animation keeps moving the rows under the next gesture's measured handle.
                await waitForScrollRest(page);
                await page.mouse.click(5, 5);
                await expect(live).toHaveText('Reorder cancelled');
                // The page is not stuck: a fresh pointer drag works.
                await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
                // The cancelled grab hands focus back once virtua remounts the row, and its scrollIntoView
                // can nudge the page a pixel (always, in Chromium ≥156) — let it land, then reset.
                await expect(handleOf(page, newest._id)).toBeFocused();
                await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
                await waitForScrollRest(page);
                expect(await page.evaluate(() => window.scrollY)).toBe(0);
                await page.waitForSelector('text=Row 13');
                await mouseDrag(page, newest._id, (await rowCenterY(page, 'Row 11')) - 8);
                await expect.poll(async () => (await rowTitles(page)).slice(0, 3)).toEqual(['Row 12', 'Row 13', 'Row 11']);
            },
            // A short viewport so the list scrolls (and virtua unmounts) with a modest seed.
            { viewport: { width: 1000, height: 420 } },
        );
    });

    test('a bare press-and-release on the handle announces nothing and writes nothing; Tab away from a grab cancels it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-reorder-noop-${dayjs().valueOf()}@example.com`, async (page) => {
            const [a, _b, _c] = await seedUndated(page, ['Alpha', 'Bravo', 'Charlie']);
            if (!a) throw new Error('seed');
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            const live = page.getByTestId('nextActionsReorderLive');

            await handleOf(page, a._id).click();
            await page.waitForTimeout(300);
            await expect(live).toHaveText('');
            expect(await gtd.queuedOps(page)).toHaveLength(0);

            // Grab, move, then Tab out of the row: the grab ends and the next Space must not drop anything.
            await handleOf(page, a._id).focus();
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowUp');
            await expect(live).toHaveText('Alpha — position 2 of 3');
            await page.getByTestId('nextActionsSearchButton').focus();
            await expect(live).toHaveText('Reorder cancelled');
            await page.keyboard.press('Space');
            await page.waitForTimeout(300);
            expect(await rowTitles(page)).toEqual(['Charlie', 'Bravo', 'Alpha']);
            expect(await gtd.queuedOps(page)).toHaveLength(0);
        });
    });

    test('Enter lifts into grab mode; Alt+Down nudges down; rapid Alt+Up presses apply in order', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-reorder-keys2-${dayjs().valueOf()}@example.com`, async (page) => {
            const [a, _b, _c, d] = await seedUndated(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']); // Delta, Charlie, Bravo, Alpha
            if (!a || !d) throw new Error('seed');
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            const live = page.getByTestId('nextActionsReorderLive');

            await handleOf(page, d._id).focus();
            await page.keyboard.press('Enter');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            await expect.poll(() => geometricOrder(page)).toEqual(['Charlie', 'Delta', 'Bravo', 'Alpha']);
            await expect(live).toHaveText('Moved Delta — position 2 of 4');

            await page.getByTestId('nextActionItemRow').filter({ hasText: 'Charlie' }).focus();
            await page.keyboard.press('Alt+ArrowDown');
            await expect.poll(() => geometricOrder(page)).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha']);

            // Three quick nudges on Alpha: commits are serialised, so it climbs three slots, not one.
            await page.getByTestId('nextActionItemRow').filter({ hasText: 'Alpha' }).focus();
            await page.keyboard.press('Alt+ArrowUp');
            await page.keyboard.press('Alt+ArrowUp');
            await page.keyboard.press('Alt+ArrowUp');
            await expect.poll(() => geometricOrder(page), { timeout: 10_000 }).toEqual(['Alpha', 'Delta', 'Charlie', 'Bravo']);
            await gtd.flush(page);
            expect(await gtd.queuedOps(page)).toHaveLength(0);
        });
    });
});
