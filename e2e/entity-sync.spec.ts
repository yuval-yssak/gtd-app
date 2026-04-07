import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredItem } from '../client/src/types/MyDB';
import { withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

// Tests multi-device sync for entity types and mutations not covered by
// multi-device-sync.spec.ts: calendar items, waiting-for items, status changes via SSE,
// and item deletion.

async function waitForItemByIdOnDevice(page: Page, id: string): Promise<StoredItem> {
    const found = await page.evaluate(async (itemId) => {
        type Harness = { listItems(): Promise<StoredItem[]> };
        const harness = (window as unknown as { __gtd: Harness }).__gtd;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            const items = await harness.listItems();
            const match = items.find((i) => i._id === itemId);
            if (match) return match;
            await new Promise((r) => setTimeout(r, 200));
        }
        return null;
    }, id);

    if (!found) throw new Error(`Item ${id} not found on device after 10s`);
    return found;
}

test.describe('entity sync', () => {
    test('calendar item syncs across devices with time fields', async ({ browser }) => {
        const email = `cal-sync-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const inbox = await gtd.collect(page1, 'Synced meeting');
            const timeStart = dayjs().add(2, 'day').hour(10).minute(0).second(0).toISOString();
            const timeEnd = dayjs().add(2, 'day').hour(11).minute(0).second(0).toISOString();
            await gtd.clarifyToCalendar(page1, inbox, { timeStart, timeEnd });
            await gtd.flush(page1);

            await gtd.pull(page2);

            const item = await waitForItemByIdOnDevice(page2, inbox._id);
            expect(item.status).toBe('calendar');
            expect(item.timeStart).toBe(timeStart);
            expect(item.timeEnd).toBe(timeEnd);
        });
    });

    test('waiting-for item syncs with person reference', async ({ browser }) => {
        const email = `wf-sync-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const person = await gtd.createPerson(page1, { name: 'Eve' });
            const inbox = await gtd.collect(page1, 'Waiting for Eve');
            await gtd.clarifyToWaitingFor(page1, inbox, { waitingForPersonId: person._id });
            await gtd.flush(page1);

            await gtd.pull(page2);

            const items = await gtd.listItems(page2);
            const item = items.find((i) => i._id === inbox._id);
            expect(item?.status).toBe('waitingFor');
            expect(item?.waitingForPersonId).toBe(person._id);
        });
    });

    test('item status change syncs via SSE', async ({ browser }) => {
        const email = `status-sse-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const inbox = await gtd.collect(page1, 'Complete me');
            await gtd.flush(page1);
            await gtd.pull(page2);

            // Verify device-2 has the item
            await waitForItemByIdOnDevice(page2, inbox._id);

            // Device-1 marks it done and flushes — server sends SSE to device-2
            await gtd.clarifyToDone(page1, inbox);
            await gtd.flush(page1);

            // Poll device-2 for the status change (arrives via SSE → syncAndRefresh)
            await page2.evaluate(async (itemId) => {
                type Harness = { listItems(): Promise<Array<{ _id: string; status: string }>> };
                const harness = (window as unknown as { __gtd: Harness }).__gtd;
                const deadline = Date.now() + 15_000;
                while (Date.now() < deadline) {
                    const items = await harness.listItems();
                    const match = items.find((i) => i._id === itemId);
                    if (match?.status === 'done') return true;
                    await new Promise((r) => setTimeout(r, 300));
                }
                throw new Error('Status change did not arrive via SSE within 15s');
            }, inbox._id);
        });
    });

    test('item deletion syncs across devices', async ({ browser }) => {
        const email = `delete-sync-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const inbox = await gtd.collect(page1, 'Delete me');
            await gtd.flush(page1);
            await gtd.pull(page2);

            // Confirm device-2 has the item
            await waitForItemByIdOnDevice(page2, inbox._id);

            // Device-1 removes the item
            await gtd.removeItem(page1, inbox._id);
            await gtd.flush(page1);

            // Poll until the delete arrives on device-2 (may come via SSE or explicit pull).
            // A single pull() call can race with an SSE-triggered pull due to the pullInFlight guard.
            await page2.evaluate(async (itemId) => {
                type Harness = { pull(): Promise<void>; listItems(): Promise<Array<{ _id: string }>> };
                const harness = (window as unknown as { __gtd: Harness }).__gtd;
                const deadline = Date.now() + 10_000;
                while (Date.now() < deadline) {
                    await harness.pull();
                    const items = await harness.listItems();
                    if (!items.some((i) => i._id === itemId)) return true;
                    await new Promise((r) => setTimeout(r, 300));
                }
                throw new Error('Deleted item still present on device-2 after 10s');
            }, inbox._id);
        });
    });
});
