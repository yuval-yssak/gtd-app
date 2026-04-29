import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

vi.mock('../lib/authClient', () => {
    // Stable references so individual tests can reach in via vi.mocked() with no extra plumbing.
    const setActive = vi.fn(async () => undefined);
    const listDeviceSessions = vi.fn(async () => ({
        data: [
            { user: { id: 'user-a' }, session: { token: 'token-a' } },
            { user: { id: 'user-b' }, session: { token: 'token-b' } },
        ],
    }));
    return {
        authClient: {
            multiSession: { setActive, listDeviceSessions },
        },
    };
});

import dayjs from 'dayjs';
import { fetchSyncOps, pushSyncOps } from '#api/syncClient';
import { syncAllLoggedInUsers } from '../db/multiUserSync';
import { authClient } from '../lib/authClient';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

let db: IDBPDatabase<MyDB>;

async function seedAccount(idbDb: IDBPDatabase<MyDB>, id: string, email: string): Promise<void> {
    await idbDb.put('accounts', {
        id,
        email,
        name: email,
        image: null,
        provider: 'google',
        addedAt: dayjs().valueOf(),
    });
}

beforeEach(async () => {
    db = await openTestDB();
    // Per-device sync state must already exist so flushSyncQueue + pullFromServer can run; without
    // it `pullOrBootstrap` would call bootstrapFromServer (we test that path separately).
    await db.put('deviceSyncState', { _id: 'local', deviceId: 'dev-test', lastSyncedTs: '2025-01-01T00:00:00.000Z', flushingTs: null });
    // Default to an empty pull payload so the orchestrator can resolve cleanly.
    vi.mocked(fetchSyncOps).mockResolvedValue({ ops: [], serverTs: '2025-01-02T00:00:00.000Z' });
});

afterEach(() => {
    vi.clearAllMocks();
    db.close();
});

describe('syncAllLoggedInUsers', () => {
    it('returns immediately when no accounts are logged in', async () => {
        await syncAllLoggedInUsers(db);
        expect(authClient.multiSession.setActive).not.toHaveBeenCalled();
        expect(vi.mocked(fetchSyncOps)).not.toHaveBeenCalled();
    });

    it('iterates each logged-in user, pivoting active session and pulling per pass', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const onUserSynced = vi.fn<(userId: string) => Promise<void>>(async () => undefined);
        await syncAllLoggedInUsers(db, { onUserSynced });

        // setActive runs at least once per user, then once more to restore the user-chosen
        // active session at the end (user-a was previously active).
        const setActiveCalls = vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);
        expect(setActiveCalls).toContain('token-a');
        expect(setActiveCalls).toContain('token-b');

        // Each user gets exactly one onUserSynced invocation, in the order accounts are listed.
        expect(onUserSynced).toHaveBeenCalledTimes(2);
        const orderedUserIds = onUserSynced.mock.calls.map((c) => c[0]);
        expect(orderedUserIds).toEqual(['user-a', 'user-b']);

        // Pull runs once per user (no bootstrap because deviceSyncState already exists).
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(2);
    });

    it('restores the previously-active session at the end', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        await syncAllLoggedInUsers(db);

        const setActiveCalls = vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);
        // The orchestrator pivots b@ last, so the FINAL setActive call must restore a@.
        expect(setActiveCalls.at(-1)).toBe('token-a');

        // The IDB activeAccount record must also reflect the restoration.
        const active = await db.get('activeAccount', 'active');
        expect(active?.userId).toBe('user-a');
    });

    it('still restores the previously-active session when a per-user pass throws', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        // Make the second pull throw so the loop bails out mid-iteration.
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs: '2025-01-02T00:00:00.000Z' }).mockRejectedValueOnce(new Error('GET /sync/pull 502'));

        await expect(syncAllLoggedInUsers(db)).rejects.toThrow('GET /sync/pull 502');

        const setActiveCalls = vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);
        // The finally block still pivots back to a@ before the error escapes.
        expect(setActiveCalls.at(-1)).toBe('token-a');
    });

    it('flushes only the per-user op slice in each pass', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        // Seed one op per user — the orchestrator must split them into separate flush calls.
        await db.add('syncOperations', {
            userId: 'user-a',
            opType: 'create',
            entityType: 'item',
            entityId: 'a-item',
            queuedAt: dayjs().toISOString(),
            snapshot: null,
        });
        await db.add('syncOperations', {
            userId: 'user-b',
            opType: 'create',
            entityType: 'item',
            entityId: 'b-item',
            queuedAt: dayjs().toISOString(),
            snapshot: null,
        });

        await syncAllLoggedInUsers(db);

        // Each pushSyncOps call should carry exactly one op — the one matching that pass's user.
        const calls = vi.mocked(pushSyncOps).mock.calls;
        const opsPerCall = calls.map(([, ops]) => ops.map((op) => op.entityId));
        expect(opsPerCall).toEqual([['a-item'], ['b-item']]);
    });

    it('skips the multi-session pivot when no entry exists but still runs the per-user pass', async () => {
        // user-c is in IDB but Better Auth's multi-session list doesn't carry an entry for it
        // (typical for a single-account dev login: only the primary session_token cookie is set).
        // The pass should still flush + pull under the existing active session — without this
        // behaviour, single-account users would never trigger an authenticated request and the
        // server-side deviceUsers join wouldn't get populated.
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-c', 'c@example.com'); // not in mocked sessions list
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        await syncAllLoggedInUsers(db);

        const tokens = vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);
        expect(tokens.filter((t) => t === 'token-a').length).toBeGreaterThanOrEqual(1);
        expect(tokens).not.toContain('token-c');

        // Both users got a pull — user-c via the no-pivot fallback under whichever session is
        // currently active (user-b at that point in the loop, but the assertion is on call count).
        expect(vi.mocked(fetchSyncOps).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
});
