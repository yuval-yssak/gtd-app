import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));
vi.mock('#api/accountApi', async () => await import('../api/accountApi.mock.ts'));

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
    // Cookie-session probe used by reconcileActiveSessionCookie; defaults to user-a active.
    const getSession = vi.fn(async () => ({ data: { user: { id: 'user-a' } } }));
    return {
        authClient: {
            getSession,
            multiSession: { setActive, listDeviceSessions },
        },
    };
});

import dayjs from 'dayjs';
import { fetchUserStatus } from '#api/accountApi';
import { fetchSyncOps, pushSyncOps, SyncAuthError } from '#api/syncClient';
import { ACCOUNT_NEEDS_REAUTH_EVENT, flagAccountNeedsReauth, getReauthFlaggedUserIds, resetAccountReauthStore } from '../contexts/accountReauthEvents';
import {
    handleDeadSessionGated,
    reconcileActiveSessionCookie,
    resetUserStatusProbeThrottleForTests,
    syncAllLoggedInUsers,
    syncSingleUser,
    withAccountSession,
} from '../db/multiUserSync';
import { setSessionGateTimeoutMs } from '../db/syncHelpers';
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
    await db.put('syncCursors', { userId: 'user-a', lastSyncedTs: '2025-01-01T00:00:00.000Z', lastSyncedId: '' });
    await db.put('syncCursors', { userId: 'user-b', lastSyncedTs: '2025-01-01T00:00:00.000Z', lastSyncedId: '' });
    // Default to an empty pull payload so the orchestrator can resolve cleanly.
    vi.mocked(fetchSyncOps).mockResolvedValue({ ops: [], serverTs: '2025-01-02T00:00:00.000Z', serverId: '' });
    // Every account is alive unless a test says otherwise — the tombstone check is a pass-through.
    vi.mocked(fetchUserStatus).mockResolvedValue({ status: 'active' });
    // The probe throttle is module-level; each test starts cold so its probe expectations hold.
    resetUserStatusProbeThrottleForTests();
});

afterEach(() => {
    vi.clearAllMocks();
    resetAccountReauthStore(); // reauth-flag tests must not leak flags into later cases
    db.close();
});

describe('syncAllLoggedInUsers — tombstone check', () => {
    it('evaporates a deleted account via onUserDeleted and syncs only the survivors', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        vi.mocked(fetchUserStatus).mockImplementation(async (userId) =>
            userId === 'user-b' ? { status: 'deleted', deletedAt: '2026-10-04T00:00:00.000Z' } : { status: 'active' },
        );
        const onUserDeleted = noNavigation();
        const onUserSynced = vi.fn<(userId: string) => Promise<void>>(async () => undefined);

        await syncAllLoggedInUsers(db, { onUserDeleted, onUserSynced });

        expect(onUserDeleted).toHaveBeenCalledExactlyOnceWith('user-b');
        expect(onUserSynced.mock.calls.map((c) => c[0])).toEqual(['user-a']);
        // Every account is probed exactly once, without a session pivot.
        expect(
            vi
                .mocked(fetchUserStatus)
                .mock.calls.map((c) => c[0])
                .sort(),
        ).toEqual(['user-a', 'user-b']);
        const setActiveCalls = vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);
        expect(setActiveCalls).not.toContain('token-b');
    });

    it('treats unknown like active — an unreachable or rate-limited endpoint never evaporates anyone', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        vi.mocked(fetchUserStatus).mockResolvedValue({ status: 'unknown' });
        const onUserDeleted = noNavigation();
        const onUserSynced = vi.fn<(userId: string) => Promise<void>>(async () => undefined);

        await syncAllLoggedInUsers(db, { onUserDeleted, onUserSynced });

        expect(onUserDeleted).not.toHaveBeenCalled();
        expect(onUserSynced).toHaveBeenCalledExactlyOnceWith('user-a');
    });

    it('returns without pivoting or pulling when every account was deleted', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        vi.mocked(fetchUserStatus).mockResolvedValue({ status: 'deleted' });
        const onUserDeleted = noNavigation();

        await syncAllLoggedInUsers(db, { onUserDeleted });

        expect(onUserDeleted).toHaveBeenCalledExactlyOnceWith('user-a');
        expect(authClient.multiSession.setActive).not.toHaveBeenCalled();
        expect(vi.mocked(fetchSyncOps)).not.toHaveBeenCalled();
    });
});

// ── Tombstone-check helpers ────────────────────────────────────────────────────

