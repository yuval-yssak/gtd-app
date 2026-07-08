import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { closeContextQuietly, resetServerForEmails } from './helpers/context';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';

// E2E for the ACTIVE relink sweep (`relinkStrandedMarkers`): after a disconnect-with-keep +
// reconnect, entities whose `lastKnown*` marker events never arrive through a sync window (past or
// since-unmodified events — the stranded-marker bug) are resolved by fetching each event directly
// by id. Two scenarios:
//  1. The stranded-reschedule bug: item edited in-app while disconnected, GCal event frozen — the
//     sweep must relink AND push the local edit out to GCal.
//  2. Event deleted on GCal while disconnected (cancellation tombstone newer than any local touch)
//     — the sweep must mirror the deletion: trash with the cancelledByGCal badge.
//
// Real Google can't be driven in CI: reconnect is simulated by re-seeding the integration with the
// SAME id (making the markers' integration id provably ours again), and the sweep runs through
// /dev/calendar/simulate-relink-sweep, whose stub provider serves a caller-supplied event set and
// records what would have been pushed to GCal.

const CLIENT_URL = 'http://localhost:4173';
const SETTINGS_URL = `${CLIENT_URL}/settings`;
const DEV_SEED_CALENDAR_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const DEV_SIMULATE_WEBHOOK_URL = 'http://localhost:4000/dev/calendar/simulate-webhook-event';
const DEV_SIMULATE_RELINK_SWEEP_URL = 'http://localhost:4000/dev/calendar/simulate-relink-sweep';

