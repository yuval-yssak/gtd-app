import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// E2E coverage strategy: assertions read MongoDB through dev endpoints (server-side state) instead
// of waiting for the client's per-user pull to mirror moved-across-account ops back into IDB.
// The IDB sync path is exercised in unit tests + multiUserSync.test.ts.

// E2E coverage for Step 5 of the multi-account calendar plan: cross-account entity reassignment.
// Uses `withTwoAccountsOnOneDevice` so the device's multi-session cookie carries both userIds —
// `auth.api.listDeviceSessions` then sees both as device members, allowing /sync/reassign through.

const INBOX_URL = 'http://localhost:4173/inbox';
const DEV_SEED_CALENDAR_URL = 'http://localhost:4000/dev/calendar/seed-integration';

interface SeedCalendarRequest {
    userId: string;
    integrationId?: string;
    calendars: Array<{ configId?: string; calendarId: string; displayName?: string; isDefault?: boolean }>;
}

async function seedServerCalendarIntegration(req: SeedCalendarRequest): Promise<{ integrationId: string; configIds: string[] }> {
    const res = await fetch(DEV_SEED_CALENDAR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
    });
    if (!res.ok) {
        throw new Error(`POST /dev/calendar/seed-integration ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as { integrationId: string; configIds: string[] };
}

/**
 * Inserts a seed item directly into MongoDB via a small dev-only endpoint. We can't use the
 * IDB-only seed pattern from unified-view.spec.ts because /sync/reassign reads from MongoDB,
 * not IDB — the server-side entity must exist before reassign can move it.
 */
async function seedItemOnServer(userId: string, title: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const id = `seed-${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    const item = { _id: id, user: userId, status: 'inbox', title, createdTs: now, updatedTs: now, ...overrides };
    const res = await fetch('http://localhost:4000/dev/reassign/seed-entity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'items', doc: item }),
    });
    if (!res.ok) {
        throw new Error(`seed item failed: ${res.status} ${await res.text()}`);
    }
    return id;
}

async function seedPersonOnServer(userId: string, name: string): Promise<string> {
    const id = `seedp-${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    const res = await fetch('http://localhost:4000/dev/reassign/seed-entity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'people', doc: { _id: id, user: userId, name, createdTs: now, updatedTs: now } }),
    });
    if (!res.ok) {
        throw new Error(`seed person failed: ${res.status} ${await res.text()}`);
    }
    return id;
}

/** Pushes any queued IDB writes for `page` so the device's local rows propagate to the server. */
async function flushDevice(page: Page): Promise<void> {
    await gtd.flush(page);
}

/**
 * Reads the server-side row(s) for `entityId` directly from MongoDB via a dev endpoint. We assert
 * against server state rather than the client's IDB because the client's per-account pull would
 * need a session pivot to re-fetch items now owned by a non-active user — too much harness
 * machinery for a coverage check. The IDB-sync path is exercised in unit tests + multiUserSync.test.ts.
 */
async function fetchServerEntity(collection: 'items' | 'people', entityId: string): Promise<{ _id: string; user: string; peopleIds?: string[]; calendarEventId?: string; calendarIntegrationId?: string } | null> {
    const res = await fetch(`http://localhost:4000/dev/reassign/find-entity?collection=${collection}&entityId=${entityId}`);
    if (!res.ok) {
        return null;
    }
    const body = (await res.json()) as { doc: { _id: string; user: string; peopleIds?: string[]; calendarEventId?: string; calendarIntegrationId?: string } | null };
    return body.doc;
}

async function reloadInbox(page: Page): Promise<void> {
    await page.goto(INBOX_URL);
    await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
    // Wait for the device cursor to advance past the bootstrap epoch so subsequent assertions
    // don't race against an in-flight bootstrap. Mirrors the waitForSyncSettled pattern in login.ts.
    await page.evaluate(async () => {
        type Harness = { syncState(): Promise<{ lastSyncedTs: string } | undefined> };
        const harness = (window as unknown as { __gtd: Harness }).__gtd;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            const s = await harness.syncState();
            if (s !== undefined && s !== null && s.lastSyncedTs !== '1970-01-01T00:00:00.000Z') {
                return;
            }
            await new Promise((r) => setTimeout(r, 100));
        }
    });
}