type OnUserDeletedMock = ReturnType<typeof vi.fn<(userId: string) => Promise<{ navigated: boolean }>>>;
/** An evaporation hook that reports "no reload scheduled" (a non-active account went away). */
const noNavigation = (): OnUserDeletedMock => vi.fn(async () => ({ navigated: false }));
/** An evaporation hook that reports "reload scheduled" (the active account went away). */
const withNavigation = (): OnUserDeletedMock => vi.fn(async () => ({ navigated: true }));

/**
 * `window` is undefined under the `node` test env; stub it for the duration of `fn` so
 * dispatchAccountNeedsReauth / dispatchAccountEvaporated fire, and hand back the dispatch spy.
 * `location.href` is writable so a real evaporation's navigation lands somewhere observable.
 */
async function runWithStubbedWindow<T>(fn: () => Promise<T>): Promise<{ outcome: T; dispatchSpy: ReturnType<typeof vi.fn>; location: { href: string } }> {
    const dispatchSpy = vi.fn();
    const location = { href: '/inbox' };
    vi.stubGlobal('window', { dispatchEvent: dispatchSpy, location } as unknown as Window);
    try {
        const outcome = await fn();
        return { outcome, dispatchSpy, location };
    } finally {
        vi.unstubAllGlobals();
    }
}

/** userIds of every reauth-needed event the stubbed window received. */
const reauthEventsFrom = (dispatchSpy: ReturnType<typeof vi.fn>) =>
    dispatchSpy.mock.calls
        .map(([event]) => event as CustomEvent<{ userId: string }>)
        .filter((event) => event.type === ACCOUNT_NEEDS_REAUTH_EVENT)
        .map((event) => event.detail.userId);

const setActiveTokens = () => vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);

