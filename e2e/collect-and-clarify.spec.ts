import { expect, test } from '@playwright/test';
import type { StoredItem } from '../client/src/types/MyDB';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';

const API = 'http://localhost:4000';

// Single-device happy path: verifies the full mutation → IndexedDB → server round-trip
// before testing the more complex multi-device scenarios in other specs.

test.describe('collect and clarify', () => {
    test('inbox item is visible in IDB and reaches the server after flush', async ({ browser }) => {
        const ctx = await browser.newContext();
        const page = await loginAs(ctx, `collect-${Date.now()}@example.com`);

        const item = await gtd.collect(page, 'Buy oat milk');
        expect(item.status).toBe('inbox');
        expect(item.title).toBe('Buy oat milk');

        const items = await gtd.listItems(page);
        expect(items.some((i) => i._id === item._id)).toBe(true);

        await gtd.flush(page);

        const ops = await gtd.queuedOps(page);
        expect(ops).toHaveLength(0);

        // Verify the item reached MongoDB by checking the bootstrap snapshot.
        const bootstrap = await page.evaluate(async (apiUrl) => {
            const res = await fetch(`${apiUrl}/sync/bootstrap`, { credentials: 'include' });
            return res.json() as Promise<{ items: StoredItem[] }>;
        }, API);

        expect(bootstrap.items.some((i) => i.title === 'Buy oat milk')).toBe(true);

        await ctx.close();
    });

    test('clarifyToNextAction changes status and fields, flush empties queue', async ({ browser }) => {
        const ctx = await browser.newContext();
        const page = await loginAs(ctx, `clarify-${Date.now()}@example.com`);

        const inbox = await gtd.collect(page, 'Clarify me');
        const nextAction = await gtd.clarifyToNextAction(page, inbox, { energy: 'low', time: 5 });

        expect(nextAction.status).toBe('nextAction');
        expect(nextAction.energy).toBe('low');
        expect(nextAction.time).toBe(5);

        await gtd.flush(page);
        expect(await gtd.queuedOps(page)).toHaveLength(0);

        const bootstrap = await page.evaluate(async (apiUrl) => {
            const res = await fetch(`${apiUrl}/sync/bootstrap`, { credentials: 'include' });
            return res.json() as Promise<{ items: StoredItem[] }>;
        }, API);

        const serverItem = bootstrap.items.find((i) => i._id === nextAction._id);
        expect(serverItem?.status).toBe('nextAction');
        expect(serverItem?.energy).toBe('low');

        await ctx.close();
    });

    test('clarifyToDone marks item done on server', async ({ browser }) => {
        const ctx = await browser.newContext();
        const page = await loginAs(ctx, `done-${Date.now()}@example.com`);

        const inbox = await gtd.collect(page, 'Finish me');
        await gtd.flush(page);

        const done = await gtd.clarifyToDone(page, inbox);
        expect(done.status).toBe('done');

        await gtd.flush(page);

        const bootstrap = await page.evaluate(async (apiUrl) => {
            const res = await fetch(`${apiUrl}/sync/bootstrap`, { credentials: 'include' });
            return res.json() as Promise<{ items: StoredItem[] }>;
        }, API);

        const serverItem = bootstrap.items.find((i) => i._id === done._id);
        expect(serverItem?.status).toBe('done');

        await ctx.close();
    });
});
