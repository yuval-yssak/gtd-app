import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { fetchUserStatus } from '#api/accountApi';
import { BootstrapRequiredError, SyncAuthError } from '../api/syncClient';
import { clearAccountReauthAfterSuccessfulSync, dispatchAccountNeedsReauth, isAccountFlaggedForReauth } from '../contexts/accountReauthEvents';
import { enterCase2Recovery } from '../contexts/syncRecoveryStore';
import { authClient } from '../lib/authClient';
import { hasAtLeastOne } from '../lib/typeUtils';
import type { MyDB } from '../types/MyDB';
import { getActiveAccount, getLoggedInUserIds, setActiveAccount } from './accountHelpers';
import { evaporateUserAndRecover } from './evaporateUser';
import { bootstrapFromServerUnguarded, flushSyncQueue, pullFromServerUnguarded, withSessionGate } from './syncHelpers';
import { countQueuedOpsForUser, isDeviceUnregistered, recoverFromBootstrapRequiredUnderGate } from './syncRecovery';

/**
 * Optional callbacks injected by tests + AppDataProvider so the orchestrator can drive
 * calendar sync per-user without taking a hard dependency on the calendar API module
 * (which would create a circular import — AppDataProvider imports both this and the API).
 */
export interface SyncAllLoggedInUsersOptions {
    /** Called once per pass after pull settles, with the userId being synced. */
    onUserSynced?: (userId: string) => Promise<void> | void;
    /**
     * Called for every logged-in account the server reports as deleted (tombstoned): before the
     * loop for accounts the pre-loop probe caught (they are not synced), and after the loop — once
     * the user's real active session is restored — for accounts whose dead session turned out to be
     * a deletion mid-pass. Returns whether a full-page navigation was scheduled (the active account
     * went away). Defaults to `evaporateUserAndRecover`; injectable so tests can observe the
     * decision without the default's `window.location` navigation.
     */
    onUserDeleted?: OnUserDeleted;
}

type OnUserDeleted = (userId: string) => Promise<{ navigated: boolean }>;

/**
 * Minimum gap between two tombstone probes for the same account. The sync pass runs on boot,
 * online, resume, SW push and catch-up — and every probe is a billed request through the Cloudflare
 * Worker in front of the API, whose free-tier daily cap this project has hit before. A deletion is
 * rare and a live device learns of it over SSE anyway, so a 10-minute probe cadence costs nothing
 * in practice; the one case that must not wait is a `SyncAuthError` (see `syncOneUser`), where the
 * probe is forced because "401" is exactly the ambiguous signal the tombstone exists to resolve.
 */
const USER_STATUS_PROBE_INTERVAL_MS = 10 * 60_000;
const lastProbedMs = new Map<string, number>();

/** Test-only: forget every probe timestamp so a spec starts from a cold throttle. */
export function resetUserStatusProbeThrottleForTests(): void {
    lastProbedMs.clear();
}

/** Probes the tombstone endpoint, honouring the throttle unless `force` is set. `undefined` ⇒ throttled, nothing asked. */
async function probeUserStatus(userId: string, force: boolean): Promise<'active' | 'deleted' | 'unknown' | undefined> {
    const now = dayjs().valueOf();
    const last = lastProbedMs.get(userId);
    if (!force && last !== undefined && now - last < USER_STATUS_PROBE_INTERVAL_MS) {
        return undefined;
    }
    const { status } = await fetchUserStatus(userId);
    // Only `active` starts the window. `unknown` (offline boot, 429, 5xx, timeout) must not burn it,
    // or the `online` pass that follows an offline boot would skip the real probe. `deleted` is
    // terminal and must stay re-askable — it also CLEARS a window an earlier `active` answer opened
    // (the pre-loop probe runs before the pass whose 401 forces the re-probe): if the evaporation
    // it triggers is lost (a later pass in the same loop throws before the post-restore evaporation
    // runs), the next pre-loop probe has to find it again instead of hiding the account for 10
    // minutes with no reauth flag either.
    if (status === 'active') {
        lastProbedMs.set(userId, now);
    } else if (status === 'deleted') {
        lastProbedMs.delete(userId);
    }
    return status;
}

/** The evaporation hook callers get when they inject none: the ungated wipe + recovery (the orchestrator holds the gate). */
function resolveOnUserDeleted(db: IDBPDatabase<MyDB>, options: SyncAllLoggedInUsersOptions): OnUserDeleted {
    return options.onUserDeleted ?? ((userId) => evaporateUserAndRecover(db, userId));
}

interface DeviceSession {
    sessionToken: string;
    userId: string;
}

