import { expect, type Page, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { API_URL, CLIENT_URL } from './helpers/env';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// A nextAction routine "ending after N occurrences" used to run forever: each completion re-anchored
// the rule at the completion day, so its COUNT restarted. Both generators — the app's and the API's —
// must stop at the Nth occurrence and deactivate the routine.

const TWICE_DAILY = { title: 'Pay installment', routineType: 'nextAction', rrule: 'FREQ=DAILY;COUNT=2', template: {}, active: true } as const;

async function openItemsOf(page: Page, routineId: string) {
    return (await gtd.listItems(page)).filter((i) => i.routineId === routineId && i.status !== 'done' && i.status !== 'trash');
}

/** The routine's single open occurrence — throws (not passes) when the series has none. */
async function onlyOpenItemOf(page: Page, routineId: string) {
    await expect.poll(async () => (await openItemsOf(page, routineId)).length).toBe(1);
    const [open] = await openItemsOf(page, routineId);
    if (!open) throw new Error('expected one open occurrence');
    return open;
}

async function expectSeriesEnded(page: Page, routineId: string) {
    const server = await gtd.fetchBootstrap(page);
    expect(server.items.filter((i) => i.routineId === routineId && i.status === 'nextAction')).toEqual([]);
    expect(server.routines.find((r) => r._id === routineId)?.active).toBe(false);
    await page.goto(`${CLIENT_URL}/routines`);
    await expect(page.getByTestId('routinePausedSectionToggle')).toBeVisible();
}

test.describe('COUNT-bounded nextAction routine', () => {
    test('completing the last occurrence in the app ends the series', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-count-app-${uniqueStamp()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, TWICE_DAILY);
            await gtd.materializePendingNextActionRoutines(page);

            await gtd.clarifyToDone(page, await onlyOpenItemOf(page, routine._id));
            await gtd.clarifyToDone(page, await onlyOpenItemOf(page, routine._id));
            await gtd.flush(page);

            expect(await openItemsOf(page, routine._id)).toEqual([]);
            await expectSeriesEnded(page, routine._id);
        });
    });

    test('completing the last occurrence through the public API ends the series', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-count-api-${uniqueStamp()}@example.com`, async (page) => {
            const request = page.context().request;
            const tokenRes = await request.post(`${API_URL}/account/tokens`, { data: { label: 'count', scopes: ['routines.write', 'items.write'] } });
            expect(tokenRes.status()).toBe(200);
            const auth = { headers: { Authorization: `Bearer ${((await tokenRes.json()) as { plaintext: string }).plaintext}` } };
            const create = await request.post(`${API_URL}/v1/routines`, { ...auth, data: TWICE_DAILY });
            expect(create.status()).toBe(201);
            const routineId = ((await create.json()) as { _id: string })._id;

            for (let occurrence = 0; occurrence < 2; occurrence++) {
                await gtd.pull(page);
                const open = await onlyOpenItemOf(page, routineId);
                expect((await request.post(`${API_URL}/v1/items/${open._id}/complete`, auth)).status()).toBe(200);
            }

            await expectSeriesEnded(page, routineId);
        });
    });
});
