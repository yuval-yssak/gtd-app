import { createHash } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { closeContextQuietly, resetServerForEmails } from './helpers/context';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';

// Regression for the 2026-09-27 production incident: a calendar item completed (or edited) before
// the client pulled the Google link the server stamped after `events.insert` lost the link on the
// server (whole-snapshot apply), so the ✓ done marker never reached Google and the event was
// orphaned. Three legs:
//  1. done inside the window → the server carries the link forward; the device learns it on pull.
//  2. a plain edit inside the window → same (pre-fix this minted a second Google event).
//  3. the repair for rows already orphaned: the relink sweep probes Google for the deterministic
//     event id of a link-less done item and re-links it, pushing the ✓ marker.
//
// Real Google can't be driven in CI: the server-side link stamp runs through
// /dev/calendar/simulate-link-stamp (the real `stampItemCalendarLink` + fan-out, minus the Google
// insert), and the repair sweep through /dev/calendar/simulate-relink-sweep, whose stub provider
// serves a caller-supplied event set and records what would have been pushed.

const DEV_SEED_CALENDAR_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const DEV_SIMULATE_LINK_STAMP_URL = 'http://localhost:4000/dev/calendar/simulate-link-stamp';
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

/** Mirrors `buildDeterministicGCalId` in api-server/src/calendarProviders/GoogleCalendarProvider.ts. */
function deterministicGCalId(itemId: string, integrationId: string): string {
    const digest = createHash('sha256').update(`${itemId}:${integrationId}`).digest('hex');
    return `gtd${digest.slice(0, 29)}`;
}

async function getActiveUserId(page: Page): Promise<string> {
    const userId = await gtd.getActiveAccountId(page);
    if (!userId) {
        throw new Error('expected an active account');
    }
    return userId;
}

/** A calendar item the server knows but has NOT linked yet (no integration → pushback no-ops). */
async function createUnlinkedCalendarItem(page: Page, title: string) {
    const inbox = await gtd.collect(page, title);
    const start = dayjs().add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
    const item = await gtd.clarifyToCalendar(page, inbox, { timeStart: start, timeEnd: dayjs(start).add(1, 'hour').toISOString() });
    await gtd.flush(page);
    return item;
}

/** The server-side stamp pushback writes after a successful Google create. */
async function stampLinkOnServer(userId: string, itemId: string, eventId: string): Promise<void> {
    await postDevRoute(DEV_SIMULATE_LINK_STAMP_URL, {
        userId,
        itemId,
        calendarEventId: eventId,
        calendarIntegrationId: `int-lcf-${eventId}`,
        calendarSyncConfigId: `cfg-lcf-${eventId}`,
        htmlLink: `https://calendar.google.com/event?eid=${eventId}`,
    });
}

async function serverRow(page: Page, itemId: string) {
    const bootstrap = await gtd.fetchBootstrap(page);
    return bootstrap.items.find((i) => i._id === itemId);
}

