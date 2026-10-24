import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { compareNextActions } from '../client/src/lib/compareNextActions';
import type { StoredItem } from '../client/src/types/MyDB';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Keyboard experiment on /next-actions (branch exp/next-actions-keyboard): one tab stop for the
// whole list with ↑/↓ walking the rows and letters pressing the row buttons; Shift+arrow jumps in
// grab mode and Alt+Shift+arrow commits a jump; the grabbed row is RENDERED at its slot (no
// transform overlap); the "Move to…" sheet on desktop; the editor's Position row. Order assertions
// read geometry (row boxes top→bottom), never just text.

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

/** True when two rendered rows overlap vertically — the bug a transform-based keyboard move had. */
async function hasOverlappingRows(page: Page): Promise<boolean> {
    const boxes = (await Promise.all((await page.getByTestId('nextActionItemRow').all()).map((row) => row.boundingBox()))).flatMap((box) => (box ? [box] : []));
    const sorted = boxes.sort((a, b) => a.y - b.y);
    return sorted.some((box, i) => {
        const next = sorted[i + 1];
        return next !== undefined && next.y < box.y + box.height - 1;
    });
}

async function seedUndated(page: Page, titles: string[]): Promise<StoredItem[]> {
    const items: StoredItem[] = [];
    for (const title of titles) {
        items.push(await gtd.clarifyToNextAction(page, await gtd.collect(page, title), {}));
    }
    await gtd.flush(page);
    return items;
}

const rowOf = (page: Page, title: string) => page.getByTestId('nextActionItemRow').filter({ hasText: title });

/** Titles of the stored next actions in list order — for assertions while an expanded inline editor pushes rows out of virtua's range. */
async function storedOrder(page: Page): Promise<string[]> {
    const items = await gtd.listItems(page);
    return items
        .filter((item) => item.status === 'nextAction')
        .sort(compareNextActions)
        .map((item) => item.title);
}
const focusedRowTitle = (page: Page) =>
    page.evaluate(
        () =>
            (document.activeElement?.closest('[data-item-id]')?.querySelector('[data-testid="nextActionItemRow"]')?.textContent ?? '').split('\n')[0]?.trim() ??
            '',
    );
const focusedTestId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? '');

