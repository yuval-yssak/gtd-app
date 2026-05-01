import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredItem } from '../client/src/types/MyDB';
import { resetServerForEmails, withTwoAccountsOnOneDevice } from './helpers/context';
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
    // Each test scopes its own /dev/reset to the test's unique stamped emails. Pre-fix, an
    // unconditional global reset in beforeEach wiped session+user data for tests running
    // concurrently in other workers, surfacing as 401s and timeouts.
    test('per-user cursors are independent: each Better Auth session on the device gets its own syncCursors row', async ({ browser }) => {
        const ts = dayjs().valueOf();
        const emailA = `cursor-a-${ts}@example.com`;
        const emailB = `cursor-b-${ts}@example.com`;
        await resetServerForEmails([emailA, emailB]);
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

    test('per-user cursors are written as separate rows under each Better Auth userId', async ({ browser }) => {
        // The schema-level invariant: after the boot sync, each user has its own `syncCursors`
        // row keyed by userId. Pre-fix, the singleton `deviceSyncState['local']` row held one
        // shared cursor — there was no way to express per-user cursors at the IDB level.
        const ts = dayjs().valueOf();
        const emailA = `cursor-adv-a-${ts}@example.com`;
        const emailB = `cursor-adv-b-${ts}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await waitForBothSseChannels(page, active.userId, secondary.userId);
            // Wait for both per-user rows to land (boot pull writes them).
            await page.waitForFunction(
                ([a, b]) => {
                    const harness = (window as unknown as {
                        __gtd: { syncState(): Promise<{ syncCursors: Array<{ userId: string; lastSyncedTs: string }> }> };
                    }).__gtd;
                    return harness.syncState().then(({ syncCursors }) => {
                        const ids = new Set(syncCursors.map((c) => c.userId));
                        return ids.has(a as string) && ids.has(b as string) && syncCursors.every((c) => c.lastSyncedTs);
                    });
                },
                [active.userId, secondary.userId] as const,
                { timeout: 10_000 },
            );

            const state = await gtd.syncState(page);
            // Both rows exist, keyed by their respective userIds — the v4 schema-split contract.
            expect(state.syncCursors).toHaveLength(2);
            const userIds = new Set(state.syncCursors.map((c) => c.userId));
            expect(userIds).toEqual(new Set([active.userId, secondary.userId]));
            // The legacy singleton store would have had `_id: 'local'` and a single `lastSyncedTs`;
            // here each row carries its own. Both must be valid timestamps (not epoch).
            for (const cursor of state.syncCursors) {
                expect(cursor.lastSyncedTs).not.toBe(dayjs(0).toISOString());
            }
        });
    });
});
