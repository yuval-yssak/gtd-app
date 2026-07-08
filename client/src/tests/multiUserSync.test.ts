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
import { fetchSyncOps, pushSyncOps, SyncAuthError } from '#api/syncClient';
import { ACCOUNT_NEEDS_REAUTH_EVENT } from '../contexts/accountReauthEvents';
import { syncAllLoggedInUsers, syncSingleUser, withAccountSession } from '../db/multiUserSync';
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
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({ ops: [], serverTs: tA, serverId: '' }).mockResolvedValueOnce({ ops: [], serverTs: tB, serverId: '' });

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