/**
 * Runs a per-user sync pass for every logged-in account on this device. Before the loop, every
 * account is checked against the unauthenticated tombstone endpoint (throttled per account — see
 * `USER_STATUS_PROBE_INTERVAL_MS`): an account deleted server-side is evaporated (`onUserDeleted`)
 * and skipped — this is the year-offline path, where the session cookie is long dead and a 401
 * alone could not tell "expired" from "deleted". `active` and `unknown` (endpoint unreachable /
 * rate-limited) proceed as today — fail-open by design. When the evaporated account was the active
 * one a reload is already scheduled, so the pass returns without touching the survivors.
 *
 * Each pass:
 *   1. pivots `multiSession.setActive` to that account so the server reads the right session,
 *   2. flushes the queued ops scoped to that user,
 *   3. pulls (or bootstraps on first run) under that session,
 *   4. invokes `onUserSynced` so the caller can run calendar-integration sync for that user.
 *
 * The loop is strictly serialized — concurrent active-session swaps would race the cookie write,
 * leaving the server reading the wrong session for at least one of the passes.
 *
 * The user's previously-active session is restored after the passes (`.finally`), even when a
 * per-user pass throws. Accounts whose dead session turned out to be a deletion are evaporated
 * only after that restore.
 *
 * Resolves `{ navigated: true }` when an evaporation scheduled a full-page navigation — the caller
 * must then stop (anything it does afterwards, e.g. another `location.href` write, would race or
 * override the reload).
 */
export async function syncAllLoggedInUsers(db: IDBPDatabase<MyDB>, options: SyncAllLoggedInUsersOptions = {}): Promise<{ navigated: boolean }> {
    // The whole loop pivots the active Better Auth session multiple times, so it must serialize
    // against any standalone `pullFromServer` call. Without the gate, an SSE-driven pull for a
    // different user could fetch under the wrong session mid-pivot and write to the wrong cursor.
    return withSessionGate(async () => {
        const loggedInUserIds = await getLoggedInUserIds(db);
        if (!loggedInUserIds.length) {
            return { navigated: false };
        }
        const resolvedOptions = { ...options, onUserDeleted: resolveOnUserDeleted(db, options) };
        const { survivors, navigated } = await evaporateDeletedUsers(loggedInUserIds, resolvedOptions.onUserDeleted);
        if (navigated || !hasAtLeastOne(survivors)) {
            return { navigated };
        }
        const sessions = await loadDeviceSessionsByUserId();
        const previouslyActive = await getActiveAccount(db);
        const previouslyActiveSession = previouslyActive ? sessions.get(previouslyActive.id) : undefined;
        const deletedMidPass = await syncSurvivors(db, survivors, sessions, resolvedOptions).finally(() =>
            restorePreviouslyActiveSession(db, previouslyActive?.id, previouslyActiveSession),
        );
        // Evaporate only AFTER the restore: inside a pass, IDB's activeAccount points at the account
        // being synced, so an evaporation there would read `wasActive` for the wrong account, pivot
        // to an arbitrary survivor and reload a tab that had nothing to do with the deletion.
        return { navigated: await evaporateEach(deletedMidPass, resolvedOptions.onUserDeleted) };
    });
}

/** Runs every survivor's pass in order and returns the accounts whose dead session turned out to be a deletion. */
async function syncSurvivors(db: IDBPDatabase<MyDB>, survivors: string[], sessions: Map<string, DeviceSession>, options: SyncAllLoggedInUsersOptions) {
    const outcomes = await mapSequentially(survivors, async (userId) => ({
        userId,
        outcome: await syncOneUser(db, userId, sessions, options, survivors.length),
    }));
    return outcomes.filter(({ outcome }) => outcome === 'deleted').map(({ userId }) => userId);
}

/** Sequential async map — passes pivot the shared session cookie, so they must never overlap. */
async function mapSequentially<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    for (const item of items) {
        results.push(await fn(item));
    }
    return results;
}

/**
 * Probes the tombstone endpoint for every account (throttled) and evaporates the deleted ones.
 * Returns the ids still worth syncing, plus whether an evaporation scheduled a reload. The probes
 * run in parallel (one cheap unauthenticated GET each) so a multi-account device pays one
 * round-trip, not N.
 */
async function evaporateDeletedUsers(userIds: string[], onUserDeleted: OnUserDeleted): Promise<{ survivors: string[]; navigated: boolean }> {
    const statuses = await Promise.all(userIds.map(async (userId) => ({ userId, status: await probeUserStatus(userId, false) })));
    const deleted = statuses.filter(({ status }) => status === 'deleted').map(({ userId }) => userId);
    if (hasAtLeastOne(deleted)) {
        console.warn(`[multi-sync] account(s) deleted server-side — evaporating local data: ${deleted.join(', ')}`);
    }
    const navigated = await evaporateEach(deleted, onUserDeleted);
    return { survivors: statuses.filter(({ status }) => status !== 'deleted').map(({ userId }) => userId), navigated };
}

