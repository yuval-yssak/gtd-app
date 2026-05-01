import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails } from './helpers/context';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';

// Regression for the "GCal sync conflict-anchor decoupled from local trash stamps" plan.
// A user disconnects a calendar (which trashes its items and bumps `updatedTs` to now), then
// reconnects. A future-confirmed event whose stored row is `status: 'trash'` with `updatedTs`
// later than `event.updated` used to fail to revive — pre-fix the structural-newer guard
// compared `event.updated` against `existing.updatedTs`, so the local trash stamp permanently
// blocked GCal from reasserting state. The fix: introduce `lastSyncedFromGCalTs`, use it as
// the inbound conflict anchor, and add an unconditional revive branch in `upsertCalendarItem`.
//
// Drives the single-event upsert path via /dev/calendar/simulate-webhook-event, mirroring the
// shape a real Google Calendar webhook would deliver. End-to-end UI assertion: the item appears
// on /calendar after the revive.

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

async function pullAndCount(page: Page, calendarEventId: string): Promise<{ status: string | undefined } | null> {
    // Drive a fresh /sync/pull so the server-side ops produced by simulateWebhookEvent reach IDB.
    await gtd.pull(page);
    const items = await gtd.listItems(page);
    const item = items.find((i) => i.calendarEventId === calendarEventId);
    return item ? { status: item.status } : null;
}

test.describe('calendar — revive trashed item on inbound GCal payload', () => {
    test('confirmed → cancelled → confirmed (with stale event.updated) round-trips status correctly', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `revive-${stamp}@example.com`;
        const cfgId = `cfg-revive-${stamp}`;
        const eventId = `evt-revive-${stamp}`;
        await resetServerForEmails([email]);

        const ctx = await browser.newContext();
        try {
            const page = await loginAs(ctx, email);

            // Find the user's id via the active account in IDB so we can seed an integration
            // under it. (loginAs writes the active account during /auth/callback.)
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

            // 1) Confirmed event arrives → item appears on /calendar.
            const t0 = dayjs().toISOString();
            await simulateWebhookEvent({
                userId,
                integrationId: seed.integrationId,
                syncConfigId: cfgId,
                event: { id: eventId, title: 'Smoke event', timeStart: futureStart, timeEnd: futureEnd, updated: t0, status: 'confirmed' },
            });
            await page.goto(`${CLIENT_URL}/calendar`);
            await expect.poll(async () => (await pullAndCount(page, eventId))?.status, { timeout: 10_000 }).toBe('calendar');

            // 2) Cancelled event for the same id → item disappears (trashed locally).
            await simulateWebhookEvent({
                userId,
                integrationId: seed.integrationId,
                syncConfigId: cfgId,
                event: { id: eventId, title: 'Smoke event', timeStart: futureStart, timeEnd: futureEnd, updated: dayjs().toISOString(), status: 'cancelled' },
            });
            await expect.poll(async () => (await pullAndCount(page, eventId))?.status, { timeout: 10_000 }).toBe('trash');

            // 3) Confirmed event arrives AGAIN with `event.updated` *earlier* than the local trash
            //    stamp. Pre-fix, the structural-newer guard compared `event.updated` against the
            //    trash-bumped `updatedTs` and skipped the apply, leaving the item trashed forever.
            //    Post-fix, the revive branch unconditionally restores `status: 'calendar'`.
            const stalerUpdated = dayjs(t0).subtract(1, 'minute').toISOString();
            await simulateWebhookEvent({
                userId,
                integrationId: seed.integrationId,
                syncConfigId: cfgId,
                event: { id: eventId, title: 'Smoke event (revived)', timeStart: futureStart, timeEnd: futureEnd, updated: stalerUpdated, status: 'confirmed' },
            });
            await expect.poll(async () => (await pullAndCount(page, eventId))?.status, { timeout: 10_000 }).toBe('calendar');

            // UI assertion — the calendar page shows the revived event.
            await page.goto(`${CLIENT_URL}/calendar`);
            await expect(page.getByText('Smoke event (revived)')).toBeVisible({ timeout: 10_000 });
        } finally {
            await ctx.close();
        }
    });
});