describe('syncAllLoggedInUsers — tombstone throttle and dead-session handling', () => {
    it('returns right after an active-account evaporation scheduled a reload — survivors are not flushed or pulled', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        vi.mocked(fetchUserStatus).mockImplementation(async (userId) => ({ status: userId === 'user-a' ? 'deleted' : 'active' }));
        const onUserDeleted = withNavigation();
        const onUserSynced = vi.fn<(userId: string) => Promise<void>>(async () => undefined);

        await syncAllLoggedInUsers(db, { onUserDeleted, onUserSynced });

        expect(onUserDeleted).toHaveBeenCalledExactlyOnceWith('user-a');
        expect(onUserSynced).not.toHaveBeenCalled();
        expect(vi.mocked(fetchSyncOps)).not.toHaveBeenCalled();
        expect(authClient.multiSession.setActive).not.toHaveBeenCalled();
    });

    it('probes each account at most once per 10 minutes, then again once the window has passed', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        await syncAllLoggedInUsers(db, { onUserDeleted: noNavigation() });
        await syncAllLoggedInUsers(db, { onUserDeleted: noNavigation() });
        // Boot + online + resume within minutes: one billed probe, not three.
        expect(fetchUserStatus).toHaveBeenCalledTimes(1);

        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(dayjs().add(11, 'minute').toDate());
            await syncAllLoggedInUsers(db, { onUserDeleted: noNavigation() });
        } finally {
            vi.useRealTimers();
        }
        expect(fetchUserStatus).toHaveBeenCalledTimes(2);
    });

    it('an unknown answer does not start the throttle window — the next pass probes again', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        // Offline boot: the probe fails open…
        vi.mocked(fetchUserStatus).mockResolvedValueOnce({ status: 'unknown' });
        await syncAllLoggedInUsers(db, { onUserDeleted: noNavigation() });
        // …and the `online` pass right after must get a real answer, not a 10-minute silence.
        await syncAllLoggedInUsers(db, { onUserDeleted: noNavigation() });

        expect(fetchUserStatus).toHaveBeenCalledTimes(2);
    });

    it('a 401 mid-pass forces a probe despite the throttle; tombstoned → evaporate, no reauth flag', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        // Warm the throttle so the pre-loop probe is skipped on the next pass.
        await syncAllLoggedInUsers(db, { onUserDeleted: noNavigation() });
        expect(fetchUserStatus).toHaveBeenCalledTimes(1);

        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new SyncAuthError('401'));
        vi.mocked(fetchUserStatus).mockResolvedValue({ status: 'deleted' });
        const onUserDeleted = withNavigation();
        const { dispatchSpy } = await runWithStubbedWindow(() => syncAllLoggedInUsers(db, { onUserDeleted }));

        expect(fetchUserStatus).toHaveBeenCalledTimes(2);
        expect(onUserDeleted).toHaveBeenCalledExactlyOnceWith('user-a');
        expect(reauthEventsFrom(dispatchSpy)).toEqual([]);
    });

    it('a 401 mid-pass whose forced probe says active flags the user for reauth as before', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        await syncAllLoggedInUsers(db, { onUserDeleted: noNavigation() });

        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new SyncAuthError('401'));
        const onUserDeleted = noNavigation();
        const { dispatchSpy } = await runWithStubbedWindow(() => syncAllLoggedInUsers(db, { onUserDeleted }));

        expect(fetchUserStatus).toHaveBeenCalledTimes(2);
        expect(onUserDeleted).not.toHaveBeenCalled();
        expect(reauthEventsFrom(dispatchSpy)).toEqual(['user-a']);
    });

    it('a 401 that turns out to be a deletion is evaporated only AFTER every survivor synced and the active session was restored', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new SyncAuthError('401 for user-a'));
        vi.mocked(fetchUserStatus).mockImplementation(async (userId) => ({ status: userId === 'user-a' ? 'deleted' : 'active' }));
        // Pre-loop probes see user-a active (throttle-free first call) so the loop runs; the 401 then
        // forces the probe that reports the deletion.
        vi.mocked(fetchUserStatus).mockResolvedValueOnce({ status: 'active' }).mockResolvedValueOnce({ status: 'active' });
        const onUserDeleted = withNavigation();
        const onUserSynced = vi.fn<(userId: string) => Promise<void>>(async () => undefined);
        const callOrder: string[] = [];
        onUserDeleted.mockImplementation(async (userId) => {
            callOrder.push(`evaporate:${userId}`);
            return { navigated: true };
        });
        onUserSynced.mockImplementation(async (userId) => {
            callOrder.push(`synced:${userId}`);
        });

        await runWithStubbedWindow(() => syncAllLoggedInUsers(db, { onUserDeleted, onUserSynced }));

        // user-b still gets its pass; the evaporation of user-a comes last, after the restore pivot.
        expect(callOrder).toEqual(['synced:user-b', 'evaporate:user-a']);
        expect(setActiveTokens()).toEqual(['token-a', 'token-b', 'token-a']);
    });

    it('with the default evaporation, a deleted ACTIVE account pivots IDB to the survivor and reloads', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        vi.mocked(fetchUserStatus)
            .mockResolvedValueOnce({ status: 'active' })
            .mockResolvedValueOnce({ status: 'active' })
            .mockResolvedValue({ status: 'deleted' });
        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new SyncAuthError('401 for user-a'));

        const { location } = await runWithStubbedWindow(() => syncAllLoggedInUsers(db));

        expect(location.href).toBe('/');
        expect((await db.get('activeAccount', 'active'))?.userId).toBe('user-b');
        expect(await db.get('accounts', 'user-a')).toBeUndefined();
        // Pass pivots (a, b), the restore to a, THEN the evaporation's pivot to the survivor b.
        expect(setActiveTokens()).toEqual(['token-a', 'token-b', 'token-a', 'token-b']);
    });

    it('with the default evaporation, a deleted NON-active account is wiped without a reload and the active account is untouched', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        // Pre-loop probes: both alive. user-b's pull 401s; its forced probe says deleted.
        vi.mocked(fetchUserStatus)
            .mockResolvedValueOnce({ status: 'active' })
            .mockResolvedValueOnce({ status: 'active' })
            .mockResolvedValue({ status: 'deleted' });
        vi.mocked(fetchSyncOps)
            .mockResolvedValueOnce({ ops: [], serverTs: '2025-01-02T00:00:00.000Z', serverId: '' })
            .mockRejectedValueOnce(new SyncAuthError('401 for user-b'));

        const { location } = await runWithStubbedWindow(() => syncAllLoggedInUsers(db));

        // Pre-fix this reloaded: inside user-b's pass IDB's activeAccount pointed at user-b, so the
        // evaporation believed the ACTIVE account had died.
        expect(location.href).toBe('/inbox');
        expect((await db.get('activeAccount', 'active'))?.userId).toBe('user-a');
        expect(await db.get('accounts', 'user-b')).toBeUndefined();
        expect(await db.get('accounts', 'user-a')).toBeDefined();
    });

    it('syncSingleUser: a 401 that turns out to be a deletion evaporates through the default (ungated) path without deadlocking or navigating', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new SyncAuthError('401 for user-b'));
        vi.mocked(fetchUserStatus).mockResolvedValue({ status: 'deleted' });

        const { dispatchSpy, location } = await runWithStubbedWindow(() => syncSingleUser(db, 'user-b'));

        // user-b (non-active) is gone locally; user-a stays active and its session was restored.
        expect(location.href).toBe('/inbox');
        expect(await db.get('accounts', 'user-b')).toBeUndefined();
        expect((await db.get('activeAccount', 'active'))?.userId).toBe('user-a');
        expect(setActiveTokens()).toEqual(['token-b', 'token-a']);
        expect(reauthEventsFrom(dispatchSpy)).toEqual([]);
    });

    it("syncSingleUser on a 3-account device: a deleted non-active account never moves the user's active account (reviewer repro)", async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-c', 'c@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-c' }, 'active');
        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new SyncAuthError('401 for user-b'));
        vi.mocked(fetchUserStatus).mockResolvedValue({ status: 'deleted' });

        const { location } = await runWithStubbedWindow(() => syncSingleUser(db, 'user-b'));

        // Pre-fix: wasActive read true mid-pass, the device pivoted to remaining[0] (user-a — an
        // account the user never picked) and reloaded.
        expect(location.href).toBe('/inbox');
        expect((await db.get('activeAccount', 'active'))?.userId).toBe('user-c');
        expect(await db.get('accounts', 'user-b')).toBeUndefined();
        expect(setActiveTokens()).toEqual(['token-b', 'token-c']);
    });

    it('resolves { navigated: true } on the pre-loop evaporation path, so the caller stops before touching location again', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        vi.mocked(fetchUserStatus).mockResolvedValue({ status: 'deleted' });

        expect(await syncAllLoggedInUsers(db, { onUserDeleted: withNavigation() })).toEqual({ navigated: true });
    });

    it('resolves { navigated: true } on the post-restore evaporation path, and { navigated: false } on a healthy pass', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        expect(await syncAllLoggedInUsers(db, { onUserDeleted: withNavigation() })).toEqual({ navigated: false });

        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new SyncAuthError('401 for user-a'));
        vi.mocked(fetchUserStatus).mockResolvedValue({ status: 'deleted' });
        const onUserDeleted = withNavigation();

        const result = await runWithStubbedWindow(() => syncAllLoggedInUsers(db, { onUserDeleted }));

        expect(result.outcome).toEqual({ navigated: true });
        expect(onUserDeleted).toHaveBeenCalledExactlyOnceWith('user-a');
    });

    it('a mid-pass deletion lost to a later non-auth failure is re-found by the next pass (deleted never starts the throttle window)', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        // Pre-loop probes alive; user-a's pull 401s and its forced probe says deleted; user-b's pull then 500s.
        vi.mocked(fetchUserStatus).mockImplementation(async (userId) => ({ status: userId === 'user-a' ? 'deleted' : 'active' }));
        vi.mocked(fetchUserStatus).mockResolvedValueOnce({ status: 'active' }).mockResolvedValueOnce({ status: 'active' });
        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new SyncAuthError('401 for user-a')).mockRejectedValueOnce(new Error('500'));
        const onUserDeleted = noNavigation();

        await expect(runWithStubbedWindow(() => syncAllLoggedInUsers(db, { onUserDeleted }))).rejects.toThrow('500');
        expect(onUserDeleted).not.toHaveBeenCalled();

        // Healthy network again: the pre-loop probe re-asks about user-a and evaporates it before the loop.
        await runWithStubbedWindow(() => syncAllLoggedInUsers(db, { onUserDeleted }));
        expect(onUserDeleted).toHaveBeenCalledExactlyOnceWith('user-a');
    });

    it('handleDeadSessionGated: evaporates a tombstoned account directly (no pivot happened) and skips re-probing an already-flagged one', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        // First 401 for user-b: forced probe says active → flagged for reauth.
        const { dispatchSpy } = await runWithStubbedWindow(() => handleDeadSessionGated(db, 'user-b'));
        expect(reauthEventsFrom(dispatchSpy)).toEqual(['user-b']);
        expect(fetchUserStatus).toHaveBeenCalledTimes(1);

        // Next queued op's 401 while still flagged: throttled, no second billed probe.
        flagAccountNeedsReauth('user-b');
        await runWithStubbedWindow(() => handleDeadSessionGated(db, 'user-b'));
        expect(fetchUserStatus).toHaveBeenCalledTimes(1);

        // Unflagged + tombstoned: evaporated right here, active account untouched.
        resetAccountReauthStore();
        vi.mocked(fetchUserStatus).mockResolvedValue({ status: 'deleted' });
        const { location } = await runWithStubbedWindow(() => handleDeadSessionGated(db, 'user-b'));
        expect(location.href).toBe('/inbox');
        expect(await db.get('accounts', 'user-b')).toBeUndefined();
        expect((await db.get('activeAccount', 'active'))?.userId).toBe('user-a');
    });

    it('a secondary account missing from the device session list forces a probe: deleted → evaporate instead of a reauth flag', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        // user-b has no Better Auth session on this device any more — exactly what deletion looks like.
        // Once-mocks (not a persistent override) so the default three-session list returns for later
        // tests: the loop reads the list before the loop and refreshes it once for the missing user.
        const onlyUserA = { data: [{ user: { id: 'user-a' }, session: { token: 'token-a' } }] } as Awaited<
            ReturnType<typeof authClient.multiSession.listDeviceSessions>
        >;
        vi.mocked(authClient.multiSession.listDeviceSessions).mockResolvedValueOnce(onlyUserA).mockResolvedValueOnce(onlyUserA);
        vi.mocked(fetchUserStatus).mockImplementation(async (userId) => ({ status: userId === 'user-b' ? 'deleted' : 'active' }));
        // The pre-loop probes see user-b alive; the in-loop "no session" branch then forces the probe.
        vi.mocked(fetchUserStatus).mockResolvedValueOnce({ status: 'active' }).mockResolvedValueOnce({ status: 'active' });
        const onUserDeleted = noNavigation();

        const { dispatchSpy } = await runWithStubbedWindow(() => syncAllLoggedInUsers(db, { onUserDeleted }));

        expect(fetchUserStatus).toHaveBeenCalledTimes(3);
        expect(onUserDeleted).toHaveBeenCalledExactlyOnceWith('user-b');
        expect(reauthEventsFrom(dispatchSpy)).toEqual([]);
    });

    it('a secondary account missing from the device session list whose probe says active still gets the reauth flag', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        // Once-mocks (not a persistent override) so the default three-session list returns for later
        // tests: the loop reads the list before the loop and refreshes it once for the missing user.
        const onlyUserA = { data: [{ user: { id: 'user-a' }, session: { token: 'token-a' } }] } as Awaited<
            ReturnType<typeof authClient.multiSession.listDeviceSessions>
        >;
        vi.mocked(authClient.multiSession.listDeviceSessions).mockResolvedValueOnce(onlyUserA).mockResolvedValueOnce(onlyUserA);
        const onUserDeleted = noNavigation();

        const { dispatchSpy } = await runWithStubbedWindow(() => syncAllLoggedInUsers(db, { onUserDeleted }));

        expect(onUserDeleted).not.toHaveBeenCalled();
        expect(reauthEventsFrom(dispatchSpy)).toEqual(['user-b']);
    });
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
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs: tA, serverId: '' }).mockResolvedValueOnce({ ops: [], serverTs: tB, serverId: '' });

        await syncAllLoggedInUsers(db);

        const cursorA = await db.get('syncCursors', 'user-a');
        const cursorB = await db.get('syncCursors', 'user-b');
        expect(cursorA?.lastSyncedTs).toBe(tA);
        expect(cursorB?.lastSyncedTs).toBe(tB);
    });

    it('a successful pass clears a stale reauth flag (re-login happened in another tab)', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        resetAccountReauthStore();
        flagAccountNeedsReauth('user-a');

        await syncAllLoggedInUsers(db);

        // user-a's flush+pull succeeded, proving its session works again — the flag must clear
        // so the "Sync is broken" dialog/banner stop showing without a page reload.
        expect(getReauthFlaggedUserIds()).toEqual([]);
    });

    it('a flag raised MID-pass survives the pass succeeding (it reports a new failure, not a stale one)', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        resetAccountReauthStore();

        // Simulate the Service Worker relay flagging user-a while its pull is in flight — the
        // pre-pass snapshot in syncOneUser must prevent the success from erasing this fresh flag.
        vi.mocked(fetchSyncOps).mockImplementationOnce(async () => {
            flagAccountNeedsReauth('user-a');
            return { ops: [], serverTs: '2025-01-02T00:00:00.000Z', serverId: '' };
        });

        await syncAllLoggedInUsers(db);

        expect(getReauthFlaggedUserIds()).toEqual(['user-a']);
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
            serverId: '',
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
        vi.mocked(fetchSyncOps)
            .mockResolvedValueOnce({ ops: [], serverTs: '2025-01-02T00:00:00.000Z', serverId: '' })
            .mockRejectedValueOnce(new Error('GET /sync/pull 502'));

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

    it('multi-user device skips a still-missing user, warns, and dispatches a reauth-needed event', async () => {
        // user-orphan is in IDB but missing from the multi-session list — even after the defensive
        // in-loop refresh. Pulling for them under whichever cookie is set would attribute another
        // user's data to user-orphan's cursor. The orchestrator must skip them (one pull total),
        // warn, AND surface a reauth signal so the user isn't left with silently-absent data.
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-orphan', 'orphan@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        // window is undefined under the `node` test env; stub it so dispatchAccountNeedsReauth fires.
        const dispatchSpy = vi.fn();
        vi.stubGlobal('window', { dispatchEvent: dispatchSpy } as unknown as Window);

        await syncAllLoggedInUsers(db);

        // user-a got its pull; user-orphan was skipped — only one pull in total.
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('user-orphan'))).toBe(true);

        // Exactly the orphan's reauth event fired, carrying its userId.
        const reauthEvents = dispatchSpy.mock.calls.map(([e]) => e as CustomEvent).filter((e) => e.type === ACCOUNT_NEEDS_REAUTH_EVENT);
        expect(reauthEvents).toHaveLength(1);
        const [reauthEvent] = reauthEvents;
        if (!reauthEvent) throw new Error('expected one reauth event');
        expect(reauthEvent.detail).toEqual({ userId: 'user-orphan' });

        vi.unstubAllGlobals();
        warnSpy.mockRestore();
    });

    it('multi-user device recovers a stale-snapshot user via the in-loop session refresh', async () => {
        // user-c is logged in but absent from the boot-time session snapshot (login finished in
        // another tab after the orchestrator captured the list). The defensive in-loop refresh
        // re-fetches and finds it, so user-c is synced with no reauth event dispatched.
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-c', 'c@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        // Give user-c a cursor so its recovered pass pulls (not bootstraps) — keeps the
        // fetchSyncOps call-count assertion clean.
        await db.put('syncCursors', { userId: 'user-c', lastSyncedTs: '2025-01-01T00:00:00.000Z', lastSyncedId: '' });

        // Boot snapshot: user-c missing. In-loop refresh: full list (user-c present). The default
        // mock returns a/b/c, so we only override the FIRST call (the boot-time load).
        vi.mocked(authClient.multiSession.listDeviceSessions).mockResolvedValueOnce({
            data: [
                { user: { id: 'user-a' }, session: { token: 'token-a' } },
                { user: { id: 'user-b' }, session: { token: 'token-b' } },
            ],
        } as Awaited<ReturnType<typeof authClient.multiSession.listDeviceSessions>>);

        const dispatchSpy = vi.fn();
        vi.stubGlobal('window', { dispatchEvent: dispatchSpy } as unknown as Window);

        await syncAllLoggedInUsers(db);

        // Both user-a and user-c synced — the refresh recovered user-c.
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(2);
        // user-c was pivoted to via its now-resolved token.
        const setActiveCalls = vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);
        expect(setActiveCalls).toContain('token-c');
        // No reauth event — the user was recovered, not skipped.
        const reauthEvents = dispatchSpy.mock.calls.map(([e]) => e as CustomEvent).filter((e) => e.type === ACCOUNT_NEEDS_REAUTH_EVENT);
        expect(reauthEvents).toHaveLength(0);

        vi.unstubAllGlobals();
    });

    it('flags a user for reauth on a 401 mid-flush/pull and continues the loop for other users', async () => {
        // Distinct from the "no multi-session entry" case above: here the pivot succeeds (a valid
        // multi-session token exists) but the pivoted Better Auth cookie itself has expired, so the
        // flush/pull calls come back 401. The orchestrator must flag this user and move on rather
        // than aborting the whole loop or leaving the failure silent.
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        vi.mocked(fetchSyncOps)
            .mockRejectedValueOnce(new SyncAuthError('GET /sync/pull'))
            .mockResolvedValueOnce({ ops: [], serverTs: '2025-01-02T00:00:00.000Z', serverId: '' });

        const dispatchSpy = vi.fn();
        vi.stubGlobal('window', { dispatchEvent: dispatchSpy } as unknown as Window);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const onUserSynced = vi.fn<(userId: string) => Promise<void>>(async () => undefined);

        await syncAllLoggedInUsers(db, { onUserSynced });

        // user-a's pass 401'd; user-b's pass still ran — the loop didn't abort.
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(2);
        const reauthEvents = dispatchSpy.mock.calls.map(([e]) => e as CustomEvent).filter((e) => e.type === ACCOUNT_NEEDS_REAUTH_EVENT);
        expect(reauthEvents).toHaveLength(1);
        const [reauthEvent] = reauthEvents;
        if (!reauthEvent) throw new Error('expected one reauth event');
        expect(reauthEvent.detail).toEqual({ userId: 'user-a' });

        // onUserSynced must NOT run for the 401'd user — only user-b's pass completed successfully.
        expect(onUserSynced).toHaveBeenCalledTimes(1);
        expect(onUserSynced).toHaveBeenCalledWith('user-b');

        vi.unstubAllGlobals();
        warnSpy.mockRestore();
    });

    it('flags a user for reauth on a 401 from bootstrap (no prior syncCursors row)', async () => {
        // Distinct from the pull-401 case above: this user has never synced on this device, so
        // pullOrBootstrap chooses fetchBootstrap instead of fetchSyncOps. A stale cookie 401's there
        // just as easily and must be caught the same way.
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-c', 'c@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        await db.delete('syncCursors', 'user-c');

        const bootstrapMod = await import('#api/syncClient');
        vi.mocked(bootstrapMod.fetchBootstrap).mockRejectedValueOnce(new SyncAuthError('GET /sync/bootstrap'));

        const dispatchSpy = vi.fn();
        vi.stubGlobal('window', { dispatchEvent: dispatchSpy } as unknown as Window);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await syncAllLoggedInUsers(db);

        // user-c never got a cursor row — the bootstrap never completed.
        const cursorC = await db.get('syncCursors', 'user-c');
        expect(cursorC).toBeUndefined();

        const reauthEvents = dispatchSpy.mock.calls.map(([e]) => e as CustomEvent).filter((e) => e.type === ACCOUNT_NEEDS_REAUTH_EVENT);
        expect(reauthEvents).toHaveLength(1);
        const [reauthEvent] = reauthEvents;
        if (!reauthEvent) throw new Error('expected one reauth event');
        expect(reauthEvent.detail).toEqual({ userId: 'user-c' });

        vi.unstubAllGlobals();
        warnSpy.mockRestore();
    });

    it('single-account device dispatches no reauth event even with an empty session list', async () => {
        // Single-account dev login: no multi-session entry, only the primary cookie. The single-user
        // branch is legitimately session-less and must stay silent — no skip, no reauth signal.
        vi.mocked(authClient.multiSession.listDeviceSessions).mockResolvedValueOnce({ data: [] });
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const dispatchSpy = vi.fn();
        vi.stubGlobal('window', { dispatchEvent: dispatchSpy } as unknown as Window);

        await syncAllLoggedInUsers(db);

        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(1);
        const reauthEvents = dispatchSpy.mock.calls.map(([e]) => e as CustomEvent).filter((e) => e.type === ACCOUNT_NEEDS_REAUTH_EVENT);
        expect(reauthEvents).toHaveLength(0);

        vi.unstubAllGlobals();
    });
});

