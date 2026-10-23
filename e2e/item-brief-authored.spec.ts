import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { closeContextQuietly, withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';
import { briefInputOf, briefTextOf, openBriefEditor } from './helpers/itemEditorLocators';
import { loginAs } from './helpers/login';

// A brief is a one-line review-oriented condensation of an item, stored as a sidecar synced entity
// (`itemBrief`, _id === item id). This spec covers the AUTHORED path: the brief rests read-only and
// the pencil opens its field (a typed brief is pinned, so writing one must be deliberate); typing
// it persists it (blur/Enter/Escape/Done commit → own op), it survives a reload, it reaches a
// second device through sync, and clearing it removes the row everywhere.

test.describe('item brief — authored in the editor', () => {
    test('typing a brief persists across reload, syncs to a second device, and clearing removes it on both', async ({ browser }) => {
        const email = `brief-authored-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const item = await gtd.collect(page, 'Renew passport');
            await gtd.updateItem(page, { ...item, notes: 'Form is half filled; still need photos and the old passport.' });
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto(`/item/${item._id}`);
            // Empty brief at rest: the "written automatically" hint, no text, no clear affordance.
            await expect(page.getByTestId('briefEmpty')).toHaveText('No brief yet — one is written automatically');
            await expect(briefTextOf(page)).toHaveCount(0);
            await expect(page.getByTestId('briefClearButton')).toHaveCount(0);

            const briefInput = await openBriefEditor(page);
            await expect(briefInput).toHaveValue('');
            // No clear affordance while the open field is empty.
            await expect(page.getByTestId('briefClearButton')).toHaveCount(0);

            await briefInput.fill('Passport before the June trip — photos are the blocker');
            // Blur commits (the title input is a neutral focus target) and returns to the read view.
            await page.getByRole('textbox', { name: 'Title' }).click();
            await expect(briefInputOf(page)).toHaveCount(0);
            await expect.poll(async () => (await gtd.getItemBrief(page, item._id))?.text).toBe('Passport before the June trip — photos are the blocker');
            const stored = await gtd.getItemBrief(page, item._id);
            expect(stored?.origin).toBe('user');
            expect(stored?._id).toBe(item._id);
            await gtd.flush(page);

            // Reload: the read view re-seeds from the persisted row; a fresh (hash-matching) brief
            // shows no stale marker.
            await page.reload();
            await expect(briefTextOf(page)).toHaveText('Passport before the June trip — photos are the blocker');
            await expect(page.getByTestId('briefStaleMarker')).toHaveCount(0);

            // Second device for the same user: the brief arrives via bootstrap/sync.
            const ctx2 = await browser.newContext();
            try {
                const page2 = await loginAs(ctx2, email);
                await expect
                    .poll(async () => (await gtd.getItemBrief(page2, item._id))?.text, { timeout: 15_000 })
                    .toBe('Passport before the June trip — photos are the blocker');
                await page2.goto(`/item/${item._id}`);
                await expect(briefTextOf(page2)).toHaveText('Passport before the June trip — photos are the blocker');

                // Clear on device 1 via the open field's (x) adornment → delete op → gone on device 2 too.
                await openBriefEditor(page);
                await page.getByTestId('briefClearButton').click();
                await expect(briefInputOf(page)).toHaveCount(0);
                await expect(page.getByTestId('briefEmpty')).toBeVisible();
                await expect.poll(async () => await gtd.getItemBrief(page, item._id)).toBeUndefined();
                await gtd.flush(page);
                await expect.poll(async () => await gtd.getItemBrief(page2, item._id), { timeout: 15_000 }).toBeUndefined();
                // The open editor on device 2 adopts the deletion into its clean brief silently.
                await expect(briefTextOf(page2)).toHaveCount(0);
                await expect(page2.getByTestId('briefEmpty')).toBeVisible();
                await expect(page2.getByTestId('itemEditorConflictNotice')).toHaveCount(0);
            } finally {
                await closeContextQuietly(ctx2);
            }
        });
    });

    test('Enter commits the brief without leaving the page, and a brief written on another device fills a clean brief silently', async ({ browser }) => {
        const email = `brief-enter-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const item = await gtd.collect(page1, 'Book dentist');
            await gtd.flush(page1);

            await page1.goto(`/item/${item._id}`);
            const briefInput = await openBriefEditor(page1);
            await briefInput.fill('Overdue cleaning; insurance resets in January');
            await briefInput.press('Enter');
            await expect.poll(async () => (await gtd.getItemBrief(page1, item._id))?.text).toBe('Overdue cleaning; insurance resets in January');
            // Enter must not submit/navigate — the editor page is still open, back in the read view.
            await expect(page1.getByRole('textbox', { name: 'Title' })).toHaveValue('Book dentist');
            await expect(briefInput).toHaveCount(0);
            await expect(briefTextOf(page1)).toHaveText('Overdue cleaning; insurance resets in January');
            // A redundant re-open + blur (no typing) must not re-save: the commit rebaselines its
            // seed locally, so the row's updatedTs stays put.
            const savedTs = (await gtd.getItemBrief(page1, item._id))?.updatedTs;
            await openBriefEditor(page1);
            await page1.getByRole('textbox', { name: 'Title' }).click();
            await expect(briefInput).toHaveCount(0);
            await page1.waitForTimeout(300);
            expect((await gtd.getItemBrief(page1, item._id))?.updatedTs).toBe(savedTs);
            await gtd.flush(page1);

            // Device 2 rewrites the brief (harness write = the same op the editor queues). Device 1's
            // editor is open with a CLEAN brief, so the SSE-driven pull merges the new text in
            // with no conflict notice — the same path a future server-generated brief will take.
            await expect
                .poll(async () => (await gtd.getItemBrief(page2, item._id))?.text, { timeout: 15_000 })
                .toBe('Overdue cleaning; insurance resets in January');
            const itemOnDevice2 = (await gtd.listItems(page2)).find((row) => row._id === item._id);
            if (!itemOnDevice2) throw new Error('item did not reach device 2');
            await gtd.setUserBrief(page2, itemOnDevice2, 'Rewritten on the other device');
            await gtd.flush(page2);
            await expect(briefTextOf(page1)).toHaveText('Rewritten on the other device', { timeout: 15_000 });
            await expect(page1.getByTestId('itemEditorConflictNotice')).toHaveCount(0);
        });
    });

    test('the brief rests read-only: clicking its text does nothing, the pencil opens the field with the pinned notice', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `brief-readonly-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Renew passport');
            await gtd.setUserBrief(page, item, 'Photos are the blocker');
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto(`/item/${item._id}`);
            const briefText = briefTextOf(page);
            await expect(briefText).toHaveText('Photos are the blocker');
            // At rest there is no Brief textbox at all — only the text, the pencil and the sparkle.
            await expect(briefInputOf(page)).toHaveCount(0);
            await expect(page.getByRole('textbox', { name: 'Brief' })).toHaveCount(0);
            await expect(page.getByTestId('briefPinnedNotice')).toHaveCount(0);

            // A stray click on the text must not open the field (that would pin on the next keystroke).
            await briefText.click();
            await expect(page.getByRole('textbox', { name: 'Brief' })).toHaveCount(0);
            await expect(briefText).toBeVisible();

            // The pencil is the way in: the field opens focused with the current text, and the
            // notice explains that a written brief is pinned.
            const briefInput = await openBriefEditor(page);
            await expect(briefInput).toBeFocused();
            await expect(briefInput).toHaveValue('Photos are the blocker');
            await expect(briefText).toHaveCount(0);
            const notice = page.getByTestId('briefPinnedNotice');
            await expect(notice).toBeVisible();
            await expect(notice).toContainText('pinned');
            await expect(notice).toHaveText(
                'A brief you write is pinned: it stays exactly as written, even when the title or notes change. To unpin it, click Regenerate brief (✨) and choose Replace.',
            );
            // Read WITH the field rather than interrupting it: a status region the input describes.
            await expect(notice).toHaveAttribute('role', 'status');
            await expect(briefInput).toHaveAccessibleDescription(/A brief you write is pinned/);
        });
    });

    test('Escape commits and returns to the read view on the item page; Done commits and hides the notice', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `brief-escape-done-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Book dentist');
            await gtd.flush(page);

            const itemUrl = `/item/${item._id}`;
            await page.goto(itemUrl);
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Book dentist');
            const urlBefore = page.url();

            // Escape: commits the typed text and steps out of the FIELD only — the page-level
            // ESC-to-leave must not also fire, so the item page stays open.
            const briefInput = await openBriefEditor(page);
            await briefInput.fill('Overdue cleaning');
            await briefInput.press('Escape');
            await expect.poll(async () => (await gtd.getItemBrief(page, item._id))?.text).toBe('Overdue cleaning');
            expect((await gtd.getItemBrief(page, item._id))?.origin).toBe('user');
            await expect(briefInput).toHaveCount(0);
            await expect(briefTextOf(page)).toHaveText('Overdue cleaning');
            await expect(page.getByTestId('briefPinnedNotice')).toHaveCount(0);
            // Give a (wrongly) propagated Escape time to navigate before asserting it did not.
            await page.waitForTimeout(300);
            expect(page.url()).toBe(urlBefore);
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Book dentist');
            // The field unmounted under the keyboard user — focus lands on the pencil to re-enter.
            await expect(page.getByTestId('briefEditButton')).toBeFocused();

            // Done: commits the edit, returns to the read view, and the pinned notice goes with the field.
            const reopened = await openBriefEditor(page);
            await expect(page.getByTestId('briefPinnedNotice')).toBeVisible();
            await reopened.fill('Overdue cleaning; insurance resets in January');
            await page.getByTestId('briefDoneButton').click();
            await expect.poll(async () => (await gtd.getItemBrief(page, item._id))?.text).toBe('Overdue cleaning; insurance resets in January');
            await expect(reopened).toHaveCount(0);
            await expect(page.getByTestId('briefPinnedNotice')).toHaveCount(0);
            await expect(page.getByTestId('briefDoneButton')).toHaveCount(0);
            await expect(briefTextOf(page)).toHaveText('Overdue cleaning; insurance resets in January');
            await expect(page.getByTestId('briefEditButton')).toBeFocused();
        });
    });

    test('Tab moves from the field to Clear and Done without leaving edit mode; Enter on Done commits', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `brief-tab-done-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Renew passport');
            await gtd.setUserBrief(page, item, 'Photos are the blocker');
            await gtd.flush(page);

            await page.goto(`/item/${item._id}`);
            const briefInput = await openBriefEditor(page);
            await expect(briefInput).toBeFocused();
            // Caret to the end directly, not with End: on macOS the first End in a textarea scrolls a
            // page taller than the viewport (the inbox Position row makes it so) instead of moving the caret.
            await briefInput.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
            await briefInput.pressSequentially(' and the form');

            // Tab into the field's own buttons is focus staying INSIDE the editor: no commit, no
            // flip to the read view (which would unmount the very button receiving focus).
            await page.keyboard.press('Tab');
            await expect(page.getByTestId('briefClearButton')).toBeFocused();
            await expect(briefInput).toBeVisible();
            await expect(page.getByTestId('briefPinnedNotice')).toBeVisible();
            expect((await gtd.getItemBrief(page, item._id))?.text).toBe('Photos are the blocker');

            await page.keyboard.press('Tab');
            await expect(page.getByTestId('briefDoneButton')).toBeFocused();
            await expect(briefInput).toBeVisible();

            await page.keyboard.press('Enter');
            await expect.poll(async () => (await gtd.getItemBrief(page, item._id))?.text).toBe('Photos are the blocker and the form');
            await expect(briefInput).toHaveCount(0);
            await expect(briefTextOf(page)).toHaveText('Photos are the blocker and the form');
            await expect(page.getByTestId('briefEditButton')).toBeFocused();
        });
    });

    test('Tab to Clear and Enter clears the brief, returns to the read view and focuses the pencil', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `brief-tab-clear-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Renew passport');
            await gtd.setUserBrief(page, item, 'Photos are the blocker');
            await gtd.flush(page);

            await page.goto(`/item/${item._id}`);
            // Let this device pull its own echo of the seeded brief BEFORE clearing: an in-flight pull
            // that lands after the clear re-creates the row (pre-existing sync race, not this UI).
            await gtd.pull(page);
            const briefInput = await openBriefEditor(page);
            await expect(briefInput).toBeFocused();
            await page.keyboard.press('Tab');
            const clearButton = page.getByTestId('briefClearButton');
            await expect(clearButton).toBeFocused();

            await page.keyboard.press('Enter');
            await expect.poll(async () => await gtd.getItemBrief(page, item._id)).toBeUndefined();
            await expect(briefInput).toHaveCount(0);
            await expect(briefTextOf(page)).toHaveCount(0);
            await expect(page.getByTestId('briefEmpty')).toHaveText('No brief yet — one is written automatically');
            // Clear is an explicit exit, like Done: focus goes back to the pencil, not the page body.
            await expect(page.getByTestId('briefEditButton')).toBeFocused();
        });
    });
});