async function postDevRoute<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`${url} → ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
}

async function seedCalendarForUser(userId: string, configId: string, integrationId: string): Promise<void> {
    await postDevRoute(DEV_SEED_CALENDAR_URL, {
        userId,
        integrationId,
        calendars: [{ configId, calendarId: 'primary', displayName: 'Primary', isDefault: true }],
    });
}

interface SweepResponse {
    relinkedItems: number;
    trashedItems: number;
    recreatedEvents: number;
    pushedUpdates: Array<{ eventId: string; updates: { timeStart?: string } }>;
    pushedCreates: Array<{ title: string; timeStart: string }>;
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

async function disconnectKeepInSettings(page: Page): Promise<void> {
    await page.goto(SETTINGS_URL);
    await expect(page.getByRole('button', { name: 'Disconnect' }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Disconnect' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Disconnect Google Calendar' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeHidden({ timeout: 10_000 });
}

/** Seeds a linked calendar item via an inbound webhook event and waits for the client to see it. */
async function seedLinkedItem(
    page: Page,
    userId: string,
    ids: { integrationId: string; configId: string; eventId: string },
    event: { title: string; timeStart: string; timeEnd: string; updated: string },
): Promise<void> {
    await postDevRoute(DEV_SIMULATE_WEBHOOK_URL, {
        userId,
        integrationId: ids.integrationId,
        syncConfigId: ids.configId,
        event: { id: ids.eventId, status: 'confirmed', ...event },
    });
    await expect
        .poll(async () => {
            await gtd.pull(page);
            return (await gtd.listItems(page)).filter((i) => i.calendarEventId === ids.eventId).length;
        })
        .toBe(1);
}

test.describe('active relink sweep for stranded lastKnown* markers', () => {
    test('stranded local reschedule: sweep relinks the item and pushes the new time to GCal', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `sweep-relink-${stamp}@example.com`;
        const configId = `cfg-sweep-${stamp}`;
        const eventId = `evt-sweep-${stamp}`;
        const integrationId = `int-sweep-${stamp}`;
        await resetServerForEmails([email]);

        const ctx = await browser.newContext();
        try {
            const page = await loginAs(ctx, email);
            const userId = await getActiveUserId(page);
            await seedCalendarForUser(userId, configId, integrationId);

            const frozenUpdated = dayjs().subtract(3, 'day').toISOString();
            const originalStart = dayjs().add(2, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
            const originalEnd = dayjs(originalStart).add(30, 'minute').toISOString();
            await seedLinkedItem(
                page,
                userId,
                { integrationId, configId, eventId },
                { title: 'Return the booster', timeStart: originalStart, timeEnd: originalEnd, updated: frozenUpdated },
            );

            // Disconnect-with-keep → the item's link fields become lastKnown* markers server-side.
            await disconnectKeepInSettings(page);
            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    return (await gtd.listItems(page)).find((i) => i.title === 'Return the booster')?.calendarIntegrationId;
                })
                .toBeUndefined();

            // Reschedule the item in-app while disconnected — the exact stranded-edit shape.
            const rescheduledStart = dayjs().add(6, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
            const rescheduledEnd = dayjs(rescheduledStart).add(30, 'minute').toISOString();
            const stranded = (await gtd.listItems(page)).find((i) => i.title === 'Return the booster');
            if (!stranded) {
                throw new Error('expected the stranded item to exist');
            }
            await gtd.updateItem(page, { ...stranded, timeStart: rescheduledStart, timeEnd: rescheduledEnd });
            await gtd.flush(page);

            // "Reconnect" by re-seeding the SAME integration id, then run the sweep with the GCal
            // event still frozen at its original time (updated unchanged — no sync window would
            // ever report it; only the sweep's direct fetch can).
            await seedCalendarForUser(userId, configId, integrationId);
            const sweep = await postDevRoute<SweepResponse>(DEV_SIMULATE_RELINK_SWEEP_URL, {
                userId,
                integrationId,
                events: [
                    {
                        id: eventId,
                        title: 'Return the booster',
                        timeStart: originalStart,
                        timeEnd: originalEnd,
                        updated: frozenUpdated,
                        status: 'confirmed',
                    },
                ],
            });
            expect(sweep.relinkedItems).toBe(1);
            // Local edit won: the sweep pushed the rescheduled time out to the frozen event.
            expect(sweep.pushedUpdates).toHaveLength(1);
            expect(sweep.pushedUpdates[0]?.eventId).toBe(eventId);
            expect(sweep.pushedUpdates[0]?.updates.timeStart).toBe(rescheduledStart);

            // The client converges on a single, relinked, still-rescheduled item.
            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    return (await gtd.listItems(page)).find((i) => i.title === 'Return the booster')?.calendarEventId;
                })
                .toBe(eventId);
            const items = (await gtd.listItems(page)).filter((i) => i.title === 'Return the booster');
            expect(items).toHaveLength(1);
            expect(items[0]?.calendarIntegrationId).toBe(integrationId);
            expect(items[0]?.timeStart).toBe(rescheduledStart);

            // The link is live again end-to-end: a subsequent inbound webhook moves the item.
            const movedStart = dayjs().add(8, 'day').hour(11).minute(0).second(0).millisecond(0).toISOString();
            const movedEnd = dayjs(movedStart).add(30, 'minute').toISOString();
            await postDevRoute(DEV_SIMULATE_WEBHOOK_URL, {
                userId,
                integrationId,
                syncConfigId: configId,
                event: {
                    id: eventId,
                    title: 'Return the booster',
                    timeStart: movedStart,
                    timeEnd: movedEnd,
                    updated: dayjs().add(10, 'second').toISOString(),
                    status: 'confirmed',
                },
            });
            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    return (await gtd.listItems(page)).find((i) => i.title === 'Return the booster')?.timeStart;
                })
                .toBe(movedStart);

            // UI: exactly one instance on /calendar.
            await page.goto(`${CLIENT_URL}/calendar`);
            await expect(page.getByText('Return the booster')).toHaveCount(1);
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('event deleted on GCal while disconnected: sweep trashes the stranded item with the cancelled badge', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `sweep-trash-${stamp}@example.com`;
        const configId = `cfg-sweeptrash-${stamp}`;
        const eventId = `evt-sweeptrash-${stamp}`;
        const integrationId = `int-sweeptrash-${stamp}`;
        await resetServerForEmails([email]);

        const ctx = await browser.newContext();
        try {
            const page = await loginAs(ctx, email);
            const userId = await getActiveUserId(page);
            await seedCalendarForUser(userId, configId, integrationId);

            const start = dayjs().add(3, 'day').hour(14).minute(0).second(0).millisecond(0).toISOString();
            const end = dayjs(start).add(1, 'hour').toISOString();
            await seedLinkedItem(
                page,
                userId,
                { integrationId, configId, eventId },
                { title: 'Meeting that got cancelled', timeStart: start, timeEnd: end, updated: dayjs().subtract(2, 'day').toISOString() },
            );

            await disconnectKeepInSettings(page);
            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    return (await gtd.listItems(page)).find((i) => i.title === 'Meeting that got cancelled')?.calendarIntegrationId;
                })
                .toBeUndefined();

            // Reconnect (same integration id) and sweep against a cancellation tombstone whose
            // `updated` postdates every local touch → the deletion wins.
            await seedCalendarForUser(userId, configId, integrationId);
            const sweep = await postDevRoute<SweepResponse>(DEV_SIMULATE_RELINK_SWEEP_URL, {
                userId,
                integrationId,
                events: [
                    {
                        id: eventId,
                        title: 'Meeting that got cancelled',
                        timeStart: start,
                        timeEnd: end,
                        updated: dayjs().add(1, 'minute').toISOString(),
                        status: 'cancelled',
                    },
                ],
            });
            expect(sweep.trashedItems).toBe(1);
            expect(sweep.pushedCreates).toHaveLength(0);

            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    return (await gtd.listItems(page)).find((i) => i.title === 'Meeting that got cancelled')?.status;
                })
                .toBe('trash');

            // UI: the trash view surfaces the "Cancelled in Calendar" chip.
            await page.goto(`${CLIENT_URL}/trash`);
            await expect(page.getByText('Meeting that got cancelled')).toBeVisible({ timeout: 10_000 });
            await expect(page.getByText('Cancelled in Calendar')).toBeVisible();
        } finally {
            await closeContextQuietly(ctx);
        }
    });
});
