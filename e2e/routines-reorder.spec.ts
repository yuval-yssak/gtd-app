import { expect, type Page, test } from '@playwright/test';
import { compareRank } from '../client/src/lib/itemRank';
import type { StoredRoutine } from '../client/src/types/MyDB';
import { withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// The /routines manual order: each frequency group (Daily, Weekly, …) reorders with the same drag,
// keyboard and "Move to…" as Next Actions. A group never reordered shows its old interval-then-title
// order; the first move keys it. Order is asserted on screen (row boxes top→bottom) AND in storage.

const DAILY = { routineType: 'nextAction' as const, rrule: 'FREQ=DAILY', template: {}, active: true };
const WEEKLY = { routineType: 'nextAction' as const, rrule: 'FREQ=WEEKLY;BYDAY=MO', template: {}, active: true };

async function seedRoutines(page: Page) {
    for (const title of ['Alpha', 'Bravo', 'Charlie']) {
        await gtd.createRoutine(page, { ...DAILY, title });
    }
    await gtd.createRoutine(page, { ...WEEKLY, title: 'Weekly review' });
    await gtd.flush(page); // never navigate mid-flush — see CLAUDE.md § E2E
}

const routineRow = (page: Page, title: string) => page.getByTestId('routineRow').filter({ hasText: title });

async function geometricOrder(page: Page): Promise<string[]> {
    const rows = page.getByTestId('routineRow');
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

/** The daily routines in their stored manual order (all ranked once the group was reordered). */
function dailyStoredOrder(routines: StoredRoutine[]): string[] {
    return routines
        .filter((routine) => routine.rrule === 'FREQ=DAILY')
        .sort((a, b) => compareRank(a.rank ?? '', b.rank ?? ''))
        .map((routine) => routine.title);
}

test.describe('Routines page — manual order within a frequency group', () => {
    test('Alt+Shift+↑ moves a routine to the top of its group; the order survives a reload and never crosses groups', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routines-reorder-${uniqueStamp()}@example.com`, async (page) => {
            await seedRoutines(page);
            await page.goto('/routines');
            await expect.poll(() => geometricOrder(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Weekly review']);

            await routineRow(page, 'Charlie').focus();
            await page.keyboard.press('Alt+Shift+ArrowUp');
            await expect(page.getByTestId('routinesReorderLive')).toHaveText('Moved Charlie — position 1 of 3');
            await expect.poll(async () => dailyStoredOrder(await gtd.listRoutines(page))).toEqual(['Charlie', 'Alpha', 'Bravo']);

            // The bottom of Daily is as far as a jump goes — Weekly stays its own group.
            await routineRow(page, 'Alpha').focus();
            await page.keyboard.press('Alt+Shift+ArrowDown');
            await expect.poll(() => geometricOrder(page)).toEqual(['Charlie', 'Bravo', 'Alpha', 'Weekly review']);

            await gtd.flush(page);
            await page.reload();
            await expect.poll(() => geometricOrder(page)).toEqual(['Charlie', 'Bravo', 'Alpha', 'Weekly review']);
        });
    });

    test('the Move to… button and a mouse drag of the handle both reorder', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routines-reorder-mouse-${uniqueStamp()}@example.com`, async (page) => {
            await seedRoutines(page);
            await page.goto('/routines');
            await expect.poll(() => geometricOrder(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Weekly review']);

            await page.locator('[data-item-id]').filter({ hasText: 'Charlie' }).getByTestId('routineRowMoveToButton').click();
            await page.getByTestId('nextActionMoveToTop').click();
            await expect.poll(() => geometricOrder(page)).toEqual(['Charlie', 'Alpha', 'Bravo', 'Weekly review']);

            // Mouse: drag Charlie's handle below Alpha.
            const handle = page.locator('[data-item-id]').filter({ hasText: 'Charlie' }).getByTestId('routineDragHandle');
            await handle.hover();
            const box = await handle.boundingBox();
            const target = await routineRow(page, 'Alpha').boundingBox();
            if (!box || !target) {
                throw new Error('no boxes');
            }
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 4, { steps: 2 });
            await page.mouse.move(box.x + box.width / 2, target.y + target.height - 4, { steps: 15 });
            await page.waitForTimeout(300);
            await page.mouse.up();
            await expect.poll(async () => dailyStoredOrder(await gtd.listRoutines(page))).toEqual(['Alpha', 'Charlie', 'Bravo']);
            await expect.poll(() => geometricOrder(page)).toEqual(['Alpha', 'Charlie', 'Bravo', 'Weekly review']);
        });
    });

    // The second press commits behind the first, possibly before it re-rendered — it must still land.
    test('Alt+↑ then Alt+↓ at once returns the routine to where it was', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routines-reorder-rapid-${uniqueStamp()}@example.com`, async (page) => {
            await seedRoutines(page);
            await page.goto('/routines');
            await expect.poll(() => geometricOrder(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Weekly review']);

            await routineRow(page, 'Charlie').focus();
            await page.keyboard.press('Alt+ArrowUp');
            await page.keyboard.press('Alt+ArrowDown');

            await expect.poll(async () => dailyStoredOrder(await gtd.listRoutines(page))).toEqual(['Alpha', 'Bravo', 'Charlie']);
            await expect.poll(() => geometricOrder(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Weekly review']);
        });
    });

    test('Space grabs a routine, ↑ moves it, Space drops it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routines-reorder-grab-${uniqueStamp()}@example.com`, async (page) => {
            await seedRoutines(page);
            await page.goto('/routines');
            await expect.poll(() => geometricOrder(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Weekly review']);

            await routineRow(page, 'Bravo').focus();
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowUp');
            await page.keyboard.press('Space');

            await expect.poll(async () => dailyStoredOrder(await gtd.listRoutines(page))).toEqual(['Bravo', 'Alpha', 'Charlie']);
        });
    });

    // Under a search only part of a group shows: the move lands next to the visible neighbour and
    // the hidden routines keep their place in the group.
    test('a reorder under a title search keeps the hidden routines in place', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routines-reorder-search-${uniqueStamp()}@example.com`, async (page) => {
            for (const title of ['Water plants', 'Read', 'Water garden', 'Stretch']) {
                await gtd.createRoutine(page, { ...DAILY, title });
            }
            await gtd.flush(page);
            await page.goto('/routines');
            // Untouched order is interval-then-title.
            await expect.poll(() => geometricOrder(page)).toEqual(['Read', 'Stretch', 'Water garden', 'Water plants']);

            await page.goto('/routines?q=water');
            await expect.poll(() => geometricOrder(page)).toEqual(['Water garden', 'Water plants']);
            await routineRow(page, 'Water plants').focus();
            await page.keyboard.press('Alt+ArrowUp');
            await expect.poll(() => geometricOrder(page)).toEqual(['Water plants', 'Water garden']);

            await page.goto('/routines');
            await expect.poll(() => geometricOrder(page)).toEqual(['Read', 'Stretch', 'Water plants', 'Water garden']);
        });
    });

    test('paused routines sit outside the manual order — no drag handle, no Move to…', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routines-reorder-paused-${uniqueStamp()}@example.com`, async (page) => {
            await gtd.createRoutine(page, { ...DAILY, title: 'Running' });
            await gtd.createRoutine(page, { ...DAILY, title: 'Resting', active: false });
            await gtd.flush(page);
            await page.goto('/routines');
            await page.getByTestId('routinePausedSectionToggle').click();

            const pausedRow = page.locator('[data-list-item-id]').filter({ hasText: 'Resting' });
            await expect(pausedRow.getByTestId('routineRowResumeButton')).toBeVisible();
            await expect(pausedRow.getByTestId('routineDragHandle')).toHaveCount(0);
            await expect(pausedRow.getByTestId('routineRowMoveToButton')).toHaveCount(0);
            await expect(page.locator('[data-list-item-id]').filter({ hasText: 'Running' }).getByTestId('routineDragHandle')).toBeVisible();
        });
    });

    // The rank rides the routine's sync op: the server accepts it (no jammed queue) and another
    // device shows the same order.
    test('the new order syncs to another device', async ({ browser }) => {
        await withTwoLoggedInDevices(browser, `routines-reorder-sync-${uniqueStamp()}@example.com`, async (page1, page2) => {
            await seedRoutines(page1);
            await page1.goto('/routines');
            await routineRow(page1, 'Charlie').focus();
            await page1.keyboard.press('Alt+Shift+ArrowUp');
            await expect.poll(async () => dailyStoredOrder(await gtd.listRoutines(page1))).toEqual(['Charlie', 'Alpha', 'Bravo']);
            await gtd.flush(page1);

            await gtd.pull(page2);
            await page2.goto('/routines');
            await expect.poll(() => geometricOrder(page2)).toEqual(['Charlie', 'Alpha', 'Bravo', 'Weekly review']);
        });
    });
});