describe('withAccountSession', () => {
    it('pivots to the target account then restores the previously-active session', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const task = vi.fn(async () => 'result');
        const result = await withAccountSession(db, 'user-b', task);

        expect(result).toBe('result');
        const setActiveCalls = vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);
        // First pivot to user-b for the task, last pivot back to user-a (restore).
        expect(setActiveCalls[0]).toBe('token-b');
        expect(setActiveCalls.at(-1)).toBe('token-a');
        // IDB active account is restored too.
        const active = await db.get('activeAccount', 'active');
        expect(active?.userId).toBe('user-a');
    });

    it('runs the task with no pivot on a single-account device', async () => {
        vi.mocked(authClient.multiSession.listDeviceSessions).mockResolvedValueOnce({ data: [] });
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const task = vi.fn(async () => 'ok');
        const result = await withAccountSession(db, 'user-a', task);

        expect(result).toBe('ok');
        expect(task).toHaveBeenCalledTimes(1);
        // No session entry to pivot to — setActive is never called.
        expect(vi.mocked(authClient.multiSession.setActive)).not.toHaveBeenCalled();
    });

    it('warns and runs without a pivot when the target has no session on a multi-account device', async () => {
        // The Bug A failure mode: device has sessions (default mock lists a/b/c) but the target user
        // is absent. We can't pivot, so the task runs under the ambient cookie and we warn — we must
        // NOT call setActive (which would corrupt the active session to a wrong/nonexistent token).
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const task = vi.fn(async () => 'ran');
        const result = await withAccountSession(db, 'user-z', task);

        expect(result).toBe('ran');
        expect(task).toHaveBeenCalledTimes(1);
        expect(vi.mocked(authClient.multiSession.setActive)).not.toHaveBeenCalled();
        expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('user-z'))).toBe(true);
        warnSpy.mockRestore();
    });

    it('restores the previously-active session even when the task throws', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const task = vi.fn(async () => {
            throw new Error('mutation failed');
        });
        await expect(withAccountSession(db, 'user-b', task)).rejects.toThrow('mutation failed');

        const setActiveCalls = vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);
        // The finally block restores a@ before the error escapes.
        expect(setActiveCalls.at(-1)).toBe('token-a');
        const active = await db.get('activeAccount', 'active');
        expect(active?.userId).toBe('user-a');
    });

    it('serializes overlapping calls — setActive writes never interleave', async () => {
        // Two concurrent withAccountSession calls must not interleave their pivots: the gate runs
        // them strictly one after the other. We assert the setActive call sequence reflects a full
        // pivot+restore for the first call before the second's pivot begins.
        setSessionGateTimeoutMs(2_000); // keep the gate snappy if anything stalls
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        // Each task resolves on the next microtask so the two calls genuinely overlap in flight.
        const first = withAccountSession(db, 'user-b', async () => 'first');
        const second = withAccountSession(db, 'user-b', async () => 'second');
        await Promise.all([first, second]);

        const setActiveCalls = vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);
        // Serialized: [pivot-b, restore-a, pivot-b, restore-a] — never [pivot-b, pivot-b, …].
        expect(setActiveCalls).toEqual(['token-b', 'token-a', 'token-b', 'token-a']);
        setSessionGateTimeoutMs(10_000);
    });
});

