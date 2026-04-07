import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

// Advanced offline scenarios: multi-entity offline mutations and offline conflict resolution.

test.describe('offline advanced', () => {
    test('offline edits to multiple entity types flush together on reconnect', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `offline-multi-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.context().setOffline(true);

            // Create entities across all types while offline
            const person = await gtd.createPerson(page, { name: 'Offline Person' });
            const ctx = await gtd.createWorkContext(page, 'Offline Context');
            const inbox = await gtd.collect(page, 'Offline task');
            await gtd.clarifyToNextAction(page, inbox, {
                workContextIds: [ctx._id],
                peopleIds: [person._id],
                energy: 'high',
            });

            const queued = await gtd.queuedOps(page);
            // person create + context create + item create (coalesced with clarify update)
            expect(queued.length).toBeGreaterThanOrEqual(3);

            // Reconnect — all ops should flush together
            await page.context().setOffline(false);

            await page.evaluate(async () => {
                type Harness = { queuedOps(): Promise<unknown[]> };
                const harness = (window as unknown as { __gtd: Harness }).__gtd;
                const deadline = Date.now() + 15_000;
                while (Date.now() < deadline) {
                    const ops = await harness.queuedOps();
                    if (ops.length === 0) return true;
                    await new Promise((r) => setTimeout(r, 300));
                }
                throw new Error('Queue did not drain within 15s');
            });

            // Verify all entities reached the server
            const bootstrap = await gtd.fetchBootstrap(page);
            expect(bootstrap.people.find((p) => p._id === person._id)?.name).toBe('Offline Person');
            expect(bootstrap.workContexts.find((w) => w._id === ctx._id)?.name).toBe('Offline Context');
            const serverItem = bootstrap.items.find((i) => i._id === inbox._id);
            expect(serverItem?.status).toBe('nextAction');
            expect(serverItem?.workContextIds).toContain(ctx._id);
        });
    });

    test('offline conflict resolves correctly on reconnect', async ({ browser }) => {
        const email = `offline-conflict-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            // Create and sync an item to both devices
            const inbox = await gtd.collect(page1, 'Contested offline');
            await gtd.flush(page1);
            await gtd.pull(page2);

            // Device-1 goes offline and edits
            await page1.context().setOffline(true);
            await gtd.clarifyToNextAction(page1, inbox, { energy: 'low' });

            // Device-2 edits while device-1 is offline (device-2 is online, flushes immediately)
            // Small delay ensures device-2's timestamp is later than device-1's
            await page2.waitForTimeout(50);
            const item2 = (await gtd.listItems(page2)).find((i) => i._id === inbox._id);
            if (!item2) {
                throw new Error('Item not found on device-2');
            }
            await gtd.clarifyToNextAction(page2, item2, { energy: 'high', urgent: true });
            await gtd.flush(page2);

            // Device-1 reconnects — its older edit should lose to device-2's newer one
            await page1.context().setOffline(false);

            // Wait for queue drain
            await page1.evaluate(async () => {
                type Harness = { queuedOps(): Promise<unknown[]> };
                const harness = (window as unknown as { __gtd: Harness }).__gtd;
                const deadline = Date.now() + 15_000;
                while (Date.now() < deadline) {
                    const ops = await harness.queuedOps();
                    if (ops.length === 0) return true;
                    await new Promise((r) => setTimeout(r, 300));
                }
                throw new Error('Queue did not drain within 15s');
            });

            // Both devices pull and should converge on device-2's version (newer timestamp)
            await gtd.pull(page1);
            await gtd.pull(page2);

            for (const [page, label] of [[page1, 'device-1'] as const, [page2, 'device-2'] as const]) {
                const resolved = (await gtd.listItems(page)).find((i) => i._id === inbox._id);
                expect(resolved?.energy, `${label} energy`).toBe('high');
                expect(resolved?.urgent, `${label} urgent`).toBe(true);
            }
        });
    });
});
