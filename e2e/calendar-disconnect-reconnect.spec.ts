import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails } from './helpers/context';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';

// E2E for the GCal disconnect/reconnect idempotency fix. Two regressions covered:
//  1. After `keepLinkedEntities` + reconnect, the same GCal event must relink the existing
//     (now-naked) item rather than creating a duplicate.
//  2. After `removeLinkedEntities` + reconnect, a previously-`done` item must stay `done`
//     (treated as terminal) rather than being resurrected as a live `calendar` item.
//
// We can't drive a real Google OAuth flow in CI, so disconnect goes through the Settings UI
// and reconnect is simulated by re-seeding the integration via /dev/calendar/seed-integration.
// Inbound GCal payloads use /dev/calendar/simulate-webhook-event (the same hook used by
// calendar-revive-trashed.spec.ts).

const SETTINGS_URL = 'http://localhost:4173/settings';
const CLIENT_URL = 'http://localhost:4173';
const DEV_SEED_CALENDAR_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const DEV_SIMULATE_WEBHOOK_URL = 'http://localhost:4000/dev/calendar/simulate-webhook-event';

interface SeedCalendarResult {
    integrationId: string;
    configIds: string[];
}

async function seedCalendarForUser(
    userId: string,
    calendars: Array<{ configId: string; calendarId: string; displayName: string; isDefault: boolean }>,
    integrationId?: string,
): Promise<SeedCalendarResult> {
    const res = await fetch(DEV_SEED_CALENDAR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, calendars, ...(integrationId ? { integrationId } : {}) }),
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

