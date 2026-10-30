import { expect, type Page, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { CLIENT_URL } from './helpers/env';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// A nextAction routine keeps at most one open item. Two ways it used to break: the post-sync seeding
// pass ran even when the device could not sync (minting an item beside one it had never pulled), and
// completing one of two open occurrences generated yet another successor, so the duplicate persisted.

const MONTHLY_ROUTINE = { title: 'Get flowers', routineType: 'nextAction', rrule: 'FREQ=MONTHLY', template: {}, active: true } as const;

async function openItemsOf(page: Page, routineId: string) {
    return (await gtd.listItems(page)).filter((i) => i.routineId === routineId && i.status !== 'done' && i.status !== 'trash');
}

/** Reloads onto /routines and waits for the boot sync pass (seeding included) to finish. */
async function reloadAndAwaitBootSync(page: Page) {
    await page.goto(`${CLIENT_URL}/routines`);
    await expect(page.getByTestId('syncingChip')).toBeVisible();
    await expect(page.getByTestId('syncingChip')).toHaveCount(0);
}

test.describe('routine single open item', () => {
    test('the boot seeding pass waits for a sync that succeeded', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-seed-gate-${uniqueStamp()}@example.com`, async (page) => {
            // The delay keeps the boot pass's "Syncing…" chip on screen long enough to watch it end.
            await page.route('**/sync/pull?*', async (route) => {
                await new Promise((r) => setTimeout(r, 800));
                await route.fulfill({ status: 401, body: 'unauthorized' });
            });
            // Reload first so no pass that pulled successfully (login's, or one an SSE echo of the
            // routine create would start) is still in flight to seed the routine behind our back.
            await reloadAndAwaitBootSync(page);
            const routine = await gtd.createRoutine(page, MONTHLY_ROUTINE);
            await gtd.flush(page);

            await reloadAndAwaitBootSync(page);

            expect(await openItemsOf(page, routine._id)).toHaveLength(0);

            await page.unroute('**/sync/pull?*');
            await page.goto(`${CLIENT_URL}/routines`);
            await expect.poll(async () => (await openItemsOf(page, routine._id)).length).toBe(1);
        });
    });

    test('completing one of two open occurrences generates no further successor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-dup-dispose-${uniqueStamp()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, MONTHLY_ROUTINE);
            // Seed the first occurrence through the materializer itself: a background sync pass may
            // race it, but the routine lock lets exactly one of them mint it.
            await gtd.materializePendingNextActionRoutines(page);
            const [disposed] = await openItemsOf(page, routine._id);
            if (!disposed) throw new Error('expected the materialized first occurrence');
            const survivor = await gtd.updateItem(page, { ...(await gtd.collect(page, 'Get flowers')), status: 'nextAction', routineId: routine._id });

            await gtd.clarifyToDone(page, disposed);
            await gtd.flush(page);

            expect((await openItemsOf(page, routine._id)).map((i) => i._id)).toEqual([survivor._id]);
            const serverOpen = (await gtd.fetchBootstrap(page)).items.filter((i) => i.routineId === routine._id && i.status === 'nextAction');
            expect(serverOpen.map((i) => i._id)).toEqual([survivor._id]);
        });
    });
});
