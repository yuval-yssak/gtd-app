import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

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

/** Waits for both SSE channels (one per logged-in user) to be connected. */
async function waitForBothSseChannels(page: Page, userIdA: string, userIdB: string): Promise<void> {
    await page.waitForFunction(
        ([a, b]) => {
            // __gtd mounts from a lazy chunk after boot; a predicate that throws aborts the wait
            // instead of retrying, so report "not yet" until the harness exists.
            const harness = (window as unknown as { __gtd?: { sseChannelUserIds(): string[] } }).__gtd;
            const ids = new Set(harness?.sseChannelUserIds() ?? []);
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
        const ts = uniqueStamp();
        const emailA = `cursor-a-${ts}@example.com`;
        const emailB = `cursor-b-${ts}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await waitForBothSseChannels(page, active.userId, secondary.userId);
            // The boot sync writes one cursor row per user. Polled from the test side: a waitForFunction
            // predicate returning a promise counts as truthy at once and would not wait at all.
            await expect
                .poll(async () => new Set((await gtd.syncState(page)).syncCursors.filter((c) => c.lastSyncedTs).map((c) => c.userId)), { timeout: 15_000 })
                .toEqual(new Set([active.userId, secondary.userId]));

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
        const ts = uniqueStamp();
        const emailA = `cursor-adv-a-${ts}@example.com`;
        const emailB = `cursor-adv-b-${ts}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await waitForBothSseChannels(page, active.userId, secondary.userId);
            // The boot sync writes one cursor row per user. Polled from the test side: a waitForFunction
            // predicate returning a promise counts as truthy at once and would not wait at all.
            await expect
                .poll(async () => new Set((await gtd.syncState(page)).syncCursors.filter((c) => c.lastSyncedTs).map((c) => c.userId)), { timeout: 15_000 })
                .toEqual(new Set([active.userId, secondary.userId]));

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