async function getActiveUserId(page: Page): Promise<string> {
    return page.evaluate(async () => {
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
}

async function clickDisconnectInSettings(page: Page, removeLinkedEntities: boolean): Promise<void> {
    await page.goto(SETTINGS_URL);
    await expect(page.getByRole('button', { name: 'Disconnect' }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Disconnect' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Disconnect Google Calendar' });
    await expect(dialog).toBeVisible();
    if (removeLinkedEntities) {
        await dialog.getByText(/Remove calendar items and calendar routines from GTD/).click();
    }
    await dialog.getByRole('button', { name: 'Disconnect' }).click();
    // Settings row disappears once the DELETE completes.
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeHidden({ timeout: 10_000 });
}

test.describe('calendar disconnect/reconnect idempotency', () => {
    test('keepLinkedEntities + reconnect relinks the same event without creating a duplicate', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `dr-keep-${stamp}@example.com`;
        const cfgId = `cfg-keep-${stamp}`;
        const eventId = `evt-keep-${stamp}`;
        const integrationId = `int-keep-${stamp}`;
        await resetServerForEmails([email]);

        const ctx = await browser.newContext();
        try {
            const page = await loginAs(ctx, email);
            const userId = await getActiveUserId(page);

            // Seed integration #1 + push an inbound GCal event so the item is created and linked.
            await seedCalendarForUser(userId, [{ configId: cfgId, calendarId: 'primary', displayName: 'Primary', isDefault: true }], integrationId);
            const futureStart = dayjs().add(2, 'day').hour(15).minute(0).second(0).millisecond(0).toISOString();
            const futureEnd = dayjs(futureStart).add(1, 'hour').toISOString();
            await simulateWebhookEvent({
                userId,
                integrationId,
                syncConfigId: cfgId,
                event: { id: eventId, title: 'C2', timeStart: futureStart, timeEnd: futureEnd, updated: dayjs().toISOString(), status: 'confirmed' },
            });
            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    return (await gtd.listItems(page)).filter((i) => i.title === 'C2').length;
                })
                .toBe(1);

            // Disconnect with keepLinkedEntities → the linked item becomes "naked" (link fields cleared).
            await clickDisconnectInSettings(page, false);
            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    return (await gtd.listItems(page)).find((i) => i.title === 'C2')?.calendarIntegrationId;
                })
                .toBeUndefined();

            // Reconnect: re-seed the same integration id + same syncConfigId, then push the same
            // GCal event with a fresh `id` (Google would assign a new id on a fresh integration).
            await seedCalendarForUser(userId, [{ configId: cfgId, calendarId: 'primary', displayName: 'Primary', isDefault: true }], integrationId);
            const newEventId = `${eventId}-after-reconnect`;
            await simulateWebhookEvent({
                userId,
                integrationId,
                syncConfigId: cfgId,
                event: { id: newEventId, title: 'C2', timeStart: futureStart, timeEnd: futureEnd, updated: dayjs().toISOString(), status: 'confirmed' },
            });

            // Assert: still exactly one C2; relinked to the new event id.
            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    return (await gtd.listItems(page)).filter((i) => i.title === 'C2').length;
                })
                .toBe(1);
            const items = await gtd.listItems(page);
            const c2 = items.find((i) => i.title === 'C2');
            expect(c2?.calendarEventId).toBe(newEventId);
            expect(c2?.calendarIntegrationId).toBe(integrationId);

            // Idempotency: re-running the same webhook payload must not double-write.
            await simulateWebhookEvent({
                userId,
                integrationId,
                syncConfigId: cfgId,
                event: { id: newEventId, title: 'C2', timeStart: futureStart, timeEnd: futureEnd, updated: dayjs().toISOString(), status: 'confirmed' },
            });
            await gtd.pull(page);
            expect((await gtd.listItems(page)).filter((i) => i.title === 'C2')).toHaveLength(1);

            // UI assertion — exactly one C2 visible on /calendar.
            await page.goto(`${CLIENT_URL}/calendar`);
            await expect(page.getByText('C2')).toHaveCount(1);
        } finally {
            await ctx.close();
        }
    });

    test('removeLinkedEntities preserves done items and reconnect does not resurrect them', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `dr-remove-done-${stamp}@example.com`;
        const cfgId = `cfg-remove-${stamp}`;
        const eventId = `evt-remove-${stamp}`;
        const integrationId = `int-remove-${stamp}`;
        await resetServerForEmails([email]);

        const ctx = await browser.newContext();
        try {
            const page = await loginAs(ctx, email);
            const userId = await getActiveUserId(page);

            await seedCalendarForUser(userId, [{ configId: cfgId, calendarId: 'primary', displayName: 'Primary', isDefault: true }], integrationId);
            const futureStart = dayjs().add(2, 'day').hour(15).minute(30).second(0).millisecond(0).toISOString();
            const futureEnd = dayjs(futureStart).add(1, 'hour').toISOString();

            // Inbound event creates the linked item.
            await simulateWebhookEvent({
                userId,
                integrationId,
                syncConfigId: cfgId,
                event: {
                    id: eventId,
                    title: 'Cross-account smoke 1 (moved)',
                    timeStart: futureStart,
                    timeEnd: futureEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            });
            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    return (await gtd.listItems(page)).find((i) => i.calendarEventId === eventId)?.status;
                })
                .toBe('calendar');

            // Mark it done locally and flush to the server.
            const items = await gtd.listItems(page);
            const target = items.find((i) => i.calendarEventId === eventId);
            if (!target) {
                throw new Error(`expected to find item with calendarEventId=${eventId}`);
            }
            await gtd.clarifyToDone(page, target);
            await gtd.flush(page);

            // Disconnect with removeLinkedEntities. Done items must be unlinked, not trashed.
            await clickDisconnectInSettings(page, true);
            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    const it = (await gtd.listItems(page)).find((i) => i._id === target._id);
                    return { status: it?.status, integrationId: it?.calendarIntegrationId };
                })
                .toEqual({ status: 'done', integrationId: undefined });

            // Reconnect with a fresh-looking integration id but the same syncConfigId/calendar.
            await seedCalendarForUser(userId, [{ configId: cfgId, calendarId: 'primary', displayName: 'Primary', isDefault: true }], integrationId);
            // Inbound event for the same time/title — could be the same gcal id (calendar.google
            // re-uses ids per calendar) or a new one. We use a new id to model the worst case.
            const newEventId = `${eventId}-after-reconnect`;
            await simulateWebhookEvent({
                userId,
                integrationId,
                syncConfigId: cfgId,
                event: {
                    id: newEventId,
                    title: 'Cross-account smoke 1 (moved)',
                    timeStart: futureStart,
                    timeEnd: futureEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            });

            // Assert: one row, still done, no live 'calendar' twin.
            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    return (await gtd.listItems(page)).filter((i) => i.title === 'Cross-account smoke 1 (moved)').map((i) => i.status);
                })
                .toEqual(['done']);
            const after = (await gtd.listItems(page)).find((i) => i.title === 'Cross-account smoke 1 (moved)');
            expect(after?._id).toBe(target._id);
            expect(after?.calendarEventId).toBe(newEventId);

            // The done item must NOT appear as a live event on /calendar.
            await page.goto(`${CLIENT_URL}/calendar`);
            await expect(page.getByText('Cross-account smoke 1 (moved)')).toBeHidden();
        } finally {
            await ctx.close();
        }
    });
});