describe('reconcileActiveSessionCookie', () => {
    it('no-ops when the cookie session already matches the IDB-active account', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        // Default getSession mock reports user-a — already aligned.

        await reconcileActiveSessionCookie(db);

        expect(authClient.multiSession.setActive).not.toHaveBeenCalled();
        expect(authClient.multiSession.listDeviceSessions).not.toHaveBeenCalled();
    });

    it('pivots the cookie to the IDB-active account when misaligned (IDB is the user intent)', async () => {
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-b' }, 'active');
        // Cookie still points at user-a (e.g. after an offline switch to user-b + reload).
        vi.mocked(authClient.getSession).mockResolvedValueOnce({ data: { user: { id: 'user-a' } } });

        await reconcileActiveSessionCookie(db);

        const setActiveCalls = vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);
        expect(setActiveCalls).toEqual(['token-b']);
    });

    it('dispatches a reauth signal (no pivot) when the IDB-active account has no live session', async () => {
        await seedAccount(db, 'user-orphan', 'orphan@example.com');
        await db.put('activeAccount', { userId: 'user-orphan' }, 'active');
        vi.mocked(authClient.getSession).mockResolvedValueOnce({ data: { user: { id: 'user-a' } } });
        const dispatchSpy = vi.fn();
        vi.stubGlobal('window', { dispatchEvent: dispatchSpy } as unknown as Window);

        await reconcileActiveSessionCookie(db);

        expect(authClient.multiSession.setActive).not.toHaveBeenCalled();
        const reauthEvents = dispatchSpy.mock.calls.map(([e]) => e as CustomEvent).filter((e) => e.type === ACCOUNT_NEEDS_REAUTH_EVENT);
        expect(reauthEvents).toHaveLength(1);
        const [reauthEvent] = reauthEvents;
        if (!reauthEvent) throw new Error('expected one reauth event');
        expect(reauthEvent.detail).toEqual({ userId: 'user-orphan' });
        vi.unstubAllGlobals();
    });

    it('swallows network errors — offline reconcile defers to the next online pass', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        vi.mocked(authClient.getSession).mockRejectedValueOnce(new Error('Failed to fetch'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const dispatchSpy = vi.fn();
        vi.stubGlobal('window', { dispatchEvent: dispatchSpy } as unknown as Window);

        await expect(reconcileActiveSessionCookie(db)).resolves.toBeUndefined();

        expect(authClient.multiSession.setActive).not.toHaveBeenCalled();
        expect(dispatchSpy.mock.calls.filter(([e]) => (e as CustomEvent).type === ACCOUNT_NEEDS_REAUTH_EVENT)).toHaveLength(0);
        vi.unstubAllGlobals();
        warnSpy.mockRestore();
    });

    it('no-ops when there is no IDB-active account', async () => {
        await reconcileActiveSessionCookie(db);
        expect(authClient.getSession).not.toHaveBeenCalled();
        expect(authClient.multiSession.setActive).not.toHaveBeenCalled();
    });
});

describe('reconcileActiveSessionCookie × syncAllLoggedInUsers — gate serialization', () => {
    it('serializes with the orchestrator via the session gate — the reconcile pivot never interleaves a sync pass', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-b' }, 'active');
        // Cookie points at user-a while IDB says user-b — the reconcile must pivot to token-b.
        vi.mocked(authClient.getSession).mockResolvedValue({ data: { user: { id: 'user-a' } } });

        // Fire both without awaiting the first: the reconcile acquires the gate synchronously at
        // call time, so it must fully complete (its single pivot) BEFORE the orchestrator's
        // per-user pivots begin — never interleaved with them.
        const reconcile = reconcileActiveSessionCookie(db);
        const orchestrate = syncAllLoggedInUsers(db);
        await Promise.all([reconcile, orchestrate]);

        const setActiveCalls = vi.mocked(authClient.multiSession.setActive).mock.calls.map((c) => c[0]?.sessionToken);
        // [reconcile pivot-b] then the orchestrator's [pivot-a, pivot-b, restore-b] — the leading
        // token-b is the reconcile's, proving it ran to completion first under the gate.
        expect(setActiveCalls).toEqual(['token-b', 'token-a', 'token-b', 'token-b']);
    });
});
