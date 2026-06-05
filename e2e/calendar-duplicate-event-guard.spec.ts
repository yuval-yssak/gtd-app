import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { closeContextQuietly, resetServerForEmails } from './helpers/context';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';

// Regression for the "duplicate standalone calendar item" bug: two concurrent inbound syncs (a manual
// `POST /integrations/:id/sync` racing a webhook delivery) both saw `findCalendarItemByEventId` miss and
// both `createNewCalendarItem` with a fresh UUID, leaving two byte-identical items for one GCal event.
// The fix adds a unique partial index `(user, calendarEventId)` over live `calendar` items plus an
// E11000 catch in `createNewCalendarItem` that re-resolves to the race winner and merges.
//
// Drives the single-event upsert path twice via /dev/calendar/simulate-webhook-event for the SAME new
// event id, mirroring two inbound deliveries. End-to-end assertion: exactly one calendar item lands.

const DEV_SEED_CALENDAR_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const DEV_SIMULATE_WEBHOOK_URL = 'http://localhost:4000/dev/calendar/simulate-webhook-event';
const CLIENT_URL = 'http://localhost:4173';

interface SeedCalendarResult {
    integrationId: string;
    configIds: string[];
}

async function seedCalendarForUser(
    userId: string,
    calendars: Array<{ configId: string; calendarId: string; displayName: string; isDefault: boolean }>,
): Promise<SeedCalendarResult> {
    const res = await fetch(DEV_SEED_CALENDAR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, calendars }),
    });
    if (!res.ok) {
        throw new Error(`seed calendar ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as SeedCalendarResult;
}

async function simulateWebhookEvent(body: {
    userId: string;
    integrationId: string;
    syncConfigId: string;
    event: { id: string; title: string; timeStart: string; timeEnd: string; updated: string; status: string; description?: string };
}): Promise<void> {
    const res = await fetch(DEV_SIMULATE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`simulate-webhook-event ${res.status}: ${await res.text()}`);
    }
}

async function liveItemsForEvent(page: Page, calendarEventId: string) {
    await gtd.pull(page);
    const items = await gtd.listItems(page);
    return items.filter((i) => i.calendarEventId === calendarEventId && i.status === 'calendar');
}

test.describe('calendar — duplicate-event create guard', () => {
    test('two inbound deliveries of the same new event produce exactly one calendar item', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `dup-guard-${stamp}@example.com`;
        const cfgId = `cfg-dup-${stamp}`;
        const eventId = `evt-dup-${stamp}`;
        await resetServerForEmails([email]);

        const ctx = await browser.newContext();
        try {
            const page = await loginAs(ctx, email);

            const userId = await page.evaluate(async () => {
                const dbReq = indexedDB.open('gtd-app');
                const db = await new Promise<IDBDatabase>((resolve, reject) => {
                    dbReq.onsuccess = () => resolve(dbReq.result);
                    dbReq.onerror = () => reject(dbReq.error);
                });
                return new Promise<string>((resolve) => {
                    const req = db.transaction('activeAccount').objectStore('activeAccount').get('active');
                    req.onsuccess = () => resolve((req.result as { userId: string }).userId);
                });
            });

            const seed = await seedCalendarForUser(userId, [{ configId: cfgId, calendarId: 'primary', displayName: 'Primary', isDefault: true }]);

            const futureStart = dayjs().add(2, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
            const futureEnd = dayjs().add(2, 'day').hour(11).minute(0).second(0).millisecond(0).toISOString();
            const event = { id: eventId, title: 'Team sync', timeStart: futureStart, timeEnd: futureEnd, updated: dayjs().toISOString(), status: 'confirmed' };

            // Two inbound deliveries of the SAME new event. The second create collides on the unique
            // index → the E11000 catch merges into the winner instead of producing a duplicate.
            await simulateWebhookEvent({ userId, integrationId: seed.integrationId, syncConfigId: cfgId, event });
            await simulateWebhookEvent({ userId, integrationId: seed.integrationId, syncConfigId: cfgId, event });

            await page.goto(`${CLIENT_URL}/calendar`);
            await expect.poll(async () => (await liveItemsForEvent(page, eventId)).length, { timeout: 10_000 }).toBe(1);

            // UI assertion — the calendar page shows the event exactly once.
            await expect(page.getByText('Team sync')).toHaveCount(1, { timeout: 10_000 });
        } finally {
            await closeContextQuietly(ctx);
        }
    });
});