/**
 * Sequential on purpose — each evaporation may pivot the active account, which must not interleave.
 * Stops at the first evaporation that scheduled a reload: the page is going away, and the remaining
 * deleted accounts are caught by the next boot's probe.
 */
async function evaporateEach(userIds: string[], onUserDeleted: OnUserDeleted): Promise<boolean> {
    for (const userId of userIds) {
        if ((await onUserDeleted(userId)).navigated) {
            return true;
        }
    }
    return false;
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
        // totalUsers > 1 wouldn't matter here because we've already verified the session entry
        // exists — `syncOneUser` will take the pivot branch unconditionally. We pass 2 to
        // signal "multi-user device" so the no-pivot fallback in `syncOneUser` is unreachable
        // by construction (defense-in-depth against future refactors).
        const outcome = await syncOneUser(db, userId, sessions, {}, 2).finally(() =>
            restorePreviouslyActiveSession(db, previouslyActive?.id, previouslyActiveSession),
        );
        // After the restore, for the same reason as in syncAllLoggedInUsers: the pass left IDB's
        // activeAccount on `userId`, which is not necessarily the account the user chose.
        if (outcome === 'deleted') {
            await evaporateEach([userId], resolveOnUserDeleted(db, {}));
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
 * Converges the server-side Better Auth active-session cookie onto IDB's `activeAccount` — IDB is
 * the user's intent (the offline-capable account switch writes ONLY IDB and reloads; see
 * `useAccounts.switchToAccount`). Called from AppDataProvider's boot path (before the first
 * `syncAndRefresh`) and from the online-transition path BEFORE the unscoped `flushSyncQueue` —
 * that ordering closes two windows where the drifted cookie caused misattribution: a Service
 * Worker push-driven flush authenticating as the previous account, and the online flush 400-ing
 * on the misroute guard.
 *
 * Alignment already correct → no-op (one cheap getSession call). Misaligned → pivot the cookie
 * via `multiSession.setActive` to match IDB. No session for the IDB-active account at all →
 * dispatch the reauth signal so the user gets the dialog/banner instead of silent stale data.
 * Network errors are swallowed: offline means the cookie can't drift further anyway, and the
 * next online pass re-runs this. The sync orchestrator's `restorePreviouslyActiveSession`
 * already converges the cookie on every pass — this is a deterministic front-runner.
 */
export async function reconcileActiveSessionCookie(db: IDBPDatabase<MyDB>): Promise<void> {
    return withSessionGate(async () => {
        const active = await getActiveAccount(db);
        if (!active) {
            return;
        }
        try {
            await pivotCookieToAccount(active.id);
        } catch (err) {
            // Offline or server unreachable — reconcile is deferred to the next online transition.
            console.warn('[multi-sync] reconcileActiveSessionCookie skipped (network unreachable)', err);
        }
    });
}