test.describe('reassign — Step 5', () => {
    // Each test seeds fresh stamp-derived emails; reset the server between tests so leftover
    // operations from earlier passes don't influence the device's pull cursor.
    test.beforeEach(async () => {
        await fetch('http://localhost:4000/dev/reset', { method: 'DELETE' });
    });

    test('plain item: reassign a→b moves the item server-side', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `reassign-a-${stamp}@example.com`;
        const emailB = `reassign-b-${stamp}@example.com`;
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const itemId = await seedItemOnServer(active.userId, 'Plan trip');
            await reloadInbox(page);
            await flushDevice(page);

            const result = await gtd.reassign(page, { entityType: 'item', entityId: itemId, fromUserId: active.userId, toUserId: secondary.userId });
            expect(result.ok).toBe(true);

            // Server-side check: the item now belongs to the secondary user.
            await expect.poll(async () => (await fetchServerEntity('items', itemId))?.user, { timeout: 5_000 }).toBe(secondary.userId);
        });
    });

    test('person: reassign a→b moves the person; referencing items keep the cross-user reference', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `reassign-p-a-${stamp}@example.com`;
        const emailB = `reassign-p-b-${stamp}@example.com`;
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const personId = await seedPersonOnServer(active.userId, 'Sam');
            const itemId = await seedItemOnServer(active.userId, 'Lunch with Sam', { peopleIds: [personId] });
            await reloadInbox(page);
            await flushDevice(page);

            const result = await gtd.reassign(page, { entityType: 'person', entityId: personId, fromUserId: active.userId, toUserId: secondary.userId });
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.crossUserReferences?.peopleIds).toContain(itemId);
            }

            // Person moved to secondary; the referencing item stays under active and still references the moved person.
            await expect.poll(async () => (await fetchServerEntity('people', personId))?.user, { timeout: 5_000 }).toBe(secondary.userId);
            const referencingItem = await fetchServerEntity('items', itemId);
            expect(referencingItem?.user).toBe(active.userId);
            expect(referencingItem?.peopleIds).toContain(personId);
        });
    });

    test('calendar-linked item: simulate-event-move stubs Google and moves the GCal link to the target account', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `cal-reassign-a-${stamp}@example.com`;
        const emailB = `cal-reassign-b-${stamp}@example.com`;
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const seedA = await seedServerCalendarIntegration({
                userId: active.userId,
                calendars: [{ configId: 'cfg-a', calendarId: 'primary', displayName: 'A Primary', isDefault: true }],
            });
            const seedB = await seedServerCalendarIntegration({
                userId: secondary.userId,
                calendars: [{ configId: 'cfg-b', calendarId: 'primary', displayName: 'B Primary', isDefault: true }],
            });

            const itemId = await seedItemOnServer(active.userId, 'Cal event A', {
                status: 'calendar',
                calendarEventId: 'gcal-evt-original',
                calendarIntegrationId: seedA.integrationId,
                calendarSyncConfigId: 'cfg-a',
                timeStart: dayjs().add(1, 'day').toISOString(),
                timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
            });
            await reloadInbox(page);
            await flushDevice(page);

            const result = await gtd.simulateCalendarMove(page, {
                entityType: 'item',
                entityId: itemId,
                fromUserId: active.userId,
                toUserId: secondary.userId,
                targetCalendar: { integrationId: seedB.integrationId, syncConfigId: 'cfg-b' },
            });
            expect(result.ok).toBe(true);

            // Server-side check: item moved to secondary, with the new integration id and a fresh GCal event id.
            await expect.poll(async () => (await fetchServerEntity('items', itemId))?.user, { timeout: 5_000 }).toBe(secondary.userId);
            const moved = await fetchServerEntity('items', itemId);
            expect(moved?.calendarIntegrationId).toBe(seedB.integrationId);
            expect(moved?.calendarEventId).toBeTruthy();
            expect(moved?.calendarEventId).not.toBe('gcal-evt-original');
        });
    });

    test('routine-generated item reassign attempt: server returns 400, item stays put', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `routine-gen-a-${stamp}@example.com`;
        const emailB = `routine-gen-b-${stamp}@example.com`;
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const itemId = await seedItemOnServer(active.userId, 'Generated by routine', { routineId: 'routine-xyz' });
            await reloadInbox(page);
            await flushDevice(page);

            const result = await gtd.reassign(page, { entityType: 'item', entityId: itemId, fromUserId: active.userId, toUserId: secondary.userId });
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.status).toBe(400);
            }

            // Server-side check: 400 means no DB writes happened — the item still belongs to active.
            const stillThere = await fetchServerEntity('items', itemId);
            expect(stillThere?.user).toBe(active.userId);
        });
    });
});
