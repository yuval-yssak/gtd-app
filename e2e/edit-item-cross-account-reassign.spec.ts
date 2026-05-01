import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// E2e coverage for the atomic cross-account "edit + move" path. Pre-fix, EditItemDialog wrote a
// source-user copy first via updateItem→/sync/push and THEN called /sync/reassign — but the
// active session at flush time was usually the *target* user (the cross-account view shows items
// from every account), so the snapshot landed under the wrong user before reassign could find it.
// The fix: when ownerChanged, the server is the only writer — one atomic /sync/reassign call
// with an editPatch that carries the dialog's edits.
//
// These specs hit the /sync/reassign endpoint directly with editPatch (server-side state is the
// load-bearing assertion). The dialog's UI wiring is covered by the buildEditPatch unit tests
// and the calendar-picker spec; here we lock in the round-trip.

const DEV_SEED_CALENDAR_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const DEV_SEED_ENTITY_URL = 'http://localhost:4000/dev/reassign/seed-entity';
const DEV_FIND_ENTITY_URL = 'http://localhost:4000/dev/reassign/find-entity';
const INBOX_URL = 'http://localhost:4173/inbox';

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

async function seedItemOnServer(userId: string, title: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const id = `seed-${Math.random().toString(36).slice(2, 10)}`;
    const now = dayjs().toISOString();
    const doc = { _id: id, user: userId, status: 'inbox', title, createdTs: now, updatedTs: now, ...overrides };
    const res = await fetch(DEV_SEED_ENTITY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'items', doc }),
    });
    if (!res.ok) {
        throw new Error(`seed item ${res.status}: ${await res.text()}`);
    }
    return id;
}

interface ServerItem {
    _id: string;
    user: string;
    title: string;
    notes?: string;
    timeStart?: string;
    timeEnd?: string;
    workContextIds?: string[];
    peopleIds?: string[];
    energy?: string;
    time?: number;
    urgent?: boolean;
    focus?: boolean;
    expectedBy?: string;
    calendarEventId?: string;
    calendarIntegrationId?: string;
    calendarSyncConfigId?: string;
}

async function fetchServerItem(entityId: string): Promise<ServerItem | null> {
    const res = await fetch(`${DEV_FIND_ENTITY_URL}?collection=items&entityId=${entityId}`);
    if (!res.ok) {
        return null;
    }
    const body = (await res.json()) as { doc: ServerItem | null };
    return body.doc;
}