test.describe('Next actions — keyboard (one tab stop, jumps, preview order)', () => {
    test('Tab enters the list once; ↑/↓, Home/End walk the rows; → steps into the buttons; Tab leaves in one press', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-tab-${uniqueStamp()}@example.com`, async (page) => {
            await seedUndated(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']); // Delta, Charlie, Bravo, Alpha
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');

            // From the last control above the list (the "Show tags" switch), ONE Tab lands on the first
            // row — not on a handle, not on a copy button.
            await page.getByRole('switch', { name: 'Show tags' }).focus();
            await page.keyboard.press('Tab');
            await expect.poll(() => focusedRowTitle(page)).toBe('Delta');
            expect(await focusedTestId(page)).toBe('nextActionItemRow');

            await page.keyboard.press('ArrowDown');
            await expect.poll(() => focusedRowTitle(page)).toBe('Charlie');
            await page.keyboard.press('End');
            await expect.poll(() => focusedRowTitle(page)).toBe('Alpha');
            await page.keyboard.press('ArrowDown'); // clamps at the last row
            await expect.poll(() => focusedRowTitle(page)).toBe('Alpha');
            await page.keyboard.press('Home');
            await expect.poll(() => focusedRowTitle(page)).toBe('Delta');

            // → into the row's buttons, → along them, ← back past the first returns to the row.
            await page.keyboard.press('ArrowRight');
            await expect.poll(() => focusedTestId(page)).toBe('nextActionMoveToButton');
            await page.keyboard.press('ArrowRight');
            await expect.poll(() => focusedTestId(page)).toBe('nextActionItemCopyIdButton');
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('ArrowLeft');
            await expect.poll(() => focusedTestId(page)).toBe('nextActionItemRow');

            // One Tab leaves the whole list: none of the 4 rows × 5 controls is a tab stop.
            await page.keyboard.press('Tab');
            await expect.poll(() => focusedTestId(page)).not.toBe('nextActionItemRow');
            expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="nextActionsList"]') !== null)).toBe(false);

            // Shift+Tab comes back to the row that was focused last (Delta), not the first control of the list.
            await page.keyboard.press('Shift+Tab');
            await expect.poll(() => focusedRowTitle(page)).toBe('Delta');
        });
    });

    test('letters press the row buttons: E opens the editor, C copies the id, M opens Move to…; Enter opens, Space grabs', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-letters-${uniqueStamp()}@example.com`, async (page) => {
            await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
            const [a] = await seedUndated(page, ['Alpha', 'Bravo', 'Charlie']);
            if (!a) throw new Error('seed');
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');

            await rowOf(page, 'Alpha').focus();
            await page.keyboard.press('e');
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Alpha');
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('itemPageWrapper')).toHaveCount(0);

            await rowOf(page, 'Alpha').focus();
            await page.keyboard.press('c');
            await expect(page.getByTestId('nextActionItemCopyIdButtonFeedback')).toContainText(a._id);

            await rowOf(page, 'Alpha').focus();
            await page.keyboard.press('m');
            await expect(page.getByTestId('nextActionMoveToSheet')).toBeVisible();
            await page.getByTestId('nextActionMoveToCancel').click();
            await expect(page.getByTestId('nextActionMoveToSheet')).toBeHidden();

            // Space on the row grabs it (MUI's Space-click is suppressed — no editor), Space again drops with a write.
            await rowOf(page, 'Alpha').focus();
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowUp');
            await expect(page.getByTestId('nextActionsReorderLive')).toHaveText('Alpha — position 2 of 3');
            await page.keyboard.press('Space');
            await expect.poll(() => geometricOrder(page)).toEqual(['Charlie', 'Alpha', 'Bravo']);
            await page.waitForTimeout(300);
            await expect(page.getByTestId('itemPageWrapper')).toHaveCount(0);
            // Focus stays on the moved row after the drop.
            expect(await focusedRowTitle(page)).toBe('Alpha');

            // Enter still opens the row.
            await page.keyboard.press('Enter');
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('itemPageWrapper')).toHaveCount(0);

            // D marks the row done: it leaves the list, and focus moves on to the next live row (not the fading ghost).
            await rowOf(page, 'Bravo').focus();
            await page.keyboard.press('d');
            await expect.poll(async () => (await gtd.listItems(page)).find((i) => i.title === 'Bravo')?.status).toBe('done');
            await expect.poll(() => focusedRowTitle(page)).toBe('Alpha');
        });
    });

    test('keyboard grab renders the grabbed row AT its slot (no overlap); Shift+↓ jumps to the bottom; Escape puts it back', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-preview-${uniqueStamp()}@example.com`, async (page) => {
            await seedUndated(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']); // Delta, Charlie, Bravo, Alpha
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            const live = page.getByTestId('nextActionsReorderLive');

            await rowOf(page, 'Delta').focus();
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowDown');
            await expect(live).toHaveText('Delta — position 2 of 4');
            // The screenshot bug: the grabbed row stayed put while its neighbour slid onto it.
            await expect.poll(() => geometricOrder(page)).toEqual(['Charlie', 'Delta', 'Bravo', 'Alpha']);
            expect(await hasOverlappingRows(page)).toBe(false);
            expect(await focusedRowTitle(page)).toBe('Delta');

            await page.keyboard.press('Shift+ArrowDown');
            await expect(live).toHaveText('Delta — position 4 of 4');
            await expect.poll(() => geometricOrder(page)).toEqual(['Charlie', 'Bravo', 'Alpha', 'Delta']);
            expect(await hasOverlappingRows(page)).toBe(false);

            await page.keyboard.press('Shift+ArrowUp');
            await expect(live).toHaveText('Delta — position 1 of 4');
            await page.keyboard.press('End');
            await expect(live).toHaveText('Delta — position 4 of 4');

            await page.keyboard.press('Escape');
            await expect(live).toHaveText('Reorder cancelled');
            await expect.poll(() => geometricOrder(page)).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha']);
            expect(await gtd.queuedOps(page)).toHaveLength(0);
            expect(await focusedRowTitle(page)).toBe('Delta');

            // Drop at the bottom persists, and the rank reaches the server.
            await page.keyboard.press('Space');
            await page.keyboard.press('Shift+ArrowDown');
            await page.keyboard.press('Space');
            await expect(live).toHaveText('Moved Delta — position 4 of 4');
            await expect.poll(() => geometricOrder(page)).toEqual(['Charlie', 'Bravo', 'Alpha', 'Delta']);
            await gtd.flush(page);
            await page.reload();
            await page.waitForSelector('text=Alpha');
            expect(await geometricOrder(page)).toEqual(['Charlie', 'Bravo', 'Alpha', 'Delta']);
        });
    });

    test('Alt+Shift+↑ commits a jump to the top of the day, Alt+Shift+↓ to the bottom; the dated section is untouched', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-jump-${uniqueStamp()}@example.com`, async (page) => {
            const today = dayjs().format('YYYY-MM-DD');
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Dated today'), { expectedBy: today });
            await seedUndated(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']); // Today: Dated today | No date: Delta, Charlie, Bravo, Alpha
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            const live = page.getByTestId('nextActionsReorderLive');

            await rowOf(page, 'Alpha').focus();
            await page.keyboard.press('Alt+Shift+ArrowUp');
            await expect.poll(() => geometricOrder(page)).toEqual(['Dated today', 'Alpha', 'Delta', 'Charlie', 'Bravo']);
            await expect(live).toHaveText('Moved Alpha — position 1 of 4');

            // Already at the top: nothing is written.
            await gtd.flush(page);
            await rowOf(page, 'Alpha').focus();
            await page.keyboard.press('Alt+Shift+ArrowUp');
            await page.waitForTimeout(300);
            expect(await gtd.queuedOps(page)).toHaveLength(0);

            await rowOf(page, 'Delta').focus();
            await page.keyboard.press('Alt+Shift+ArrowDown');
            await expect.poll(() => geometricOrder(page)).toEqual(['Dated today', 'Alpha', 'Charlie', 'Bravo', 'Delta']);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i.title === 'Delta')?.expectedBy).toBeUndefined();
            expect(items.find((i) => i.title === 'Dated today')?.expectedBy).toBe(today);
        });
    });

    test('desktop: the row overflow button and a right-click on the handle open "Move to…"; Top of section moves the row', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-moveto-${uniqueStamp()}@example.com`, async (page) => {
            const [a, _b, c] = await seedUndated(page, ['Alpha', 'Bravo', 'Charlie']); // Charlie, Bravo, Alpha
            if (!a || !c) throw new Error('seed');
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');

            await page.locator(`[data-item-id="${a._id}"]`).getByTestId('nextActionMoveToButton').click();
            await expect(page.getByTestId('nextActionMoveToSheet')).toBeVisible();
            await page.getByTestId('nextActionMoveToTop').click();
            await expect.poll(() => geometricOrder(page)).toEqual(['Alpha', 'Charlie', 'Bravo']);

            await page.locator(`[data-item-id="${c._id}"]`).hover();
            await page.locator(`[data-item-id="${c._id}"]`).getByTestId('nextActionDragHandle').click({ button: 'right' });
            await expect(page.getByTestId('nextActionMoveToSheet')).toBeVisible();
            await page.getByTestId('nextActionMoveToBottom').click();
            await expect.poll(() => geometricOrder(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
        });
    });

    test("the editor's Position row moves the item (opened from the list and by URL); the chord legend opens", async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-position-${uniqueStamp()}@example.com`, async (page) => {
            const [a, _b, _c, d] = await seedUndated(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']); // Delta, Charlie, Bravo, Alpha
            if (!a || !d) throw new Error('seed');
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            await rowOf(page, 'Alpha').click();
            const position = page.getByTestId('nextActionPositionRow');
            await expect(position).toBeVisible();
            await expect(position.getByTestId('nextActionPositionText')).toHaveText('4 of 4');
            await expect(position.getByTestId('nextActionPositionBottom')).toBeDisabled();
            await position.getByTestId('nextActionPositionUp').click();
            await expect(position.getByTestId('nextActionPositionText')).toHaveText('3 of 4');
            await expect.poll(() => storedOrder(page)).toEqual(['Delta', 'Charlie', 'Alpha', 'Bravo']);
            await position.getByTestId('nextActionPositionTop').click();
            await expect(position.getByTestId('nextActionPositionText')).toHaveText('1 of 4');
            await expect(position.getByTestId('nextActionPositionTop')).toBeDisabled();
            await expect.poll(() => storedOrder(page)).toEqual(['Alpha', 'Delta', 'Charlie', 'Bravo']);

            // "Move to…" from the editor: below Charlie.
            await position.getByTestId('nextActionPositionMoveTo').click();
            await page.getByTestId('nextActionMoveToBelow').click();
            await page.getByTestId('nextActionMoveToTarget').filter({ hasText: 'Charlie' }).click();
            await expect.poll(() => storedOrder(page)).toEqual(['Delta', 'Charlie', 'Alpha', 'Bravo']);
            await expect(position.getByTestId('nextActionPositionText')).toHaveText('3 of 4');

            // The item page opened directly by URL offers the same row.
            await page.goto(`/item/${d._id}`);
            await expect(page.getByTestId('nextActionPositionRow')).toBeVisible();
            await page.getByTestId('nextActionPositionBottom').click();
            await expect(page.getByTestId('nextActionPositionText')).toHaveText('4 of 4');
            await gtd.flush(page);
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            expect(await geometricOrder(page)).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);

            await page.locator('[data-testid="keyboardShortcutsButton"]:visible').click();
            await expect(page.getByTestId('keyboardShortcutsDialog')).toContainText('Keyboard shortcuts');
            await page.keyboard.press('Escape');

            // An inbox item being clarified has no position yet: the row stays hidden until it is saved as a next action.
            const inbox = await gtd.collect(page, 'Fresh capture');
            await gtd.flush(page);
            await page.goto(`/item/${inbox._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Fresh capture');
            await page.getByRole('button', { name: 'Next Action' }).click();
            await expect(page.getByTestId('nextActionPositionRow')).toHaveCount(0);
        });
    });

    test('focus survives the moves: Alt+↓ twice without re-focusing moves two slots; a keyboard drop downwards keeps focus', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-focus-${uniqueStamp()}@example.com`, async (page) => {
            await seedUndated(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']); // Delta, Charlie, Bravo, Alpha
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            const live = page.getByTestId('nextActionsReorderLive');

            // Moving DOWN re-inserts the row's own DOM node (React keyed reconciliation), which drops focus unless it is given back.
            await rowOf(page, 'Delta').focus();
            await page.keyboard.press('Alt+ArrowDown');
            await expect(live).toHaveText('Moved Delta — position 2 of 4');
            await expect.poll(() => focusedRowTitle(page)).toBe('Delta');
            await page.keyboard.press('Alt+ArrowDown');
            await expect(live).toHaveText('Moved Delta — position 3 of 4');
            await expect.poll(() => geometricOrder(page)).toEqual(['Charlie', 'Bravo', 'Delta', 'Alpha']);
            await expect.poll(() => focusedRowTitle(page)).toBe('Delta');

            // Grab, move down, drop with Enter: the row lands, keeps focus, and Enter does NOT open the editor.
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            await expect(live).toHaveText('Moved Delta — position 4 of 4');
            await expect.poll(() => geometricOrder(page)).toEqual(['Charlie', 'Bravo', 'Alpha', 'Delta']);
            await expect.poll(() => focusedRowTitle(page)).toBe('Delta');
            await page.waitForTimeout(300);
            await expect(page.getByTestId('itemPageWrapper')).toHaveCount(0);
        });
    });

    test('a grab never steals focus back: Tab out of a grabbed row leaves the list; a click in the search field keeps it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-steal-${uniqueStamp()}@example.com`, async (page) => {
            await seedUndated(page, ['Alpha', 'Bravo', 'Charlie']);
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            const live = page.getByTestId('nextActionsReorderLive');
            const inList = () => page.evaluate(() => document.activeElement?.closest('[data-testid="nextActionsList"]') !== null);

            await rowOf(page, 'Bravo').focus();
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowUp');
            await expect(live).toHaveText('Bravo — position 1 of 3');
            await page.keyboard.press('Tab');
            await expect(live).toHaveText('Reorder cancelled');
            await page.waitForTimeout(200);
            expect(await inList()).toBe(false);

            await rowOf(page, 'Bravo').focus();
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowUp');
            await page.getByTestId('nextActionsSearchButton').click();
            await page.getByTestId('nextActionsSearchInput').click();
            await expect(live).toHaveText('Reorder cancelled');
            await page.waitForTimeout(200);
            await expect(page.getByTestId('nextActionsSearchInput')).toBeFocused();
            // Typing here must reach the field, not the row's letter shortcuts.
            await page.keyboard.type('d');
            await expect(page.getByTestId('nextActionsSearchInput')).toHaveValue('d');
            expect(await gtd.queuedOps(page)).toHaveLength(0);
        });
    });

    test('a long list: grab the first row, End, Escape returns it focused; Shift+↓ then Space drops it last', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-long-${uniqueStamp()}@example.com`, async (page) => {
            const titles = Array.from({ length: 40 }, (_, i) => `Row ${String(i + 1).padStart(2, '0')}`);
            await seedUndated(page, titles); // newest first: Row 40 … Row 01
            await page.goto('/next-actions');
            await page.waitForSelector('text=Row 40');
            const live = page.getByTestId('nextActionsReorderLive');
            // Virtualized: not every row is mounted.
            expect(await page.getByTestId('nextActionItemRow').count()).toBeLessThan(40);

            await rowOf(page, 'Row 40').focus();
            await page.keyboard.press('Space');
            await page.keyboard.press('End');
            await expect(live).toHaveText('Row 40 — position 40 of 40');
            await expect(rowOf(page, 'Row 40')).toBeInViewport();
            await page.keyboard.press('Escape');
            await expect(live).toHaveText('Reorder cancelled');
            await expect.poll(() => focusedRowTitle(page)).toBe('Row 40');
            await expect(rowOf(page, 'Row 40')).toBeInViewport();
            expect(await gtd.queuedOps(page)).toHaveLength(0);

            await page.keyboard.press('Space');
            await page.keyboard.press('Shift+ArrowDown');
            await page.keyboard.press('Space');
            await expect(live).toHaveText('Moved Row 40 — position 40 of 40');
            await expect.poll(() => focusedRowTitle(page)).toBe('Row 40');
            await expect.poll(() => storedOrder(page).then((order) => order.at(-1))).toBe('Row 40');
        });
    });

    test("D on a routine's item marks it done once, even when pressed twice; the ghost's buttons are gone", async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-done-twice-${uniqueStamp()}@example.com`, async (page) => {
            const today = dayjs().format('YYYY-MM-DD');
            const routine = await gtd.createRoutine(page, {
                title: 'Water plants',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
                startDate: today,
            });
            await gtd.materializePendingNextActionRoutines(page);
            await gtd.flush(page);
            await page.goto('/next-actions');
            await page.waitForSelector('text=Water plants');

            await rowOf(page, 'Water plants').focus();
            await page.keyboard.press('d');
            await page.keyboard.press('d');
            await expect.poll(async () => (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'done')).toHaveLength(1);
            await gtd.flush(page);
            const open = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'nextAction');
            expect(open).toHaveLength(1);
            // The ghost row offers no Edit / Done / Move to.
            const ghost = page.getByTestId('ghostListRow');
            await expect(ghost).toHaveCount(1);
            await expect(ghost.getByTestId('nextActionItemDoneButton')).toHaveCount(0);
            await expect(ghost.getByTestId('nextActionItemEditButton')).toHaveCount(0);
        });
    });

    test('Shift+Tab from a row leaves the list in one press (no pause on the container), Tab returns to the same row; Space on a button presses it', async ({
        browser,
    }) => {
        await withOneLoggedInDevice(browser, `na-kb-container-${uniqueStamp()}@example.com`, async (page) => {
            await seedUndated(page, ['Alpha', 'Bravo', 'Charlie']); // Charlie, Bravo, Alpha
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');

            await rowOf(page, 'Bravo').focus();
            await page.keyboard.press('Shift+Tab');
            // Straight into the filter bar (the region before the list), entered on its first chip.
            await expect.poll(() => focusedTestId(page)).toBe('nextActionsEnergyFilterChip');
            // Shift+Tab drops the list out of the tab order until a setTimeout puts it back; Chromium ≥156 can
            // run that timer after the focus move lands, so a machine-speed Tab would skip the list.
            await expect(page.locator('[data-keyboard-region][aria-label="Next actions"]')).toHaveAttribute('tabindex', '0');
            await page.keyboard.press('Tab');
            await expect.poll(() => focusedRowTitle(page)).toBe('Bravo');
            await page.keyboard.press('End');
            await expect.poll(() => focusedRowTitle(page)).toBe('Alpha');

            // → onto the Edit button, Space presses it (no grab), the editor opens.
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowRight');
            await expect.poll(() => focusedTestId(page)).toBe('nextActionItemEditButton');
            await page.keyboard.press('Space');
            // Landing on the item page is the proof: a grab would have kept the list on screen.
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
            await expect(page).toHaveURL(/\/item\//);
        });
    });

    test('D then a click into the search field: the field keeps focus (the hand-off never steals it)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-done-focus-${uniqueStamp()}@example.com`, async (page) => {
            await seedUndated(page, ['Alpha', 'Bravo', 'Charlie']);
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            await page.getByTestId('nextActionsSearchButton').click();
            await rowOf(page, 'Bravo').focus();
            await page.keyboard.press('d');
            await page.getByTestId('nextActionsSearchInput').click();
            await expect.poll(async () => (await gtd.listItems(page)).find((i) => i.title === 'Bravo')?.status).toBe('done');
            await page.waitForTimeout(400);
            await expect(page.getByTestId('nextActionsSearchInput')).toBeFocused();
        });
    });

    test('a slow items read (large account): commits wait for the RENDERED list — Alt+↓ twice moves two slots, a downward drop keeps focus', async ({
        browser,
    }) => {
        await withOneLoggedInDevice(browser, `na-kb-slow-${uniqueStamp()}@example.com`, async (page) => {
            await seedUndated(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']); // Delta, Charlie, Bravo, Alpha
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            // refreshItems() resolves when the transition STARTS; with a 300 ms read the refreshed list lands much later.
            await gtd.setItemsReadDelay(page, 300);
            const live = page.getByTestId('nextActionsReorderLive');

            await rowOf(page, 'Delta').focus();
            await page.keyboard.press('Alt+ArrowDown');
            await page.keyboard.press('Alt+ArrowDown');
            await expect.poll(() => geometricOrder(page), { timeout: 10_000 }).toEqual(['Charlie', 'Bravo', 'Delta', 'Alpha']);
            await expect(live).toHaveText('Moved Delta — position 3 of 4');
            await expect.poll(() => focusedRowTitle(page)).toBe('Delta');
            await page.waitForTimeout(500);
            expect(await focusedRowTitle(page)).toBe('Delta');

            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            await expect(live).toHaveText('Moved Delta — position 4 of 4', { timeout: 10_000 });
            await expect.poll(() => geometricOrder(page)).toEqual(['Charlie', 'Bravo', 'Alpha', 'Delta']);
            await page.waitForTimeout(500);
            expect(await focusedRowTitle(page)).toBe('Delta');
            await gtd.setItemsReadDelay(page, 0);
            await gtd.flush(page);
            expect(await gtd.queuedOps(page)).toHaveLength(0);
        });
    });

    test("the editor's Position row: a title typed just before Up survives alongside the move, and Top works offline", async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-position-flush-${uniqueStamp()}@example.com`, async (page) => {
            await seedUndated(page, ['Alpha', 'Bravo', 'Charlie']); // Charlie, Bravo, Alpha
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            await rowOf(page, 'Alpha').click();
            const position = page.getByTestId('nextActionPositionRow');
            await expect(position).toBeVisible();
            const title = page.getByRole('textbox', { name: 'Title' });
            await title.fill('Alpha renamed');
            // No wait for the autosave debounce: the move must flush the pending text itself.
            await position.getByTestId('nextActionPositionUp').click();
            await expect(position.getByTestId('nextActionPositionText')).toHaveText('2 of 3');
            await expect.poll(() => storedOrder(page)).toEqual(['Charlie', 'Alpha renamed', 'Bravo']);
            await gtd.flush(page);
            // Back on the list from scratch: the rename and the move both persisted.
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha renamed');
            expect(await storedOrder(page)).toEqual(['Charlie', 'Alpha renamed', 'Bravo']);

            // Offline, with an op already queued: the move must not wait on or fail with the network push.
            await page.context().setOffline(true);
            await gtd.collect(page, 'Offline capture');
            expect((await gtd.queuedOps(page)).length).toBeGreaterThan(0);
            await rowOf(page, 'Alpha renamed').click();
            await page.getByTestId('nextActionPositionTop').click();
            await expect(page.getByTestId('nextActionPositionText')).toHaveText('1 of 3', { timeout: 5_000 });
            await expect(page.getByText('Could not save the new position')).toHaveCount(0);
            await expect.poll(() => storedOrder(page)).toEqual(['Alpha renamed', 'Charlie', 'Bravo']);
            await page.context().setOffline(false);
        });
    });

    test("a slow items read: Done on a routine's only row, pressed twice 50 ms apart, still creates exactly one follow-up", async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-done-slow-${uniqueStamp()}@example.com`, async (page) => {
            const today = dayjs().format('YYYY-MM-DD');
            const routine = await gtd.createRoutine(page, {
                title: 'Water plants',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
                startDate: today,
            });
            await gtd.materializePendingNextActionRoutines(page);
            await gtd.flush(page);
            await page.goto('/next-actions');
            await page.waitForSelector('text=Water plants');
            // The refresh lands late: the row is still live (not a ghost) for a while after the first Done.
            await gtd.setItemsReadDelay(page, 300);

            await rowOf(page, 'Water plants').focus();
            await page.keyboard.press('d');
            await page.waitForTimeout(50);
            await page.keyboard.press('d');
            await expect
                .poll(async () => (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'done'), { timeout: 10_000 })
                .toHaveLength(1);
            await gtd.setItemsReadDelay(page, 0);
            await gtd.flush(page);
            const open = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'nextAction');
            expect(open).toHaveLength(1);
        });
    });

    test("a slow items read: the editor's Position Up, clicked twice quickly, moves two slots in order", async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-kb-position-slow-${uniqueStamp()}@example.com`, async (page) => {
            await seedUndated(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']); // Delta, Charlie, Bravo, Alpha
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            await gtd.setItemsReadDelay(page, 300);

            await rowOf(page, 'Alpha').click();
            const position = page.getByTestId('nextActionPositionRow');
            await expect(position.getByTestId('nextActionPositionText')).toHaveText('4 of 4');
            const up = position.getByTestId('nextActionPositionUp');
            await up.click();
            // Disabled while the first move is pending — the second press waits for the refreshed section.
            await expect(up).toBeDisabled();
            await expect(up).toBeEnabled({ timeout: 10_000 });
            await expect(position.getByTestId('nextActionPositionText')).toHaveText('3 of 4');
            await up.click();
            await expect(position.getByTestId('nextActionPositionText')).toHaveText('2 of 4', { timeout: 10_000 });
            await gtd.setItemsReadDelay(page, 0);
            await expect.poll(() => storedOrder(page)).toEqual(['Delta', 'Alpha', 'Charlie', 'Bravo']);
        });
    });

    test('Done still works for a row that changed status on another page moments ago (the ghost guard matches the snapshot, not the id)', async ({
        browser,
    }) => {
        await withOneLoggedInDevice(browser, `na-kb-done-ghost-${uniqueStamp()}@example.com`, async (page) => {
            const parked = await gtd.clarifyToSomedayMaybe(page, await gtd.collect(page, 'Parked'), {});
            await gtd.flush(page);
            await page.goto('/someday');
            await page.waitForSelector('text=Parked');
            // The status change happens through the editor on this page (its ghost, with the OLD status,
            // stays in the shared store); no reload afterwards — a reload would wipe the store and hide the bug.
            await page.getByTestId('somedayItemRow').filter({ hasText: 'Parked' }).click();
            const editor = page.getByTestId('itemPageWrapper');
            await editor.getByRole('button', { name: 'Next Action' }).click();
            await editor.getByRole('button', { name: 'Save changes' }).click();
            await expect(editor).toBeHidden();
            await page.getByRole('link', { name: 'Next Actions' }).click();
            // Two steps so a failure under load says which one stalled: the navigation or the list render.
            await expect(page).toHaveURL(/\/next-actions/);
            await expect(rowOf(page, 'Parked')).toBeVisible({ timeout: 15_000 });

            await rowOf(page, 'Parked').focus();
            await page.keyboard.press('d');
            await expect.poll(async () => (await gtd.listItems(page)).find((i) => i._id === parked._id)?.status).toBe('done');
        });
    });
});
