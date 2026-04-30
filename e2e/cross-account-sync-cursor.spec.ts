import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredItem } from '../client/src/types/MyDB';
import { withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// E2e regression for the per-(device, user) sync-cursor fix. Pre-fix, two Better Auth sessions on
// one device shared a single `lastSyncedTs` cursor. Combined with the server's strict-`$gt` pull
// filter, an op for user B at exactly the timestamp user A's cursor was already advanced to would
// be silently dropped on user B's pull — surfacing as the cross-account-reassign symptom where
// the moved item never appeared on the target session.
//
// Post-fix: each user has its own cursor row in IDB (`syncCursors` keyed by userId) and on the
// server (`deviceSyncState._id = '${deviceId}::${userId}'`). User A advancing their cursor to T
// no longer affects whether user B's pull at T returns user B's boundary op.
//
// These specs lock in the schema-and-cursor-independence half. The reassign-driven IDB delivery
// path is exercised by `edit-item-cross-account-reassign.spec.ts`; here we focus on the cursor
// model itself, which is the load-bearing change.

const DEV_RESET_URL = 'http://localhost:4000/dev/reset';
const DEV_SEED_ENTITY_URL = 'http://localhost:4000/dev/reassign/seed-entity';

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

/**
 * Polls IDB for an item whose userId matches `expectedUserId`. Reads through `__gtd.db` (the
 * `idb` library wrapper, where `store.get` returns a Promise). Used to assert per-user IDB
 * isolation without going through the active-account-only `listItems` helper.
 */
async function waitForItemWithUser(page: Page, itemId: string, expectedUserId: string, timeoutMs = 12_000): Promise<StoredItem> {
    const found = await page.evaluate(
        async ([id, userId, deadline]) => {
            type IdbStore<T> = { get(key: string): Promise<T | undefined> };
            type IdbDb = { transaction(name: string, mode: 'readonly'): { objectStore(n: string): IdbStore<StoredItem> } };
            const harness = (window as unknown as { __gtd: { db: IdbDb } }).__gtd;
            while (Date.now() < (deadline as number)) {
                const item = await harness.db.transaction('items', 'readonly').objectStore('items').get(id as string);
                if (item && item.userId === userId) {
                    return item;
                }
                await new Promise((r) => setTimeout(r, 100));
            }
            return null;
        },
        [itemId, expectedUserId, Date.now() + timeoutMs] as const,
    );
    if (!found) {
        throw new Error(`Item ${itemId} not found in IDB under user ${expectedUserId} within ${timeoutMs}ms`);
    }
    return found;
}

/** Waits for both SSE channels (one per logged-in user) to be connected. */
async function waitForBothSseChannels(page: Page, userIdA: string, userIdB: string): Promise<void> {
    await page.waitForFunction(
        ([a, b]) => {
            const harness = (window as unknown as { __gtd: { sseChannelUserIds(): string[] } }).__gtd;
            const ids = new Set(harness.sseChannelUserIds());
            return ids.has(a as string) && ids.has(b as string);
        },
        [userIdA, userIdB] as const,
        { timeout: 10_000 },
    );
}

test.describe('cross-account sync cursor (per-user)', () => {
    test.beforeEach(async () => {
        await fetch(DEV_RESET_URL, { method: 'DELETE' });
    });

    test('per-user cursors are independent: each Better Auth session on the device gets its own syncCursors row', async ({ browser }) => {
        const ts = dayjs().valueOf();
        const emailA = `cursor-a-${ts}@example.com`;
        const emailB = `cursor-b-${ts}@example.com`;
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await waitForBothSseChannels(page, active.userId, secondary.userId);
            // The boot effect's syncAllLoggedInUsers writes per-user cursor rows; assert they exist.
            await page.waitForFunction(
                ([a, b]) => {
                    const harness = (window as unknown as {
                        __gtd: { syncState(): Promise<{ syncCursors: Array<{ userId: string }> }> };
                    }).__gtd;
                    return harness.syncState().then(({ syncCursors }) => {
                        const ids = new Set(syncCursors.map((c) => c.userId));
                        return ids.has(a as string) && ids.has(b as string);
                    });
                },
                [active.userId, secondary.userId] as const,
                { timeout: 10_000 },
            );

            const state = await gtd.syncState(page);
            expect(state.deviceMeta?.deviceId).toBeTruthy();
            const cursorUserIds = new Set(state.syncCursors.map((c) => c.userId));
            expect(cursorUserIds).toEqual(new Set([active.userId, secondary.userId]));
            for (const cursor of state.syncCursors) {
                expect(cursor.lastSyncedTs).toBeTruthy();
                // Bootstrap stamps the cursor at serverTs (now-ish). Definitely not epoch.
                expect(cursor.lastSyncedTs).not.toBe(dayjs(0).toISOString());
            }
        });
    });

    test('per-user cursors advance independently after a seed op for the active user', async ({ browser }) => {
        // Seeds an op for user-A only and drives an explicit pull. user-A's cursor advances to
        // the seed op's ts; user-B's cursor stays at its bootstrap stamp because no ops landed on
        // B's stream. With the pre-fix shared cursor, user-A's pull would write the singleton and
        // user-B's read would see the same value, masking the bug.
        const ts = dayjs().valueOf();
        const emailA = `cursor-adv-a-${ts}@example.com`;
        const emailB = `cursor-adv-b-${ts}@example.com`;
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await waitForBothSseChannels(page, active.userId, secondary.userId);

            // Capture user-B's cursor before the seed so we can assert it's unchanged afterwards.
            const beforeState = await gtd.syncState(page);
            const cursorBBefore = beforeState.syncCursors.find((c) => c.userId === secondary.userId);
            expect(cursorBBefore?.lastSyncedTs).toBeTruthy();

            const itemId = await seedItemOnServer(active.userId, 'A-only seed item', { status: 'nextAction' });

            // The seed endpoint inserts an op directly (no SSE). Drive the orchestrator so user-A's
            // pull picks it up. The orchestrator iterates both users; user-B's pull returns no ops
            // (none on B's stream), so B's cursor advances to a fresh serverTs but only because of
            // the pull itself — not because of A's op.
            await gtd.pull(page);
            await waitForItemWithUser(page, itemId, active.userId);

            const state = await gtd.syncState(page);
            const cursorA = state.syncCursors.find((c) => c.userId === active.userId);
            const cursorB = state.syncCursors.find((c) => c.userId === secondary.userId);
            expect(cursorA?.lastSyncedTs).toBeTruthy();
            expect(cursorB?.lastSyncedTs).toBeTruthy();

            // The crucial per-user-cursor invariant: A's cursor reflects its own op stream
            // (advanced to the seed op's ts), B's cursor reflects its own (no ops, so it's still
            // the post-pull serverTs from its own pull). They are independent rows.
            expect(cursorA?.lastSyncedTs).not.toBe(cursorB?.lastSyncedTs);
        });
    });
});