test.describe('EditItemDialog cross-account reassign — atomic edit + move', () => {
    // Each test scopes its /dev/reset to its unique stamped emails so concurrent specs in
    // other workers keep their session/user data.
    test('calendar item with edits: title + time changes ride along on the move; new GCal event lives on target calendar', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `cal-edit-a-${stamp}@example.com`;
        const emailB = `cal-edit-b-${stamp}@example.com`;
        // configIds carry the stamp so parallel workers don't collide on _id (the configs collection
        // is keyed by _id, so two tests trying to seed the same configId race on insertOne).
        const cfgA = `cfg-a-${stamp}`;
        const cfgB = `cfg-b-${stamp}`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const seedA = await seedCalendarForUser(active.userId, [
                { configId: cfgA, calendarId: 'primary', displayName: 'A Primary', isDefault: true },
            ]);
            const seedB = await seedCalendarForUser(secondary.userId, [
                { configId: cfgB, calendarId: 'primary', displayName: 'B Primary', isDefault: true },
            ]);

            const originalStart = dayjs().add(1, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
            const originalEnd = dayjs().add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
            const itemId = await seedItemOnServer(active.userId, 'Original title', {
                status: 'calendar',
                notes: 'old notes',
                calendarEventId: 'gcal-evt-original',
                calendarIntegrationId: seedA.integrationId,
                calendarSyncConfigId: cfgA,
                timeStart: originalStart,
                timeEnd: originalEnd,
            });
            await page.goto(INBOX_URL);

            // Use the simulate-event-move dev endpoint — same code path as production /sync/reassign,
            // but stubs Google Calendar so the assertion is fully deterministic. The editPatch
            // rides through the same applyItemEditPatch / moveItemAcrossCalendars chain.
            const newStart = dayjs(originalStart).add(2, 'hour').toISOString();
            const newEnd = dayjs(originalEnd).add(2, 'hour').toISOString();
            const result = await gtd.simulateCalendarMove(page, {
                entityType: 'item',
                entityId: itemId,
                fromUserId: active.userId,
                toUserId: secondary.userId,
                targetCalendar: { integrationId: seedB.integrationId, syncConfigId: cfgB },
                editPatch: { title: 'Renamed via reassign', notes: 'new notes', timeStart: newStart, timeEnd: newEnd },
            });
            expect(result.ok).toBe(true);

            // Server-side: the item is under secondary, with patched fields, target calendar refs,
            // and a new GCal event id (not the source's). The source row is gone.
            await expect.poll(async () => (await fetchServerItem(itemId))?.user, { timeout: 5_000 }).toBe(secondary.userId);
            const moved = await fetchServerItem(itemId);
            expect(moved?.title).toBe('Renamed via reassign');
            expect(moved?.notes).toBe('new notes');
            expect(moved?.timeStart).toBe(newStart);
            expect(moved?.timeEnd).toBe(newEnd);
            expect(moved?.calendarIntegrationId).toBe(seedB.integrationId);
            expect(moved?.calendarSyncConfigId).toBe(cfgB);
            expect(moved?.calendarEventId).toBeTruthy();
            expect(moved?.calendarEventId).not.toBe('gcal-evt-original');
        });
    });

    test('nextAction item with edits: workContextIds, peopleIds, energy, time, urgent, focus all ride along on the move', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `na-edit-a-${stamp}@example.com`;
        const emailB = `na-edit-b-${stamp}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const itemId = await seedItemOnServer(active.userId, 'Original NA', {
                status: 'nextAction',
                workContextIds: ['ctx-old'],
                peopleIds: ['p-old'],
                energy: 'low',
                time: 5,
            });
            await page.goto(INBOX_URL);

            const result = await gtd.reassign(page, {
                entityType: 'item',
                entityId: itemId,
                fromUserId: active.userId,
                toUserId: secondary.userId,
                editPatch: {
                    title: 'Renamed NA',
                    workContextIds: ['ctx-new-1', 'ctx-new-2'],
                    peopleIds: ['p-new'],
                    energy: 'high',
                    time: 30,
                    urgent: true,
                    focus: true,
                    expectedBy: '2026-12-31',
                },
            });
            expect(result.ok).toBe(true);

            await expect.poll(async () => (await fetchServerItem(itemId))?.user, { timeout: 5_000 }).toBe(secondary.userId);
            const moved = await fetchServerItem(itemId);
            expect(moved).toMatchObject({
                title: 'Renamed NA',
                workContextIds: ['ctx-new-1', 'ctx-new-2'],
                peopleIds: ['p-new'],
                energy: 'high',
                time: 30,
                urgent: true,
                focus: true,
                expectedBy: '2026-12-31',
            });
        });
    });

    test('reassign-only (no edits): item moves cleanly with all original fields preserved', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `reassign-only-a-${stamp}@example.com`;
        const emailB = `reassign-only-b-${stamp}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const itemId = await seedItemOnServer(active.userId, 'Untouched title', {
                status: 'nextAction',
                notes: 'untouched notes',
                workContextIds: ['ctx-keep'],
                energy: 'medium',
                time: 20,
            });
            await page.goto(INBOX_URL);

            const result = await gtd.reassign(page, {
                entityType: 'item',
                entityId: itemId,
                fromUserId: active.userId,
                toUserId: secondary.userId,
                // No editPatch — pure reassign.
            });
            expect(result.ok).toBe(true);

            await expect.poll(async () => (await fetchServerItem(itemId))?.user, { timeout: 5_000 }).toBe(secondary.userId);
            const moved = await fetchServerItem(itemId);
            expect(moved).toMatchObject({
                title: 'Untouched title',
                notes: 'untouched notes',
                workContextIds: ['ctx-keep'],
                energy: 'medium',
                time: 20,
            });
        });
    });

    test('editPatch clears: notes="" and energy="" drop those fields on the moved item', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `clear-a-${stamp}@example.com`;
        const emailB = `clear-b-${stamp}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const itemId = await seedItemOnServer(active.userId, 'Has stuff to clear', {
                status: 'nextAction',
                notes: 'will be cleared',
                energy: 'high',
                time: 30,
            });
            await page.goto(INBOX_URL);

            const result = await gtd.reassign(page, {
                entityType: 'item',
                entityId: itemId,
                fromUserId: active.userId,
                toUserId: secondary.userId,
                editPatch: { notes: '', energy: '', time: '' },
            });
            expect(result.ok).toBe(true);

            await expect.poll(async () => (await fetchServerItem(itemId))?.user, { timeout: 5_000 }).toBe(secondary.userId);
            const moved = await fetchServerItem(itemId);
            expect(moved?.notes).toBeUndefined();
            expect(moved?.energy).toBeUndefined();
            expect(moved?.time).toBeUndefined();
        });
    });
});
