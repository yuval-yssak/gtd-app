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
            { user: { id: 'user-c' }, session: { token: 'token-c' } },
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
import { syncAllLoggedInUsers, syncSingleUser } from '../db/multiUserSync';
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
    // Device meta + per-user cursors must exist so flushSyncQueue + pullFromServer can run; without
    // a cursor row `pullOrBootstrap` would call bootstrapFromServer (we test that path separately).
    await db.put('deviceMeta', { _id: 'local', deviceId: 'dev-test', flushingTs: null });
    await db.put('syncCursors', { userId: 'user-a', lastSyncedTs: '2025-01-01T00:00:00.000Z' });
    await db.put('syncCursors', { userId: 'user-b', lastSyncedTs: '2025-01-01T00:00:00.000Z' });
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

        // Pull runs once per user (no bootstrap because each user already has a syncCursors row).
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(2);
    });

    it('updates each user’s cursor independently — one user’s pull does not move another user’s cursor', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        // First pull (user-a) returns serverTs=T_A; second (user-b) returns T_B.
        const tA = '2025-04-30T19:38:54.754Z';
        const tB = '2025-05-01T08:00:00.000Z';
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs: tA }).mockResolvedValueOnce({ ops: [], serverTs: tB });

        await syncAllLoggedInUsers(db);

        const cursorA = await db.get('syncCursors', 'user-a');
        const cursorB = await db.get('syncCursors', 'user-b');
        expect(cursorA?.lastSyncedTs).toBe(tA);
        expect(cursorB?.lastSyncedTs).toBe(tB);
    });

    it('bootstraps a user with no syncCursors row instead of pulling', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-c', 'c@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        // Remove user-c's seed cursor so pullOrBootstrap chooses bootstrap for that pass.
        await db.delete('syncCursors', 'user-c');

        // Mock bootstrap path — fetchBootstrap returns empty arrays + serverTs which becomes user-c's cursor.
        const bootstrapMod = await import('#api/syncClient');
        vi.mocked(bootstrapMod.fetchBootstrap).mockResolvedValueOnce({
            items: [],
            routines: [],
            people: [],
            workContexts: [],
            serverTs: '2025-06-01T00:00:00.000Z',
        });

        await syncAllLoggedInUsers(db);

        // user-c got bootstrapped, not pulled, so a syncCursors row exists at the bootstrap serverTs.
        const cursorC = await db.get('syncCursors', 'user-c');
        expect(cursorC?.lastSyncedTs).toBe('2025-06-01T00:00:00.000Z');
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

    it('single-account device with no multi-session list still runs its single pass without pivoting', async () => {
        // Single-account dev login: only the primary session_token cookie is set; multi-session
        // list is empty. The orchestrator should still flush + pull for that single user under
        // the existing cookie — without this, single-account users would never trigger any sync.
        vi.mocked(authClient.multiSession.listDeviceSessions).mockResolvedValueOnce({ data: [] });
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        await syncAllLoggedInUsers(db);

        // setActive is never called because there's no session entry to pivot to. But the IDB
        // active account is re-stamped to user-a (the single-user fallback) so downstream guards
        // know which user the cookie authenticates as.
        const setActiveCalls = vi.mocked(authClient.multiSession.setActive).mock.calls;
        expect(setActiveCalls).toHaveLength(0);
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(1);
    });

    it('syncSingleUser: pivots the cookie, pulls for that user, restores prior active session', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        await syncSingleUser(db, 'user-b');

        const setActiveCalls = vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);
        // First pivot: to user-b for the targeted sync. Last pivot: back to user-a (restore).
        expect(setActiveCalls[0]).toBe('token-b');
        expect(setActiveCalls.at(-1)).toBe('token-a');

        // Exactly one pull — for user-b only, not the whole device.
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(1);
        const active = await db.get('activeAccount', 'active');
        expect(active?.userId).toBe('user-a');
    });

    it('syncSingleUser: throws when no multi-session entry exists for the user', async () => {
        // user-orphan is in IDB but has no Better Auth session entry. syncSingleUser must refuse
        // rather than fall through to a single-user fallback that would corrupt user-orphan's
        // cursor with another user's data.
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-orphan', 'orphan@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        await expect(syncSingleUser(db, 'user-orphan')).rejects.toThrow(/no Better Auth multi-session entry/);
        // No pull should have fired.
        expect(vi.mocked(fetchSyncOps)).not.toHaveBeenCalled();
    });

    it('multi-user device skips a user with no multi-session entry to avoid cross-user corruption', async () => {
        // user-orphan is in IDB but missing from the multi-session list. Pulling for them under
        // whichever cookie is currently set would attribute another user's data to user-orphan's
        // cursor. The orchestrator must skip them with a warning instead of corrupting state.
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-orphan', 'orphan@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await syncAllLoggedInUsers(db);

        // user-a got its pull; user-orphan was skipped — only one pull in total.
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('user-orphan'))).toBe(true);
        warnSpy.mockRestore();
    });
});
