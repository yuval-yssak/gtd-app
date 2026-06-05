import type { IDBPDatabase } from 'idb';
import { dispatchAccountNeedsReauth } from '../contexts/accountReauthEvents';
import { authClient } from '../lib/authClient';
import type { MyDB } from '../types/MyDB';
import { getActiveAccount, getLoggedInUserIds, setActiveAccount } from './accountHelpers';
import { bootstrapFromServerUnguarded, flushSyncQueue, pullFromServerUnguarded, withSessionGate } from './syncHelpers';

/**
 * Optional callbacks injected by tests + AppDataProvider so the orchestrator can drive
 * calendar sync per-user without taking a hard dependency on the calendar API module
 * (which would create a circular import — AppDataProvider imports both this and the API).
 */
export interface SyncAllLoggedInUsersOptions {
    /** Called once per pass after pull settles, with the userId being synced. */
    onUserSynced?: (userId: string) => Promise<void> | void;
}

interface DeviceSession {
    sessionToken: string;
    userId: string;
}

/**
 * Runs a per-user sync pass for every logged-in account on this device. Each pass:
 *   1. pivots `multiSession.setActive` to that account so the server reads the right session,
 *   2. flushes the queued ops scoped to that user,
 *   3. pulls (or bootstraps on first run) under that session,
 *   4. invokes `onUserSynced` so the caller can run calendar-integration sync for that user.
 *
 * The loop is strictly serialized — concurrent active-session swaps would race the cookie write,
 * leaving the server reading the wrong session for at least one of the passes.
 *
 * The user's previously-active session is restored at the end via `try/finally`, even when a
 * per-user pass throws.
 */
export async function syncAllLoggedInUsers(db: IDBPDatabase<MyDB>, options: SyncAllLoggedInUsersOptions = {}): Promise<void> {
    // The whole loop pivots the active Better Auth session multiple times, so it must serialize
    // against any standalone `pullFromServer` call. Without the gate, an SSE-driven pull for a
    // different user could fetch under the wrong session mid-pivot and write to the wrong cursor.
    return withSessionGate(async () => {
        const userIds = await getLoggedInUserIds(db);
        if (!userIds.length) {
            return;
        }
        const sessions = await loadDeviceSessionsByUserId();
        const previouslyActive = await getActiveAccount(db);
        const previouslyActiveSession = previouslyActive ? sessions.get(previouslyActive.id) : undefined;
        try {
            for (const userId of userIds) {
                await syncOneUser(db, userId, sessions, options, userIds.length);
            }
        } finally {
            await restorePreviouslyActiveSession(db, previouslyActive?.id, previouslyActiveSession);
        }
    });
}

/**
 * Pivot, flush, pull, and restore for a single user. Used by the SSE handler when a non-active
 * channel fires — running the full orchestrator there would re-sync every account and run every
 * calendar integration on every event, multiplying network round-trips for no benefit. This helper
 * does just the targeted work and restores the prior active session afterwards.
 *
 * Acquires the session gate, so it serializes correctly against other pulls and `syncAllLoggedInUsers`.
 *
 * **Requires** a Better Auth multi-session entry for `userId` — that's the only signal that a
 * cookie pivot is even possible. Without it we'd authenticate as whoever the cookie currently
 * points at and silently attribute that user's data to `userId`'s cursor. Throws if no entry
 * exists; the SSE channel for a session-less user shouldn't fire in the first place.
 */
export async function syncSingleUser(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    return withSessionGate(async () => {
        const sessions = await loadDeviceSessionsByUserId();
        if (!sessions.has(userId)) {
            throw new Error(
                `syncSingleUser: no Better Auth multi-session entry for ${userId} — cannot pivot the cookie, refusing to pull under the wrong session`,
            );
        }
        const previouslyActive = await getActiveAccount(db);
        const previouslyActiveSession = previouslyActive ? sessions.get(previouslyActive.id) : undefined;
        try {
            // totalUsers > 1 wouldn't matter here because we've already verified the session entry
            // exists — `syncOneUser` will take the pivot branch unconditionally. We pass 2 to
            // signal "multi-user device" so the no-pivot fallback in `syncOneUser` is unreachable
            // by construction (defense-in-depth against future refactors).
            await syncOneUser(db, userId, sessions, {}, 2);
        } finally {
            await restorePreviouslyActiveSession(db, previouslyActive?.id, previouslyActiveSession);
        }
    });
}

/**
 * Runs `task` with the Better Auth active session pivoted to `userId`, then restores the previously
 * active session. Use this around any API call that the server scopes to `c.get('session').user.id`
 * but that targets a SPECIFIC account's resource — e.g. the calendar-integration endpoints. Without
 * the pivot, multi-session lets the ambient cookie point at a different signed-in account than the
 * one the app is managing, so the request resolves under the wrong user (404 on the target's
 * integration). Mirrors the sync orchestrator's pivot/restore, under the same session gate so it
 * serializes against pulls and `syncAllLoggedInUsers`.
 *
 * Single-account device (no multi-session entry, only the primary cookie): no pivot needed — the
 * cookie already authenticates as this user — so the task runs as-is.
 */