/** The probe-compare-pivot chain of the cookie reconcile. Caller holds the session gate. */
async function pivotCookieToAccount(activeUserId: string): Promise<void> {
    const { data: session } = await authClient.getSession();
    if (session?.user.id === activeUserId) {
        return;
    }
    const sessions = await loadDeviceSessionsByUserId();
    const target = sessions.get(activeUserId);
    if (!target) {
        // The IDB-active account has no live Better Auth session on this device (expired or
        // revoked). Cached data still renders; surface the non-silent reauth affordance.
        dispatchAccountNeedsReauth(activeUserId);
        return;
    }
    await authClient.multiSession.setActive({ sessionToken: target.sessionToken });
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
 *   and proceed. If still missing, skip with a warning and hand off to `probeDeadSession` — without
 *   a session token we'd authenticate as whoever the cookie points at and attribute their data to
 *   the wrong cursor (the failure mode `assertActiveSessionMatches` catches downstream).
 *
 * A 401 from the flush/pull themselves (the pivoted session cookie itself has expired — distinct
 * from the "no multi-session entry" case above, which is caught before any request is made) takes
 * the same `probeDeadSession` path: a forced tombstone probe, because a deleted account's session
 * vanishes / 401s exactly like an expired one and only the probe can tell them apart. Deleted →
 * reported as `'deleted'` for the caller to evaporate once the active session is restored; otherwise
 * flag this user for reauth and skip, so a stale cookie for one account doesn't abort the whole loop
 * or spin retrying against a dead session.
 */
async function syncOneUser(
    db: IDBPDatabase<MyDB>,
    userId: string,
    sessions: Map<string, DeviceSession>,
    options: SyncAllLoggedInUsersOptions,
    totalUsers: number,
): Promise<'synced' | 'skipped' | 'deleted'> {
    const session = sessions.get(userId) ?? (totalUsers > 1 ? await refreshSessionForUser(userId) : undefined);
    if (session) {
        await authClient.multiSession.setActive({ sessionToken: session.sessionToken });
        await setActiveAccount(userId, db);
    } else if (totalUsers > 1) {
        console.warn(`[multi-sync] no multi-session entry for ${userId} on a multi-user device — skipping pass to avoid cross-user data corruption`);
        // A deleted account's session disappears from the device list too — probe before telling
        // the user to re-login to an account that no longer exists.
        return probeDeadSession(userId);
    } else {
        // Single-user case: no pivot needed, but make sure IDB active matches so the downstream
        // session-match guard passes (it reads IDB's activeAccount).
        await setActiveAccount(userId, db);
    }
    // Snapshot BEFORE the pass: a success may only clear a reauth flag that predates it. A flag
    // raised mid-pass (SW relay, a concurrent failing path) reports a new failure and must survive.
    const wasFlaggedBeforePass = isAccountFlaggedForReauth(userId);
    try {
        // Probe-before-flush: a reaped device (server dropped its deviceSyncState row) with queued
        // offline ops must NOT auto-flush — the recovery dialog's push-vs-discard choice would be
        // moot once the ops are already on the server. The probe is skipped when the queue is empty
        // (flush is a no-op there; a reap surfaces as the pull's 409 → Case 1 instead).
        const queuedOpCount = await countQueuedOpsForUser(db, userId);
        if (queuedOpCount > 0 && (await isDeviceUnregistered(db))) {
            console.warn(`[multi-sync] device unregistered server-side with ${queuedOpCount} queued ops for ${userId} — deferring to recovery dialog`);
            enterCase2Recovery(userId, queuedOpCount);
            return 'skipped';
        }
        await flushSyncQueue(db, { userIdFilter: userId });
        await pullOrBootstrap(db, userId);
        // Sync worked, so a pre-existing reauth flag for this user is stale (e.g. the re-login
        // happened in another tab and this tab missed the resolved broadcast) — clear it everywhere.
        if (wasFlaggedBeforePass) {
            clearAccountReauthAfterSuccessfulSync(userId);
        }
    } catch (err) {
        if (err instanceof SyncAuthError) {
            return probeDeadSession(userId);
        }
        if (err instanceof BootstrapRequiredError) {
            // Pull 409'd: this device was reaped and its cursor is worthless. We already hold the
            // session gate here, so the recovery routine uses the unguarded bootstrap internally.
            await recoverFromBootstrapRequiredUnderGate(db, userId);
            return 'skipped';
        }
        throw err;
    }
    if (options.onUserSynced) {
        await options.onUserSynced(userId);
    }
    return 'synced';
}

/**
 * The session for `userId` is unusable (401 mid-pass, or missing from the device's session list):
 * forced tombstone probe. `'deleted'` is only REPORTED here — the evaporation runs once the caller
 * has restored the user's real active session (see syncAllLoggedInUsers). Anything else flags the
 * account for reauth.
 */
async function probeDeadSession(userId: string): Promise<'skipped' | 'deleted'> {
    const status = await probeUserStatus(userId, true);
    if (status === 'deleted') {
        console.warn(`[multi-sync] account ${userId} has no usable session and is tombstoned`);
        return 'deleted';
    }
    console.warn(`[multi-sync] session for ${userId} is unusable — flagging for reauth`);
    dispatchAccountNeedsReauth(userId);
    return 'skipped';
}

/**
 * Gated entry for callers outside the orchestrator that hit a 401 for `userId` (the same-account
 * flush in `dispatchOpFlush`). No pivot happened, so a deletion can be evaporated right here. An
 * account already flagged for reauth is left alone: `dispatchOpFlush` runs once per queued op, and
 * re-probing on every op would burn the Cloudflare request cap — the orchestrator's next pre-loop
 * probe (throttled) still catches a deletion that happens after the flag.
 */
export function handleDeadSessionGated(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    return withSessionGate(async () => {
        if (isAccountFlaggedForReauth(userId)) {
            return;
        }
        if ((await probeDeadSession(userId)) === 'deleted') {
            await evaporateUserAndRecover(db, userId);
        }
    });
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
