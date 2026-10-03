import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

const CLARIFY_MODE_KEY = 'gtd:inlineClarifyMode';
// Mirrors SYNC_FLUSH_LOCK in client/src/db/crossContextLock.ts — the Web Lock every context's
// flushSyncQueue serializes on. Holding it from the page models a Service Worker / sibling tab mid-flush.
const SYNC_FLUSH_LOCK = 'gtd-sync-flush';

type FlushLockHolder = { __releaseFlushLock?: () => void };

function tomorrowAt(hour: number) {
    const start = dayjs().add(1, 'day').hour(hour).minute(0).second(0).millisecond(0);
    return { timeStart: start.toISOString(), timeEnd: start.add(30, 'minute').toISOString() };
}

/** Seeds a calendar item (pushed to the server) and lands on /calendar with it rendered. */
async function openCalendarWithItem(page: Page, title: string, hour: number) {
    const inbox = await gtd.collect(page, title);
    const calItem = await gtd.clarifyToCalendar(page, inbox, tomorrowAt(hour));
    await gtd.flush(page);
    await page.goto('/calendar');
    await page.waitForSelector(`text=${title}`);
    return calItem;
}

// /calendar used to lack a row-level "mark done" affordance — only Edit + Copy-id were exposed.
// Page-mode save additionally jumped to the destination bucket (so a calendar item marked done
// stranded the user on /done). Both surfaces should now keep the user on /calendar.
test.describe('Calendar list — mark done', () => {
    test('row-level Mark done button completes the item without leaving /calendar', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-row-done-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Mark done from row');
            const calItem = await gtd.clarifyToCalendar(page, inbox, {
                timeStart: dayjs().add(1, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString(),
                timeEnd: dayjs().add(1, 'day').hour(9).minute(30).second(0).millisecond(0).toISOString(),
            });

            await page.goto('/calendar');
            await page.waitForSelector('text=Mark done from row');

            await page.getByTestId('calendarItemMarkDoneButton').first().click();

            // The row drops out of /calendar; the user stays on /calendar (no navigation away).
            await expect(page).toHaveURL(/\/calendar$/);
            await expect(page.getByText('Mark done from row')).toHaveCount(0);

            // The persisted status is `done`.
            const items = await gtd.listItems(page);
            const updated = items.find((i) => i._id === calItem._id);
            expect(updated?.status).toBe('done');
        });
    });

    // Production 2026-10-03: a row-level Mark done reached /sync/push ~100s after the click, and only
    // because the user navigated. The op's immediate dispatch had found the cross-context flush lock
    // held (a Service Worker flush stuck on a hung request) and silently skipped — nothing retried.
    test('row-level Mark done pushes its op right away — no navigation or manual flush', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-row-done-push-${dayjs().valueOf()}@example.com`, async (page) => {
            const calItem = await openCalendarWithItem(page, 'Push on row done', 11);

            await page.getByTestId('calendarItemMarkDoneButton').first().click();
            await expect(page.getByText('Push on row done')).toHaveCount(0);

            // Deliberately no gtd.flush: the click's own fire-and-forget dispatch must drain the queue.
            await expect.poll(() => gtd.queuedOps(page), { timeout: 2_000 }).toEqual([]);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === calItem._id)?.status).toBe('done');
        });
    });

    test("row-level Mark done queues behind another context's flush and pushes once it frees — never stranded", async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-row-done-lock-${dayjs().valueOf()}@example.com`, async (page) => {
            const calItem = await openCalendarWithItem(page, 'Push waits for lock', 12);

            // "Another context" holds the flush lock (a SW mid-push, in production); release it later.
            await page.evaluate((lockName) => {
                const holder = window as unknown as FlushLockHolder;
                void navigator.locks.request(
                    lockName,
                    () =>
                        new Promise<void>((resolve) => {
                            holder.__releaseFlushLock = resolve;
                        }),
                );
            }, SYNC_FLUSH_LOCK);
            await page.waitForFunction(() => typeof (window as unknown as FlushLockHolder).__releaseFlushLock === 'function');

            await page.getByTestId('calendarItemMarkDoneButton').first().click();
            await expect(page.getByText('Push waits for lock')).toHaveCount(0);

            // While the holder is busy the op must WAIT in the queue — pre-fix the flush ignored this lock
            // (and skipped on a different one), so either the op is already gone or it is stranded for 30s.
            await page.waitForTimeout(1_000);
            const queuedWhileHeld = await gtd.queuedOps(page);
            expect(queuedWhileHeld.map((op) => `${op.opType}:${op.entityId}`)).toEqual([`update:${calItem._id}`]);

            await page.evaluate(() => (window as unknown as Required<FlushLockHolder>).__releaseFlushLock());
            await expect.poll(() => gtd.queuedOps(page), { timeout: 5_000 }).toEqual([]);
        });
    });

    test('page-mode save of calendar → done returns to /calendar (not /done)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-page-done-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Page-mode calendar done');
            const calItem = await gtd.clarifyToCalendar(page, inbox, {
                timeStart: dayjs().add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString(),
                timeEnd: dayjs().add(1, 'day').hour(10).minute(30).second(0).millisecond(0).toISOString(),
            });

            await page.goto('/calendar');
            await page.waitForSelector('text=Page-mode calendar done');

            // Flip to page mode so clicking a row navigates into /item/:id.
            await page.evaluate(
                (args) => {
                    localStorage.setItem(args.key, 'page');
                    window.dispatchEvent(new StorageEvent('storage', { key: args.key, newValue: 'page' }));
                },
                { key: CLARIFY_MODE_KEY },
            );

            await page.getByTestId('calendarItemRow').filter({ hasText: 'Page-mode calendar done' }).click();
            await expect(page).toHaveURL(new RegExp(`/item/${calItem._id}`));
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();

            await page.getByRole('button', { name: 'Done' }).click();
            await page.getByRole('button', { name: 'Save changes' }).click();

            // Source-bucket policy: a calendar item saved as done returns to /calendar.
            await expect(page).toHaveURL(/\/calendar$/);

            // Sanity: the persisted status is `done` even though we landed back on /calendar.
            const items = await gtd.listItems(page);
            const updated = items.find((i) => i._id === calItem._id);
            expect(updated?.status).toBe('done');
        });
    });
});
