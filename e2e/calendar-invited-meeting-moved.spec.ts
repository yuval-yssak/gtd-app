import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { closeContextQuietly, resetServerForEmails } from './helpers/context';
import { gtd } from './helpers/gtd';
import { loginAs } from './helpers/login';

// Repro investigation: "another person organizes a meeting with me, it syncs into the app,
// I accept it, then the organizer moves it forward in time — IndexedDB never picks up the
// new time until I sign out and back in."
//
// Drives the inbound single-event path via /dev/calendar/simulate-webhook-event (same code
// path a real Google webhook delivery takes) and asserts the client's IDB row tracks the
// moved timeStart after a /sync/pull.

const DEV_SEED_CALENDAR_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const DEV_SIMULATE_WEBHOOK_URL = 'http://localhost:4000/dev/calendar/simulate-webhook-event';
const CLIENT_URL = 'http://localhost:4173';

interface SeedCalendarResult {
    integrationId: string;
    configIds: string[];
}

interface InboundAttendee {
    email: string;
    responseStatus: 'needsAction' | 'accepted' | 'declined' | 'tentative';
    self?: boolean;
    displayName?: string;
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
    event: {
        id: string;
        title: string;
        timeStart: string;
        timeEnd: string;
        updated: string;
        status: string;
        organizer?: { email: string; displayName?: string };
        attendees?: InboundAttendee[];
        responseStatus?: string;
    };
    nowOverride?: string;
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

async function pullAndFindTimeStart(page: Page, calendarEventId: string): Promise<string | undefined> {
    await gtd.pull(page);
    const items = await gtd.listItems(page);
    return items.find((i) => i.calendarEventId === calendarEventId)?.timeStart;
}

async function readActiveUserId(page: Page): Promise<string> {
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

test.describe('calendar — invited meeting moved by organizer', () => {
    test('move WITHOUT prior RSVP propagates to IDB (control)', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `invited-move-plain-${stamp}@example.com`;
        const cfgId = `cfg-invmove-plain-${stamp}`;
        const eventId = `evt-invmove-plain-${stamp}`;
        await resetServerForEmails([email]);

        const ctx = await browser.newContext();
        try {
            const page = await loginAs(ctx, email);
            const userId = await readActiveUserId(page);
            const seed = await seedCalendarForUser(userId, [{ configId: cfgId, calendarId: 'primary', displayName: 'Primary', isDefault: true }]);

            const start = dayjs().add(2, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
            const end = dayjs(start).add(1, 'hour').toISOString();
            await simulateWebhookEvent({
                userId,
                integrationId: seed.integrationId,
                syncConfigId: cfgId,
                event: {
                    id: eventId,
                    title: 'Planning sync',
                    timeStart: start,
                    timeEnd: end,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    organizer: { email: 'organizer@example.com', displayName: 'Olive Organizer' },
                    attendees: [
                        { email, responseStatus: 'needsAction', self: true },
                        { email: 'organizer@example.com', responseStatus: 'accepted' },
                    ],
                },
            });

            await page.goto(`${CLIENT_URL}/calendar`);
            await expect.poll(async () => pullAndFindTimeStart(page, eventId), { timeout: 10_000 }).toBe(start);

            // Organizer moves the meeting forward two hours.
            const movedStart = dayjs(start).add(2, 'hour').toISOString();
            const movedEnd = dayjs(movedStart).add(1, 'hour').toISOString();
            await simulateWebhookEvent({
                userId,
                integrationId: seed.integrationId,
                syncConfigId: cfgId,
                event: {
                    id: eventId,
                    title: 'Planning sync',
                    timeStart: movedStart,
                    timeEnd: movedEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    organizer: { email: 'organizer@example.com', displayName: 'Olive Organizer' },
                    attendees: [
                        { email, responseStatus: 'needsAction', self: true },
                        { email: 'organizer@example.com', responseStatus: 'accepted' },
                    ],
                },
            });

            await expect.poll(async () => pullAndFindTimeStart(page, eventId), { timeout: 10_000 }).toBe(movedStart);
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('accept in-app, then organizer moves the meeting — IDB must track the new time', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `invited-move-rsvp-${stamp}@example.com`;
        const cfgId = `cfg-invmove-rsvp-${stamp}`;
        const eventId = `evt-invmove-rsvp-${stamp}`;
        await resetServerForEmails([email]);

        const ctx = await browser.newContext();
        try {
            const page = await loginAs(ctx, email);
            const userId = await readActiveUserId(page);
            const seed = await seedCalendarForUser(userId, [{ configId: cfgId, calendarId: 'primary', displayName: 'Primary', isDefault: true }]);

            const start = dayjs().add(2, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
            const end = dayjs(start).add(1, 'hour').toISOString();
            await simulateWebhookEvent({
                userId,
                integrationId: seed.integrationId,
                syncConfigId: cfgId,
                event: {
                    id: eventId,
                    title: 'Roadmap review',
                    timeStart: start,
                    timeEnd: end,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    organizer: { email: 'organizer@example.com', displayName: 'Olive Organizer' },
                    attendees: [
                        { email, responseStatus: 'needsAction', self: true },
                        { email: 'organizer@example.com', responseStatus: 'accepted' },
                    ],
                },
            });

            await page.goto(`${CLIENT_URL}/calendar`);
            await expect.poll(async () => pullAndFindTimeStart(page, eventId), { timeout: 10_000 }).toBe(start);

            // Accept the meeting in the item editor. The online RSVP fast-path fails in e2e (the
            // seeded integration has fake tokens), so this exercises the offline-fallback local
            // write + queued rsvp op — the local IDB row gets a fresh client-stamped updatedTs
            // either way the user perceives "I accepted the meeting".
            await page.waitForSelector('text=Roadmap review');
            await page.getByTestId('calendarItemEditButton').first().click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            await dialog.getByTestId('meetingDetailsSummary').click();
            await dialog.getByTestId('rsvp-accepted').click();
            // Wait for the online-attempt → offline-fallback chain to land the optimistic RSVP in
            // IDB (deterministic, unlike a fixed sleep), then close the editor.
            await expect
                .poll(async () => (await gtd.listItems(page)).find((i) => i.calendarEventId === eventId)?.responseStatus, { timeout: 15_000 })
                .toBe('accepted');
            await page.keyboard.press('Escape');
            await gtd.flush(page);

            // Organizer moves the meeting forward two hours (self already accepted on the GCal copy).
            const movedStart = dayjs(start).add(2, 'hour').toISOString();
            const movedEnd = dayjs(movedStart).add(1, 'hour').toISOString();
            await simulateWebhookEvent({
                userId,
                integrationId: seed.integrationId,
                syncConfigId: cfgId,
                event: {
                    id: eventId,
                    title: 'Roadmap review',
                    timeStart: movedStart,
                    timeEnd: movedEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    organizer: { email: 'organizer@example.com', displayName: 'Olive Organizer' },
                    attendees: [
                        { email, responseStatus: 'accepted', self: true },
                        { email: 'organizer@example.com', responseStatus: 'accepted' },
                    ],
                },
            });

            // The reported bug: this poll would time out with timeStart stuck at `start`.
            await expect.poll(async () => pullAndFindTimeStart(page, eventId), { timeout: 10_000 }).toBe(movedStart);
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    // Regression for the op-loss mechanism behind the report: a webhook sync run captures `ctx.now`
    // BEFORE its (slow) Google API calls, and the client's pull cursor is strictly forward-only
    // over `(ts, _id)`. Pre-fix, ops were stamped with that stale run-start clock as `ts`, so a
    // client that pushed + pulled anything while the run was in flight permanently skipped the move
    // op — server correct, IDB stale until a sign-out/in re-bootstrap. Ops now take their `(ts,
    // _id)` from the wall clock at write time (lib/opIdentity.ts), so the backdated `nowOverride`
    // below still yields a deliverable op and IDB converges on the moved time.
    test('op recorded by a stale-clocked sync run still reaches a device whose cursor has advanced', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `invited-move-stale-${stamp}@example.com`;
        const cfgId = `cfg-invmove-stale-${stamp}`;
        const eventId = `evt-invmove-stale-${stamp}`;
        await resetServerForEmails([email]);

        const ctx = await browser.newContext();
        try {
            const page = await loginAs(ctx, email);
            const userId = await readActiveUserId(page);
            const seed = await seedCalendarForUser(userId, [{ configId: cfgId, calendarId: 'primary', displayName: 'Primary', isDefault: true }]);

            const start = dayjs().add(2, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
            const end = dayjs(start).add(1, 'hour').toISOString();
            await simulateWebhookEvent({
                userId,
                integrationId: seed.integrationId,
                syncConfigId: cfgId,
                event: { id: eventId, title: 'Design review', timeStart: start, timeEnd: end, updated: dayjs().toISOString(), status: 'confirmed' },
            });
            await page.goto(`${CLIENT_URL}/calendar`);
            await expect.poll(async () => pullAndFindTimeStart(page, eventId), { timeout: 10_000 }).toBe(start);

            // The webhook sync run "starts" here — its clock is captured before the provider calls.
            const runStartClock = dayjs().toISOString();

            // Meanwhile the user makes any unrelated edit; flush + pull advances the device cursor
            // past `runStartClock` (the pull returns the device's own pushed op). The short sleep is
            // load-bearing: it guarantees the pushed op's server-stamped ts is strictly greater than
            // `runStartClock`, so the cursor definitively passes it.
            await new Promise((resolve) => setTimeout(resolve, 20));
            await gtd.collect(page, 'Unrelated capture while webhook run is in flight');
            await gtd.flush(page);
            await gtd.pull(page);

            // The webhook run now finishes its provider calls and writes the move — with the stale
            // run-start ts on the recorded op.
            const movedStart = dayjs(start).add(2, 'hour').toISOString();
            const movedEnd = dayjs(movedStart).add(1, 'hour').toISOString();
            await simulateWebhookEvent({
                userId,
                integrationId: seed.integrationId,
                syncConfigId: cfgId,
                event: { id: eventId, title: 'Design review', timeStart: movedStart, timeEnd: movedEnd, updated: dayjs().toISOString(), status: 'confirmed' },
                nowOverride: runStartClock,
            });

            // Server ground truth has the moved time, and — the fix — the next pull delivers it to
            // IDB even though the run's clock (and the snapshot's updatedTs) predate the cursor.
            const serverRes = await fetch(`http://localhost:4000/dev/reassign/find-entity?collection=items&user=${encodeURIComponent(userId)}&status=calendar`);
            const { doc } = (await serverRes.json()) as { doc: { timeStart?: string } | null };
            expect(doc?.timeStart).toBe(movedStart);

            await expect.poll(async () => pullAndFindTimeStart(page, eventId), { timeout: 10_000 }).toBe(movedStart);
        } finally {
            await closeContextQuietly(ctx);
        }
    });
});
