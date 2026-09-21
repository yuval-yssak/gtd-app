import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { closeContextQuietly, withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';

// A brief is a one-line review-oriented condensation of an item, stored as a sidecar synced entity
// (`itemBrief`, _id === item id). This spec covers the AUTHORED path: typing it in the editor's
// Brief field persists it (blur commit → own op), it survives a reload, it reaches a second device
// through sync, and clearing it removes the row everywhere.

test.describe('item brief — authored in the editor', () => {
    test('typing a brief persists across reload, syncs to a second device, and clearing removes it on both', async ({ browser }) => {
        const email = `brief-authored-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const item = await gtd.collect(page, 'Renew passport');
            await gtd.updateItem(page, { ...item, notes: 'Form is half filled; still need photos and the old passport.' });
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto(`/item/${item._id}`);
            const briefInput = page.getByTestId('briefField').getByRole('textbox', { name: 'Brief' });
            await expect(briefInput).toHaveValue('');
            // No clear affordance while the field is empty.
            await expect(page.getByTestId('briefClearButton')).toHaveCount(0);

            await briefInput.fill('Passport before the June trip — photos are the blocker');
            // Blur commits (the title input is a neutral focus target).
            await page.getByRole('textbox', { name: 'Title' }).click();
            await expect.poll(async () => (await gtd.getItemBrief(page, item._id))?.text).toBe('Passport before the June trip — photos are the blocker');
            const stored = await gtd.getItemBrief(page, item._id);
            expect(stored?.origin).toBe('user');
            expect(stored?._id).toBe(item._id);
            await gtd.flush(page);

            // Reload: the field re-seeds from the persisted row; a fresh (hash-matching) brief
            // shows no stale marker.
            await page.reload();
            await expect(page.getByTestId('briefField').getByRole('textbox', { name: 'Brief' })).toHaveValue(
                'Passport before the June trip — photos are the blocker',
            );
            await expect(page.getByTestId('briefStaleMarker')).toHaveCount(0);

            // Second device for the same user: the brief arrives via bootstrap/sync.
            const ctx2 = await browser.newContext();
            try {
                const page2 = await loginAs(ctx2, email);
                await expect
                    .poll(async () => (await gtd.getItemBrief(page2, item._id))?.text, { timeout: 15_000 })
                    .toBe('Passport before the June trip — photos are the blocker');
                await page2.goto(`/item/${item._id}`);
                await expect(page2.getByTestId('briefField').getByRole('textbox', { name: 'Brief' })).toHaveValue(
                    'Passport before the June trip — photos are the blocker',
                );

                // Clear on device 1 via the (x) adornment → delete op → gone on device 2 too.
                await page.getByTestId('briefClearButton').click();
                await expect(page.getByTestId('briefField').getByRole('textbox', { name: 'Brief' })).toHaveValue('');
                await expect.poll(async () => await gtd.getItemBrief(page, item._id)).toBeUndefined();
                await gtd.flush(page);
                await expect.poll(async () => await gtd.getItemBrief(page2, item._id), { timeout: 15_000 }).toBeUndefined();
                // The open editor on device 2 adopts the deletion into its clean field silently.
                await expect(page2.getByTestId('briefField').getByRole('textbox', { name: 'Brief' })).toHaveValue('');
                await expect(page2.getByTestId('itemEditorConflictNotice')).toHaveCount(0);
            } finally {
                await closeContextQuietly(ctx2);
            }
        });
    });

    test('Enter commits the brief without leaving the field, and a brief written on another device fills a clean open field silently', async ({ browser }) => {
        const email = `brief-enter-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const item = await gtd.collect(page1, 'Book dentist');
            await gtd.flush(page1);

            await page1.goto(`/item/${item._id}`);
            const briefInput = page1.getByTestId('briefField').getByRole('textbox', { name: 'Brief' });
            await briefInput.fill('Overdue cleaning; insurance resets in January');
            await briefInput.press('Enter');
            await expect.poll(async () => (await gtd.getItemBrief(page1, item._id))?.text).toBe('Overdue cleaning; insurance resets in January');
            // Enter must not submit/navigate — the editor page is still open.
            await expect(page1.getByRole('textbox', { name: 'Title' })).toHaveValue('Book dentist');
            // A redundant re-focus + blur (no typing) must not re-save: the commit rebaselines its
            // seed locally, so the row's updatedTs stays put.
            const savedTs = (await gtd.getItemBrief(page1, item._id))?.updatedTs;
            await briefInput.click();
            await page1.getByRole('textbox', { name: 'Title' }).click();
            await page1.waitForTimeout(300);
            expect((await gtd.getItemBrief(page1, item._id))?.updatedTs).toBe(savedTs);
            await gtd.flush(page1);

            // Device 2 rewrites the brief (harness write = the same op the editor queues). Device 1's
            // editor is open with a CLEAN brief field, so the SSE-driven pull merges the new text in
            // with no conflict notice — the same path a future server-generated brief will take.
            await expect
                .poll(async () => (await gtd.getItemBrief(page2, item._id))?.text, { timeout: 15_000 })
                .toBe('Overdue cleaning; insurance resets in January');
            const itemOnDevice2 = (await gtd.listItems(page2)).find((row) => row._id === item._id);
            if (!itemOnDevice2) throw new Error('item did not reach device 2');
            await gtd.setUserBrief(page2, itemOnDevice2, 'Rewritten on the other device');
            await gtd.flush(page2);
            await expect(briefInput).toHaveValue('Rewritten on the other device', { timeout: 15_000 });
            await expect(page1.getByTestId('itemEditorConflictNotice')).toHaveCount(0);
        });
    });
});
