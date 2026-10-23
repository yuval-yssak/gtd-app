import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { CLARIFY_MODE_KEY } from '../client/src/lib/clarifyMode';
import { compareByRank } from '../client/src/lib/compareNextActions';
import type { StoredItem } from '../client/src/types/MyDB';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Manual order beyond Next Actions (docs/plans/priority-everywhere.md, Phase A): the Inbox, Someday / Maybe and
// Waiting For's "By date" view (inside a day) reorder with the same drag, keyboard grab, Alt+arrows and Move to
// as Next Actions; the Calendar stays chronological (no handles). Plus the item editor's shortcuts and the
// keyboard-shortcuts button on every screen. Order is asserted on screen (row boxes top→bottom) AND in storage.

async function geometricOrder(page: Page, rowTestId: string): Promise<string[]> {
    const rows = page.getByTestId(rowTestId);
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

/** Stored rows of a status in their manual order (the order the page renders inside one section). */
async function storedOrder(page: Page, status: StoredItem['status']): Promise<string[]> {
    return (await gtd.listItems(page))
        .filter((item) => item.status === status)
        .sort(compareByRank)
        .map((item) => item.title);
}

const rowOf = (page: Page, testId: string, title: string) => page.getByTestId(testId).filter({ hasText: title });

test.describe('Ranked lists: Inbox, Someday / Maybe, Waiting For by date', () => {
    test('inbox: Space grabs a row, ↑ moves it, Space drops; the order persists; Alt+Shift+↓ sends a row to the bottom', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `rl-inbox-${dayjs().valueOf()}@example.com`, async (page) => {
            for (const title of ['Alpha', 'Bravo', 'Charlie']) {
                await gtd.collect(page, title);
            }
            await gtd.flush(page);
            await page.goto('/inbox');
            await page.waitForSelector('text=Alpha');
            // A fresh capture lands on top: untouched, the inbox is newest-first.
            expect(await geometricOrder(page, 'inboxItemRow')).toEqual(['Charlie', 'Bravo', 'Alpha']);

            await rowOf(page, 'inboxItemRow', 'Alpha').focus();
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowUp');
            await expect(page.getByTestId('inboxReorderLive')).toHaveText('Alpha — position 2 of 3');
            await page.keyboard.press('Space');
            await expect.poll(() => geometricOrder(page, 'inboxItemRow')).toEqual(['Charlie', 'Alpha', 'Bravo']);
            await expect.poll(() => storedOrder(page, 'inbox')).toEqual(['Charlie', 'Alpha', 'Bravo']);

            await rowOf(page, 'inboxItemRow', 'Charlie').focus();
            await page.keyboard.press('Alt+Shift+ArrowDown');
            await expect.poll(() => storedOrder(page, 'inbox')).toEqual(['Alpha', 'Bravo', 'Charlie']);

            await gtd.flush(page);
            await page.reload();
            await page.waitForSelector('text=Alpha');
            expect(await geometricOrder(page, 'inboxItemRow')).toEqual(['Alpha', 'Bravo', 'Charlie']);
        });
    });

    test('inbox: the Move to button and a mouse drag of the handle both reorder', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `rl-inbox-mouse-${dayjs().valueOf()}@example.com`, async (page) => {
            const [alpha] = [await gtd.collect(page, 'Alpha'), await gtd.collect(page, 'Bravo'), await gtd.collect(page, 'Charlie')];
            if (!alpha) throw new Error('seed');
            await gtd.flush(page);
            await page.goto('/inbox');
            await page.waitForSelector('text=Alpha');

            await page.locator(`[data-item-id="${alpha._id}"]`).getByTestId('inboxItemMoveToButton').click();
            await page.getByTestId('nextActionMoveToTop').click();
            await expect.poll(() => storedOrder(page, 'inbox')).toEqual(['Alpha', 'Charlie', 'Bravo']);

            // Mouse: drag Alpha's handle below Bravo.
            const handle = page.locator(`[data-item-id="${alpha._id}"]`).getByTestId('inboxDragHandle');
            await handle.hover();
            const box = await handle.boundingBox();
            const target = await rowOf(page, 'inboxItemRow', 'Bravo').boundingBox();
            if (!box || !target) throw new Error('no boxes');
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 4, { steps: 2 });
            await page.mouse.move(box.x + box.width / 2, target.y + target.height - 4, { steps: 15 });
            await page.waitForTimeout(300);
            await page.mouse.up();
            await expect.poll(() => storedOrder(page, 'inbox')).toEqual(['Charlie', 'Bravo', 'Alpha']);
        });
    });

    test('inbox on a phone: the bottom sheet offers Move to…', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `rl-inbox-phone-${dayjs().valueOf()}@example.com`,
            async (page) => {
                for (const title of ['Alpha', 'Bravo']) {
                    await gtd.collect(page, title);
                }
                await gtd.flush(page);
                await page.goto('/inbox');
                await page.waitForSelector('text=Alpha');
                await page
                    .getByRole('button', { name: /more actions/i })
                    .last()
                    .click();
                await page.getByTestId('inboxSheetMoveTo').click();
                await expect(page.getByTestId('nextActionMoveToSheet')).toBeVisible();
                await page.getByTestId('nextActionMoveToTop').click();
                await expect.poll(() => storedOrder(page, 'inbox')).toEqual(['Alpha', 'Bravo']);
            },
            { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
        );
    });

    test('someday: Alt+↑ commits one slot; the order survives a reload', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `rl-someday-${dayjs().valueOf()}@example.com`, async (page) => {
            for (const title of ['Alpha', 'Bravo', 'Charlie']) {
                await gtd.clarifyToSomedayMaybe(page, await gtd.collect(page, title), {});
            }
            await gtd.flush(page);
            await page.goto('/someday');
            await page.waitForSelector('text=Alpha');
            await rowOf(page, 'somedayItemRow', 'Alpha').focus();
            await page.keyboard.press('Alt+ArrowUp');
            await expect(page.getByTestId('somedayReorderLive')).toHaveText('Moved Alpha — position 2 of 3');
            await expect.poll(() => storedOrder(page, 'somedayMaybe')).toEqual(['Charlie', 'Alpha', 'Bravo']);
            await gtd.flush(page);
            await page.reload();
            await page.waitForSelector('text=Alpha');
            expect(await geometricOrder(page, 'somedayItemRow')).toEqual(['Charlie', 'Alpha', 'Bravo']);
        });
    });

    test('waiting for by date: day sections, reorder inside a day, a jump never leaves its day; by person has no handles', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `rl-waiting-${dayjs().valueOf()}@example.com`, async (page) => {
            const day = dayjs().add(3, 'day').format('YYYY-MM-DD');
            const later = dayjs().add(5, 'day').format('YYYY-MM-DD');
            for (const [title, expectedBy] of [
                ['Ask Ann', day],
                ['Ask Ben', day],
                ['Ask Cat', later],
            ] as const) {
                await gtd.clarifyToWaitingFor(page, await gtd.collect(page, title), { expectedBy });
            }
            await gtd.flush(page);
            await page.goto('/waiting-for?sortBy=date');
            await page.waitForSelector('text=Ask Ann');
            await expect(page.getByTestId('waitingForSectionHeader')).toHaveCount(2);

            // Inside the first day: Ben (newest, top) and Ann. Ann to the top of her day.
            const before = await geometricOrder(page, 'waitingForItemRow');
            expect(before).toEqual(['Ask Ben', 'Ask Ann', 'Ask Cat']);
            await rowOf(page, 'waitingForItemRow', 'Ask Ann').focus();
            await page.keyboard.press('Alt+Shift+ArrowUp');
            await expect.poll(() => geometricOrder(page, 'waitingForItemRow')).toEqual(['Ask Ann', 'Ask Ben', 'Ask Cat']);
            // Ben jumps to the bottom of HIS day — never past Cat, who is on another day.
            await rowOf(page, 'waitingForItemRow', 'Ask Ben').focus();
            await page.keyboard.press('Alt+Shift+ArrowDown');
            await page.waitForTimeout(300);
            expect(await geometricOrder(page, 'waitingForItemRow')).toEqual(['Ask Ann', 'Ask Ben', 'Ask Cat']);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i.title === 'Ask Ben')?.expectedBy).toBe(day);

            await page.getByTestId('waitingForSortByPerson').click();
            await expect(page.getByTestId('waitingForDragHandle')).toHaveCount(0);
        });
    });

    test('the calendar stays chronological: no drag handles, no Move to', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `rl-calendar-${dayjs().valueOf()}@example.com`, async (page) => {
            const start = dayjs().add(1, 'day').hour(9).minute(0).second(0);
            await gtd.clarifyToCalendar(page, await gtd.collect(page, 'Meeting'), {
                timeStart: start.toISOString(),
                timeEnd: start.add(1, 'hour').toISOString(),
            });
            await gtd.flush(page);
            await page.goto('/calendar');
            await page.waitForSelector('text=Meeting');
            await expect(page.getByRole('button', { name: 'Reorder' })).toHaveCount(0);
            await expect(page.getByRole('button', { name: 'Move to…' })).toHaveCount(0);
        });
    });
});