test.describe('calendar link carry-forward (edit before the Google link round-trips)', () => {
    test('marking done while the link is still in flight keeps the link on the server and delivers it to the device', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `link-cf-done-${stamp}@example.com`;
        const eventId = `gtd-evt-done-${stamp}`;
        await resetServerForEmails([email]);

        // No Service Worker in this context: its background-sync flush would push the done op behind
        // the route below (routes don't see SW requests), and the own-op echo would then deliver the
        // link regardless of the client merge this test is about.
        const ctx = await browser.newContext({ serviceWorkers: 'block' });
        try {
            const page = await loginAs(ctx, email);
            const userId = await getActiveUserId(page);
            const item = await createUnlinkedCalendarItem(page, 'Demo: sync to Google Calendar');

            // The race, made deterministic: the device goes offline, the server links the item
            // meanwhile (the device never hears about it), the user marks it done offline.
            await ctx.setOffline(true);
            await stampLinkOnServer(userId, item._id, eventId);
            await gtd.clarifyToDone(page, item);

            // Device leg first, with the done op still queued (pull-only, push held back): no own-op
            // echo can exist yet, so only the client's field-level merge of the (older, LWW-losing)
            // link-stamp op can deliver the link. The route goes in BEFORE going online so the
            // `online`-event auto-flush cannot slip the done op through ahead of it.
            await ctx.route('**/sync/push', (route) => route.fulfill({ status: 503, body: 'held back by the spec' }));
            await ctx.setOffline(false);
            await gtd.pullOnly(page);
            const localBeforePush = (await gtd.listItems(page)).find((i) => i._id === item._id);
            expect(localBeforePush?.status).toBe('done');
            expect(localBeforePush?.calendarEventId).toBe(eventId);
            expect(localBeforePush?.htmlLink).toBe(`https://calendar.google.com/event?eid=${eventId}`);
            await ctx.unroute('**/sync/push');

            // Server leg: the done op (whose snapshot the device built before it knew the link) applies
            // AND the link survives it.
            await gtd.flush(page);
            const onServer = await serverRow(page, item._id);
            expect(onServer?.status).toBe('done');
            expect(onServer?.calendarEventId).toBe(eventId);
            expect(onServer?.calendarIntegrationId).toBe(`int-lcf-${eventId}`);
            expect(onServer?.htmlLink).toBe(`https://calendar.google.com/event?eid=${eventId}`);
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('editing while the link is still in flight keeps the link (no second event minted)', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `link-cf-edit-${stamp}@example.com`;
        const eventId = `gtd-evt-edit-${stamp}`;
        await resetServerForEmails([email]);

        const ctx = await browser.newContext();
        try {
            const page = await loginAs(ctx, email);
            const userId = await getActiveUserId(page);
            const item = await createUnlinkedCalendarItem(page, 'Dentist');

            await ctx.setOffline(true);
            await stampLinkOnServer(userId, item._id, eventId);
            await gtd.updateItem(page, { ...item, title: 'Dentist (moved)' });
            await ctx.setOffline(false);
            await gtd.flush(page);

            const onServer = await serverRow(page, item._id);
            expect(onServer?.status).toBe('calendar');
            expect(onServer?.title).toBe('Dentist (moved)');
            expect(onServer?.calendarEventId).toBe(eventId);

            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    const local = (await gtd.listItems(page)).find((i) => i._id === item._id);
                    return `${local?.title}|${local?.calendarEventId}`;
                })
                .toBe(`Dentist (moved)|${eventId}`);
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('the repair sweep re-links an already-orphaned done item by its deterministic event id and pushes the ✓ marker', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `link-cf-repair-${stamp}@example.com`;
        const integrationId = `int-repair-${stamp}`;
        const configId = `cfg-repair-${stamp}`;
        await resetServerForEmails([email]);

        const ctx = await browser.newContext();
        try {
            const page = await loginAs(ctx, email);
            const userId = await getActiveUserId(page);
            // The integration exists first (the repair only considers rows updated after it was
            // connected), then the pre-fix leftover: completed in-app, Google has the event, the row
            // has no link. Pushback against this fake integration fails harmlessly (no real Google).
            await postDevRoute(DEV_SEED_CALENDAR_URL, {
                userId,
                integrationId,
                calendars: [{ configId, calendarId: 'primary', displayName: 'Primary', isDefault: true }],
            });
            const item = await createUnlinkedCalendarItem(page, 'Orphaned demo');
            await gtd.clarifyToDone(page, item);
            await gtd.flush(page);
            const eventId = deterministicGCalId(item._id, integrationId);
            const sweep = await postDevRoute<{
                relinkedDoneItems: number;
                pushedUpdates: Array<{ eventId: string; updates: { title?: string; colorId?: string } }>;
            }>(DEV_SIMULATE_RELINK_SWEEP_URL, {
                userId,
                integrationId,
                events: [
                    {
                        id: eventId,
                        title: 'Orphaned demo',
                        timeStart: item.timeStart,
                        timeEnd: item.timeEnd,
                        updated: dayjs().subtract(1, 'hour').toISOString(),
                        status: 'confirmed',
                        htmlLink: `https://calendar.google.com/event?eid=${eventId}`,
                    },
                ],
            });

            expect(sweep.relinkedDoneItems).toBe(1);
            const marker = sweep.pushedUpdates.find((u) => u.eventId === eventId);
            expect(marker?.updates.title).toBe('✓ Orphaned demo');
            expect(marker?.updates.colorId).toBe('2');

            // The device learns the repaired link (and the deep link the repair captured) through the recorded op.
            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    const local = (await gtd.listItems(page)).find((i) => i._id === item._id);
                    return `${local?.status}|${local?.calendarEventId}|${local?.htmlLink}`;
                })
                .toBe(`done|${eventId}|https://calendar.google.com/event?eid=${eventId}`);
        } finally {
            await closeContextQuietly(ctx);
        }
    });
});
