import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Tooltips teach their keyboard shortcut ("Copy item ID (c)"), and the letters they teach work on a
// focused row of every list page — not only Next Actions: C copies the id, E opens the editor.

/** Hovers a control and returns the text of the tooltip it opens. */
async function tooltipOf(page: Page, testId: string): Promise<string> {
    // The first VISIBLE match: some controls are mounted twice (the sidebar and the hidden mobile drawer).
    await page.locator(`[data-testid="${testId}"]:visible`).first().hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    const text = (await tooltip.innerText()).trim();
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
    return text;
}

test.describe('Row shortcut tooltips', () => {
    test('inbox: the row buttons name their key; C on a focused row copies the id (not quick capture), E opens the editor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `tips-inbox-${uniqueStamp()}@example.com`, async (page) => {
            await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
            const item = await gtd.collect(page, 'Inbox tip target');
            await gtd.flush(page);
            await page.goto('/inbox');
            await page.waitForSelector('text=Inbox tip target');

            expect(await tooltipOf(page, 'inboxItemCopyIdButton')).toBe('Copy item ID (c)');
            expect(await tooltipOf(page, 'inboxItemEditButton')).toBe('Edit (e)');
            await expect(page.getByTestId('inboxItemCopyIdButton').first()).toHaveAttribute('aria-keyshortcuts', 'C');
            // The key is announced from aria-keyshortcuts; the accessible name stays the plain label.
            await expect(page.getByTestId('inboxItemEditButton').first()).toHaveAccessibleName('Edit');

            await page.getByTestId('inboxItemRow').first().focus();
            await page.keyboard.press('c');
            await expect(page.getByTestId('inboxItemCopyIdButtonFeedback')).toContainText(item._id);
            await expect(page.getByTestId('quickCaptureDialog')).toHaveCount(0);

            await page.getByTestId('inboxItemRow').first().focus();
            await page.keyboard.press('e');
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Inbox tip target');
        });
    });

    test('routines and someday rows answer to the same letters; with a row focused, g c still jumps to Calendar', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `tips-pages-${uniqueStamp()}@example.com`, async (page) => {
            await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
            const routine = await gtd.createRoutine(page, { title: 'Tip routine', routineType: 'nextAction', rrule: 'FREQ=DAILY', template: {}, active: true });
            await gtd.clarifyToSomedayMaybe(page, await gtd.collect(page, 'Tip someday'), {});
            await gtd.flush(page);

            await page.goto('/routines');
            await page.waitForSelector('text=Tip routine');
            expect(await tooltipOf(page, 'routineRowEditButton')).toBe('Edit (e)');
            await page.getByTestId('routineRow').first().focus();
            await page.keyboard.press('c');
            await expect(page.getByTestId('routineRowCopyIdButtonFeedback')).toContainText(routine._id);

            await page.goto('/someday');
            await page.waitForSelector('text=Tip someday');
            await page.getByTestId('somedayItemRow').first().focus();
            await page.keyboard.press('e');
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Tip someday');
            await page.keyboard.press('Escape');

            await page.getByTestId('somedayItemRow').first().focus();
            await page.keyboard.press('g');
            await page.keyboard.press('c');
            await expect(page).toHaveURL(/\/calendar$/);
            // The `c` was the jump's: the clipboard still holds the routine id copied above, and quick capture stayed shut.
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(routine._id);
            await expect(page.getByTestId('quickCaptureDialog')).toHaveCount(0);
        });
    });

    test('Next Actions tooltips name all four letters; header buttons name theirs', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `tips-na-${uniqueStamp()}@example.com`, async (page) => {
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'NA tip'), {});
            await gtd.flush(page);
            await page.goto('/next-actions');
            await page.waitForSelector('text=NA tip');

            expect(await tooltipOf(page, 'nextActionItemCopyIdButton')).toBe('Copy item ID (c)');
            expect(await tooltipOf(page, 'nextActionItemEditButton')).toBe('Edit (e)');
            expect(await tooltipOf(page, 'nextActionItemDoneButton')).toBe('Mark done (d)');
            expect(await tooltipOf(page, 'nextActionMoveToButton')).toBe('Move to… (m)');
            expect(await tooltipOf(page, 'nextActionsSearchButton')).toBe('Search this list (/)');
            expect(await tooltipOf(page, 'keyboardShortcutsButton')).toBe('Keyboard shortcuts (?)');
        });
    });

    test('every list page tags its row buttons: calendar, waiting for, tickler, people, contexts, search and done', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `tips-all-${uniqueStamp()}@example.com`, async (page) => {
            const start = dayjs().add(1, 'day').hour(10).minute(0).second(0);
            await gtd.clarifyToCalendar(page, await gtd.collect(page, 'Tip meeting'), {
                timeStart: start.toISOString(),
                timeEnd: start.add(1, 'hour').toISOString(),
            });
            await gtd.clarifyToWaitingFor(page, await gtd.collect(page, 'Tip waiting'), {});
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Tip snoozed'), { ignoreBefore: dayjs().add(5, 'day').format('YYYY-MM-DD') });
            await gtd.clarifyToDone(page, await gtd.collect(page, 'Tip finished'));
            await gtd.createPerson(page, { name: 'Tip Person' });
            await gtd.createWorkContext(page, 'Tip Context');
            await gtd.flush(page);

            const pages = [
                { path: '/calendar', wait: 'Tip meeting', edit: 'calendarItemEditButton', label: 'Edit', copy: 'calendarItemCopyIdButton' },
                { path: '/waiting-for', wait: 'Tip waiting', edit: 'waitingForItemEditButton', label: 'Edit', copy: 'waitingForItemCopyIdButton' },
                { path: '/tickler', wait: 'Tip snoozed', edit: 'ticklerItemEditButton', label: 'Edit', copy: 'ticklerItemCopyIdButton' },
                { path: '/people', wait: 'Tip Person', edit: 'personRowEditButton', label: 'Edit', copy: null },
                { path: '/work-contexts', wait: 'Tip Context', edit: 'workContextRowEditButton', label: 'Rename', copy: null },
                { path: '/search', wait: 'Tip waiting', edit: null, label: null, copy: 'searchResultCopyIdButton' },
                { path: '/done', wait: 'Tip finished', edit: null, label: null, copy: 'archivedItemCopyIdButton' },
            ];
            for (const target of pages) {
                await page.goto(target.path);
                await page.waitForSelector(`text=${target.wait}`);
                if (target.edit && target.label) {
                    const edit = page.getByTestId(target.edit).first();
                    await expect(edit, target.path).toHaveAttribute('data-row-action', 'edit');
                    await expect(edit, target.path).toHaveAttribute('aria-keyshortcuts', 'E');
                    await expect(edit, target.path).toHaveAccessibleName(target.label);
                    expect(await tooltipOf(page, target.edit), target.path).toBe(`${target.label} (e)`);
                }
                if (target.copy) {
                    await expect(page.getByTestId(target.copy).first(), target.path).toHaveAttribute('data-row-action', 'copyId');
                    expect(await tooltipOf(page, target.copy), target.path).toBe('Copy item ID (c)');
                }
            }

            // People rows have no focusable row body: E on the focused row button opens the edit dialog.
            await page.goto('/people');
            await page.waitForSelector('text=Tip Person');
            await page.getByTestId('personRowEditButton').first().focus();
            await page.keyboard.press('e');
            await expect(page.getByRole('dialog')).toBeVisible();
            await page.keyboard.press('Escape');

            // C on a People row (no copy button) is still the row's letter — not quick capture.
            await page.getByTestId('personRowEditButton').first().focus();
            await page.keyboard.press('c');
            await page.waitForTimeout(200);
            await expect(page.getByTestId('quickCaptureDialog')).toHaveCount(0);
        });
    });

    test('a fading ghost row presses nothing (and opens no quick capture); row letters in the editor copy nothing', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `tips-ghost-${uniqueStamp()}@example.com`, async (page) => {
            await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
            await gtd.collect(page, 'Ghost target');
            await gtd.collect(page, 'Dialog target');
            await gtd.flush(page);
            await page.goto('/inbox');
            await page.waitForSelector('text=Ghost target');
            await page.evaluate(() => navigator.clipboard.writeText('untouched'));

            // Quick-done the row, keep focus inside it while it fades, press C: nothing is copied.
            const ghostRow = page.getByTestId('inboxItemRow').filter({ hasText: 'Ghost target' });
            await page.locator('[data-list-item-id]').filter({ hasText: 'Ghost target' }).getByRole('button', { name: 'Done (< 2 min)' }).click();
            await expect(page.getByTestId('ghostListRow')).toHaveCount(1);
            await page.getByTestId('ghostListRow').getByTestId('inboxItemCopyIdButton').focus();
            await page.keyboard.press('c');
            await page.waitForTimeout(200);
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('untouched');
            // The letter was the row's: it must not fall through and open quick capture either.
            await expect(page.getByTestId('quickCaptureDialog')).toHaveCount(0);
            await expect(ghostRow).toHaveCount(0, { timeout: 5_000 });

            // On the item page with focus on a status chip, C and E are the editor's own keys, never a row's:
            // nothing is copied and the editor stays open.
            await page.getByTestId('inboxItemRow').filter({ hasText: 'Dialog target' }).click();
            const editor = page.getByTestId('itemPageWrapper');
            await expect(editor).toBeVisible();
            await editor.getByRole('button', { name: 'Next Action', exact: true }).focus();
            await page.keyboard.press('c');
            await page.keyboard.press('e');
            await page.waitForTimeout(200);
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('untouched');
            await expect(editor).toHaveCount(1);
        });
    });
});