test.describe('Item editor shortcuts and the legend everywhere', () => {
    test('a status letter picks its chip (outside a text field), Cmd/Ctrl+Enter saves, chips name their key', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ed-keys-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Decide later');
            await gtd.flush(page);
            await page.goto(`/item/${item._id}`);
            const nextAction = page.getByRole('button', { name: 'Next Action' });
            await expect(nextAction).toBeVisible();
            await nextAction.hover();
            await expect(page.getByRole('tooltip')).toHaveText('Next Action (n)');
            await page.mouse.move(0, 0);

            // Typing in the title is typing: "s" stays a letter.
            const title = page.getByRole('textbox', { name: 'Title' });
            await title.click();
            await title.press('End');
            await page.keyboard.type('s');
            await expect(title).toHaveValue('Decide laters');

            // Outside a text field, "s" picks Someday / Maybe.
            await page
                .locator('.MuiChip-root')
                .filter({ hasText: /^Inbox$/ })
                .focus();
            await page.keyboard.press('s');
            await expect(page.getByRole('button', { name: 'Someday / Maybe' })).toHaveClass(/MuiChip-filled/);

            // Cmd/Ctrl+Enter from the title field saves the new status.
            await title.click();
            await page.keyboard.press('ControlOrMeta+Enter');
            await expect.poll(async () => (await gtd.listItems(page)).find((i) => i._id === item._id)?.status).toBe('somedayMaybe');
            // The title typed just before the status letter is saved too (the letter can land in the same
            // tick as the title autosave's echo; the merge must neither undo the pick nor drop the text).
            await expect.poll(async () => (await gtd.listItems(page)).find((i) => i._id === item._id)?.title).toBe('Decide laters');
        });
    });

    test("after a click on the editor's empty space (focus leaves the title), a status letter still picks its chip", async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ed-blank-click-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Click away');
            await gtd.flush(page);
            await page.goto(`/item/${item._id}`);
            const title = page.getByRole('textbox', { name: 'Title' });
            await title.click();
            // The Status caption is plain text: clicking it would drop focus to the page body, where the
            // editor's own key handler never sees the letter.
            await page.getByText('Status', { exact: true }).click();
            await expect(title).not.toBeFocused();
            await page.keyboard.press('n');
            await expect(page.getByRole('button', { name: 'Next Action' })).toHaveClass(/MuiChip-filled/);
        });
    });

    test('in an inbox item, Alt+Shift+↓ (focus outside a text field) moves it to the bottom of the inbox', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ed-position-${dayjs().valueOf()}@example.com`, async (page) => {
            const items = [];
            for (const title of ['Alpha', 'Bravo', 'Charlie']) {
                items.push(await gtd.collect(page, title));
            }
            await gtd.flush(page);
            const charlie = items[2];
            if (!charlie) throw new Error('seed');
            await page.goto(`/item/${charlie._id}`);
            const position = page.getByTestId('nextActionPositionRow');
            await expect(position).toContainText('Position in Inbox');
            await expect(position.getByTestId('nextActionPositionText')).toHaveText('1 of 3');
            await expect(position.getByTestId('nextActionPositionUp')).toHaveAttribute('title', /Up \((⌥|Alt\+)↑\)/);
            await page
                .locator('.MuiChip-root')
                .filter({ hasText: /^Inbox$/ })
                .focus();
            await page.keyboard.press('Alt+Shift+ArrowDown');
            await expect(position.getByTestId('nextActionPositionText')).toHaveText('3 of 3');
            await expect.poll(() => storedOrder(page, 'inbox')).toEqual(['Bravo', 'Alpha', 'Charlie']);
        });
    });

    test('the keyboard-shortcuts button is on every screen and opens the legend', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `legend-all-${dayjs().valueOf()}@example.com`, async (page) => {
            for (const path of ['/inbox', '/calendar', '/routines', '/people', '/settings']) {
                await page.goto(path);
                const button = page.locator('[data-testid="keyboardShortcutsButton"]:visible');
                await expect(button, path).toHaveCount(1);
                await button.click();
                await expect(page.getByTestId('keyboardShortcutsDialog'), path).toContainText('In the item editor');
                await page.keyboard.press('Escape');
                await expect(page.getByTestId('keyboardShortcutsDialog')).toHaveCount(0);
            }
        });
    });

    test('a letter typed in an open dropdown inside the editor jumps the menu — it never switches the status', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ed-portal-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createPerson(page, { name: 'Sam' });
            const item = await gtd.clarifyToWaitingFor(page, await gtd.collect(page, 'Waiting on a reply'), {});
            await gtd.flush(page);
            await page.goto(`/item/${item._id}`);
            await page.getByRole('combobox', { name: 'Waiting for (optional)' }).click();
            await expect(page.getByRole('listbox')).toBeVisible();
            // "s" would pick Someday / Maybe in the editor; inside the menu it is the menu's type-ahead.
            await page.keyboard.press('s');
            await page.keyboard.press('Escape');
            await expect(page.locator('.MuiChip-root').filter({ hasText: /^Waiting For$/ })).toHaveClass(/MuiChip-filled/);
            await expect(page.locator('.MuiChip-root').filter({ hasText: /^Someday \/ Maybe$/ })).not.toHaveClass(/MuiChip-filled/);
        });
    });

    test('an inline editor inside the inbox list: d picks Done in the editor — the row is not marked done, nothing is copied', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ed-inline-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Inline target');
            await gtd.flush(page);
            await page.goto('/inbox');
            await page.waitForSelector('text=Inline target');
            await page.evaluate((key) => window.localStorage.setItem(key, 'expand'), CLARIFY_MODE_KEY);
            await rowOf(page, 'inboxItemRow', 'Inline target').click();
            const chip = page.locator('.MuiChip-root').filter({ hasText: /^Inbox$/ });
            await expect(chip).toBeVisible();
            await chip.focus();
            await page.keyboard.press('d');
            await expect(page.locator('.MuiChip-root').filter({ hasText: /^Done$/ })).toHaveClass(/MuiChip-filled/);
            await page.keyboard.press('c');
            await expect(page.locator('.MuiChip-root').filter({ hasText: /^Calendar$/ })).toHaveClass(/MuiChip-filled/);
            await expect(page.getByTestId('quickCaptureDialog')).toHaveCount(0);
            await expect(page.getByTestId('inboxItemCopyIdButtonFeedback')).toHaveCount(0);
            expect((await gtd.listItems(page)).find((i) => i._id === item._id)?.status).toBe('inbox');
        });
    });

    test('in the Process Inbox wizard Cmd/Ctrl+Enter does nothing (the wizard owns its save) and no Position row shows', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ed-wizard-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Wizard target');
            await gtd.flush(page);
            await page.goto('/process-inbox');
            const title = page.getByRole('textbox', { name: 'Title' });
            await expect(title).toHaveValue('Wizard target');
            await expect(page.getByTestId('nextActionPositionRow')).toHaveCount(0);
            await page
                .locator('.MuiChip-root')
                .filter({ hasText: /^Someday \/ Maybe$/ })
                .click();
            await title.click();
            await page.keyboard.press('ControlOrMeta+Enter');
            await page.waitForTimeout(500);
            expect((await gtd.listItems(page)).find((i) => i._id === item._id)?.status).toBe('inbox');
        });
    });

    test('on a phone, no keyboard-shortcuts button is shown (touch has no shortcuts)', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `legend-phone-${dayjs().valueOf()}@example.com`,
            async (page) => {
                await page.goto('/inbox');
                // The app bar is up (so the absence below is not vacuous)…
                await expect(page.getByRole('button', { name: 'open navigation' })).toBeVisible();
                await expect(page.locator('[data-testid="keyboardShortcutsButton"]:visible')).toHaveCount(0);
            },
            { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
        );
    });
});

test.describe('Ranked lists: keyboard grab downwards keeps focus; Waiting For by person keeps its letters', () => {
    test('inbox and waiting-for (by date): Space, ↓ ↓, Space moves the row down and it keeps focus', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `rl-down-${dayjs().valueOf()}@example.com`, async (page) => {
            for (const title of ['Alpha', 'Bravo', 'Charlie']) {
                await gtd.collect(page, title);
            }
            const day = dayjs().add(2, 'day').format('YYYY-MM-DD');
            for (const title of ['Wait A', 'Wait B', 'Wait C']) {
                await gtd.clarifyToWaitingFor(page, await gtd.collect(page, title), { expectedBy: day });
            }
            await gtd.flush(page);
            const focusedTitle = () => page.evaluate(() => (document.activeElement?.closest('[data-item-id]')?.textContent ?? '').trim());

            await page.goto('/inbox');
            await page.waitForSelector('text=Alpha');
            await rowOf(page, 'inboxItemRow', 'Charlie').focus();
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Space');
            await expect.poll(() => storedOrder(page, 'inbox')).toEqual(['Bravo', 'Alpha', 'Charlie']);
            await expect.poll(focusedTitle).toMatch(/^Charlie/);

            await page.goto('/waiting-for?sortBy=date');
            await page.waitForSelector('text=Wait A');
            await rowOf(page, 'waitingForItemRow', 'Wait C').focus();
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Space');
            await expect.poll(() => geometricOrder(page, 'waitingForItemRow')).toEqual(['Wait B', 'Wait A', 'Wait C']);
            await expect.poll(focusedTitle).toMatch(/^Wait C/);
        });
    });

    test('waiting for by person: E opens the editor and C copies the id on a focused row', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `rl-person-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
            const item = await gtd.clarifyToWaitingFor(page, await gtd.collect(page, 'Owed by nobody'), {});
            await gtd.flush(page);
            await page.goto('/waiting-for');
            await page.waitForSelector('text=Owed by nobody');
            await rowOf(page, 'waitingForItemRow', 'Owed by nobody').focus();
            await page.keyboard.press('c');
            await expect(page.getByTestId('waitingForItemCopyIdButtonFeedback')).toContainText(item._id);
            await rowOf(page, 'waitingForItemRow', 'Owed by nobody').focus();
            await page.keyboard.press('e');
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Owed by nobody');
        });
    });
});