export async function withAccountSession<T>(db: IDBPDatabase<MyDB>, userId: string, task: () => Promise<T>): Promise<T> {
    return withSessionGate(async () => {
        const sessions = await loadDeviceSessionsByUserId();
        const target = sessions.get(userId);
        if (!target) {
            // No multi-session entry: either a single-account device (primary cookie already this
            // user) or a session-less flow. Run without a pivot — pivoting is impossible and, on a
            // single-account device, unnecessary.
            if (sessions.size > 0) {
                console.warn(`[withAccountSession] no multi-session entry for ${userId} on a multi-account device — running under the ambient session`);
            }
            return task();
        }
        const previouslyActive = await getActiveAccount(db);
        const previouslyActiveSession = previouslyActive ? sessions.get(previouslyActive.id) : undefined;
        try {
            await authClient.multiSession.setActive({ sessionToken: target.sessionToken });
            await setActiveAccount(userId, db);
            return await task();
        } finally {
            await restorePreviouslyActiveSession(db, previouslyActive?.id, previouslyActiveSession);
        }
    });
}

/**
 * Defensive single re-fetch of the device session list to re-resolve a user that was missing from
 * the boot-time snapshot. Covers the stale-snapshot sub-case where a login completed in another tab
 * after `syncAllLoggedInUsers` captured `sessions`. Best-effort — a failed refresh returns undefined
 * so the caller falls through to the skip-and-signal path.
 */
async function refreshSessionForUser(userId: string): Promise<DeviceSession | undefined> {
    try {
        const refreshed = await loadDeviceSessionsByUserId();
        return refreshed.get(userId);
    } catch {
        return undefined;
    }
}

/** Reads every device session and indexes it by user id so the orchestrator can pivot in O(1). */
async function loadDeviceSessionsByUserId(): Promise<Map<string, DeviceSession>> {
    const { data: sessions } = await authClient.multiSession.listDeviceSessions();
    const map = new Map<string, DeviceSession>();
    for (const s of sessions ?? []) {
        map.set(s.user.id, { sessionToken: s.session.token, userId: s.user.id });
    }
    return map;
}

/**
 * One pass of the orchestrator. Pivots the active session when a multi-session entry exists for
 * this user, then runs flush + pull + the caller-supplied per-user hook.
 *
 * When no multi-session entry exists for `userId`:
 * - **Single-user device** (one entry in `userIds` total): proceed without a pivot. The dev-login
 *   bypass and single-account flows only carry the primary `better-auth.session_token` cookie, so
 *   `listDeviceSessions()` returns empty — but the cookie already authenticates as this user.
 * - **Multi-user device** (more than one entry): re-fetch the session list once (the boot-time
 *   snapshot can predate a login completed in another tab) and re-resolve. If now present, pivot
 *   and proceed. If still missing, skip with a warning AND dispatch a reauth-needed signal so the
 *   user sees a banner instead of silent data absence — without a session token we'd authenticate
 *   as whoever the cookie points at and attribute their data to the wrong cursor (the failure mode
 *   `assertActiveSessionMatches` catches downstream).
 */
async function syncOneUser(
    db: IDBPDatabase<MyDB>,
    userId: string,
    sessions: Map<string, DeviceSession>,
    options: SyncAllLoggedInUsersOptions,
    totalUsers: number,
): Promise<void> {
    const session = sessions.get(userId) ?? (totalUsers > 1 ? await refreshSessionForUser(userId) : undefined);
    if (session) {
        await authClient.multiSession.setActive({ sessionToken: session.sessionToken });
        await setActiveAccount(userId, db);
    } else if (totalUsers > 1) {
        console.warn(`[multi-sync] no multi-session entry for ${userId} on a multi-user device — skipping pass to avoid cross-user data corruption`);
        // Surface it so the user can re-login instead of silently never seeing this account's data.
        dispatchAccountNeedsReauth(userId);
        return;
    } else {
        // Single-user case: no pivot needed, but make sure IDB active matches so the downstream
        // session-match guard passes (it reads IDB's activeAccount).
        await setActiveAccount(userId, db);
    }
    await flushSyncQueue(db, { userIdFilter: userId });
    await pullOrBootstrap(db, userId);
    if (options.onUserSynced) {
        await options.onUserSynced(userId);
    }
}

/**
 * Bootstraps when this (device, user) pair has never synced (no per-user cursor row); otherwise
 * does an incremental pull. Per-user cursors mean each Better Auth account on this device runs
 * its own bootstrap-or-pull decision — a brand-new account on an existing device still bootstraps
 * even though the device itself has been seen before.
 */
async function pullOrBootstrap(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    const cursor = await db.get('syncCursors', userId);
    if (!cursor) {
        // Unguarded — `syncAllLoggedInUsers` already holds the session gate. Calling the
        // gated version here would recurse and deadlock (the inner withSessionGate chains on the
        // outer's promise, which can't resolve until the inner completes).
        await bootstrapFromServerUnguarded(db, userId);
        return;
    }
    await pullFromServerUnguarded(db, userId);
}

/**
 * Restores the active session the user had before the orchestrator ran. Best-effort: if the
 * previously-active account or its server-side session is no longer available, we leave the
 * cookie pointing at whichever account ended the loop — the boot effect's `loadAll` will
 * re-converge IDB with whatever session the cookie now references.
 */
async function restorePreviouslyActiveSession(
    db: IDBPDatabase<MyDB>,
    previousUserId: string | undefined,
    previouslyActiveSession: DeviceSession | undefined,
): Promise<void> {
    if (!previousUserId || !previouslyActiveSession) {
        return;
    }
    try {
        await authClient.multiSession.setActive({ sessionToken: previouslyActiveSession.sessionToken });
        await setActiveAccount(previousUserId, db);
    } catch (err) {
        console.warn('[multi-sync] failed to restore previously-active session', err);
    }
}
