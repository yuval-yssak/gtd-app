import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Single-device happy path: verifies the full mutation → IndexedDB → server round-trip
// before testing the more complex multi-device scenarios in other specs.

test.describe('collect and clarify', () => {
    test('inbox item is visible in IDB and reaches the server after flush', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `collect-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Buy oat milk');
            expect(item.status).toBe('inbox');
            expect(item.title).toBe('Buy oat milk');

            const items = await gtd.listItems(page);
            expect(items.some((i) => i._id === item._id)).toBe(true);

            await gtd.flush(page);

            const ops = await gtd.queuedOps(page);
            expect(ops).toHaveLength(0);

            // Verify the item reached MongoDB by checking the bootstrap snapshot.
            const bootstrap = await gtd.fetchBootstrap(page);
            expect(bootstrap.items.some((i) => i.title === 'Buy oat milk')).toBe(true);
        });
    });

    test('clarifyToNextAction changes status and fields, flush empties queue', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `clarify-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Clarify me');
            const nextAction = await gtd.clarifyToNextAction(page, inbox, { energy: 'low', time: 5 });

            expect(nextAction.status).toBe('nextAction');
            expect(nextAction.energy).toBe('low');
            expect(nextAction.time).toBe(5);

            await gtd.flush(page);
            expect(await gtd.queuedOps(page)).toHaveLength(0);

            const bootstrap = await gtd.fetchBootstrap(page);
            const serverItem = bootstrap.items.find((i) => i._id === nextAction._id);
            expect(serverItem?.status).toBe('nextAction');
            expect(serverItem?.energy).toBe('low');
        });
    });

    test('clarifyToDone marks item done on server', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `done-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Finish me');
            await gtd.flush(page);

            const done = await gtd.clarifyToDone(page, inbox);
            expect(done.status).toBe('done');

            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            const serverItem = bootstrap.items.find((i) => i._id === done._id);
            expect(serverItem?.status).toBe('done');
        });
    });
});
