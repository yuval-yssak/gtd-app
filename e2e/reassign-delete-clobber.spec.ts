import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Regression for the "item disappears after cross-account move" bug. The reassign endpoint emits
// two ops with the same entityId (delete under source, create under target). The orchestrator
// pulls per user; if it iterates target before source, the source's later delete used to call
// deleteItemById(_id) and remove the post-move row by `_id`. Net result: the entity vanished
// from IndexedDB and the calendar view, even though the server had it correctly under target.
//
// The fix in applyEntityOp scopes deletes to the pull's userId — a delete that doesn't match the
// local row's userId is dropped. We assert end-to-end that the row survives in IDB regardless of
// which orchestrator iteration order Playwright happened to land on.

const DEV_SEED_CALENDAR_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const INBOX_URL = 'http://localhost:4173/inbox';

test.describe('cross-account reassign — item survives delete-op clobber', () => {
    // Each test scopes its /dev/reset to its unique stamped emails so concurrent specs in
    // other workers keep their session/user data.
    test('plain (non-calendar) item: row stays in IDB under target after reassign', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `clobber-na-a-${stamp}@example.com`;
        const emailB = `clobber-na-b-${stamp}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            // Seed the item server-side under the source account. The reassign call below pivots
            // through both sessions, which flushes + pulls each — that's how the seeded op (and the
            // subsequent reassign delete + create ops) reach IDB.
            const itemId = await seedItemOnServer(active.userId, 'Reassign survival test', { status: 'nextAction' });
            await page.goto(INBOX_URL);

            const result = await gtd.reassign(page, {
                entityType: 'item',
                entityId: itemId,
                fromUserId: active.userId,
                toUserId: secondary.userId,
            });
            expect(result.ok).toBe(true);

            // After the reassign settles, the row must be present in IDB across logged-in users.
            // Pre-fix this would intermittently fail (depending on orchestrator iteration order)
            // because the source's delete op blew away the post-move row by `_id`.
            await expect
                .poll(
                    async () => {
                        const found = await listIdbItem(page, itemId);
                        return found?.userId ?? 'NOT_PRESENT';
                    },
                    { timeout: 10_000 },
                )
                .toBe(secondary.userId);
        });
    });

    test('calendar item: row stays in IDB after a cross-account move with new GCal event', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `clobber-cal-a-${stamp}@example.com`;
        const emailB = `clobber-cal-b-${stamp}@example.com`;
        // configIds carry the stamp so parallel workers don't collide on _id.
        const cfgA = `cfg-clob-a-${stamp}`;
        const cfgB = `cfg-clob-b-${stamp}`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            // Both accounts need a calendar integration so the move can re-link to the target.
            const seedA = await seedCalendarForUser(active.userId, [
                { configId: cfgA, calendarId: 'primary', displayName: 'A Primary', isDefault: true },
            ]);
            const seedB = await seedCalendarForUser(secondary.userId, [
                { configId: cfgB, calendarId: 'primary', displayName: 'B Primary', isDefault: true },
            ]);

            const start = dayjs().add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
            const end = dayjs().add(1, 'day').hour(11).minute(0).second(0).millisecond(0).toISOString();
            // Seed a calendar-linked item server-side under source — same pattern as
            // edit-item-cross-account-reassign.spec.ts. The dev seed inserts the doc + records
            // a create op so the next pull lands it in IDB.
            const itemId = await seedItemOnServer(active.userId, 'Calendar survival test', {
                status: 'calendar',
                timeStart: start,
                timeEnd: end,
                calendarIntegrationId: seedA.integrationId,
                calendarSyncConfigId: cfgA,
                calendarEventId: 'gcal-evt-survive-original',
            });
            await page.goto(INBOX_URL);

            // simulateCalendarMove drives the same atomic move as production but stubs Google so
            // the assertion is deterministic. The full per-user pull is triggered as part of the
            // helper just like the real reassign path.
            const result = await gtd.simulateCalendarMove(page, {
                entityType: 'item',
                entityId: itemId,
                fromUserId: active.userId,
                toUserId: secondary.userId,
                targetCalendar: { integrationId: seedB.integrationId, syncConfigId: cfgB },
            });
            expect(result.ok).toBe(true);

            // Now drive the per-user pulls so the source's delete + target's create reach IDB.
            // Without this nudge the e2e harness has no SSE/online event to trigger syncAndRefresh.
            await page.evaluate(() => (window as unknown as { __gtd: { pull(): Promise<unknown> } }).__gtd.pull());

            // Row must be present in IDB after the move, under target, with target's calendar config.
            await expect
                .poll(
                    async () => {
                        const found = await listIdbItem(page, itemId);
                        return found ? { user: found.userId, cfg: found.calendarSyncConfigId } : 'NOT_PRESENT';
                    },
                    { timeout: 10_000 },
                )
                .toMatchObject({ user: secondary.userId, cfg: cfgB });
        });
    });
});

/** Reads a single item from IDB across every logged-in user's index — needed because gtd.listItems only sees the active user. */
async function listIdbItem(page: import('@playwright/test').Page, itemId: string) {
    return page.evaluate(async (id) => {
        const dbReq = indexedDB.open('gtd-app');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            dbReq.onsuccess = () => resolve(dbReq.result);
            dbReq.onerror = () => reject(dbReq.error);
        });
        return new Promise<{ userId: string; calendarSyncConfigId?: string } | undefined>((resolve) => {
            const req = db.transaction('items').objectStore('items').get(id);
            req.onsuccess = () => resolve(req.result as { userId: string; calendarSyncConfigId?: string } | undefined);
        });
    }, itemId);
}

// ── helpers ──────────────────────────────────────────────────────────────────

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
    const res = await fetch('http://localhost:4000/dev/reassign/seed-entity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'items', doc }),
    });
    if (!res.ok) {
        throw new Error(`seed item ${res.status}: ${await res.text()}`);
    }
    return id;
}
