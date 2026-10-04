import type { IDBPDatabase } from 'idb';
import { broadcastAccountEvaporated, dispatchAccountEvaporated } from '../contexts/accountEvaporatedEvents';
import type { ReloadDestination } from '../contexts/accountEvaporatedRecovery';
import { announceAccountReauthResolved } from '../contexts/accountReauthEvents';
import { authClient } from '../lib/authClient';
import type { MyDB, StoredAccount } from '../types/MyDB';
import { getActiveAccount, getAllAccounts, removeAccount, setActiveAccount, wipeUserData } from './accountHelpers';
import { withSessionGate } from './syncHelpers';

export interface EvaporationResult {
    /** True when the evaporated account was this device's active account. */
    wasActive: boolean;
    /**
     * True when the device has no usable active account left after the wipe — either because the
     * evaporated account WAS the active one, or because another tab already removed the pointer
     * (two tabs receive the same SSE event; the second one must not stay stranded on an
     * authenticated route with no account).
     */
    needsRecovery: boolean;
    /** The account to pivot to when recovery is needed; undefined when none remain. */
    nextAccount: StoredAccount | undefined;
}

export interface RecoveryResult {
    wasActive: boolean;
    /** True when a full-page navigation was scheduled — the caller should stop doing work in this tab. */
    navigated: boolean;
}

/**
 * Removes every local trace of a user whose account was deleted server-side: entity rows, queued
 * sync operations (they have nowhere to land any more), the per-user sync cursor, drafts and the
 * `accounts` / `activeAccount` rows. Other accounts on the device and `deviceMeta` are untouched —
 * the deviceId must outlive any single account. Idempotent: an unknown user is a no-op.
 */
export async function evaporateUser(db: IDBPDatabase<MyDB>, userId: string): Promise<EvaporationResult> {
    const wasActive = (await getActiveAccount(db))?.id === userId;
    await wipeUserData(userId, db);
    await removeAccount(userId, db);
    // A deleted account can never sync again, so a "Sync is broken — re-login" dialog for it is
    // noise; clear it here and in every other tab.
    announceAccountReauthResolved(userId);
    const [remaining, activeAfter] = await Promise.all([getAllAccounts(db), getActiveAccount(db)]);
    return { wasActive, needsRecovery: wasActive || activeAfter === undefined, nextAccount: remaining[0] };
}

// Every production caller is already serialized by the session gate, so this map only covers the
// one overlap the gate allows: a gate-timeout release (syncHelpers' hard timeout) while an
// evaporation for the same user is still running. Sharing the in-flight promise then keeps the
// late caller from a second wipe + second navigation.
const inFlight = new Map<string, Promise<RecoveryResult>>();

/**
 * Evaporates the user and puts the device back into a coherent state. No usable active account
 * left → drop this device's push subscription (push is per active session, and the server row is
 * gone), then pivot to the next signed-in account or fall back to /login. Otherwise → announce the
 * evaporation so the provider refreshes its account list and SSE channels in place.
 *
 * Ungated: callers that already hold the session gate (`syncAllLoggedInUsers`) use this directly;
 * everyone else goes through `evaporateUserAndRecoverGated`.
 */
export function evaporateUserAndRecover(db: IDBPDatabase<MyDB>, userId: string): Promise<RecoveryResult> {
    const existing = inFlight.get(userId);
    if (existing) {
        return existing;
    }
    const run = evaporateAndRecoverOnce(db, userId).finally(() => inFlight.delete(userId));
    inFlight.set(userId, run);
    return run;
}

/**
 * Gated variant for callers outside the sync orchestrator (SSE handler, Settings dialog): the
 * pivot below writes the active-session cookie, which must not interleave with an in-flight
 * sync pass's own pivots.
 */
export function evaporateUserAndRecoverGated(db: IDBPDatabase<MyDB>, userId: string): Promise<RecoveryResult> {
    return withSessionGate(() => evaporateUserAndRecover(db, userId));
}

async function evaporateAndRecoverOnce(db: IDBPDatabase<MyDB>, userId: string): Promise<RecoveryResult> {
    const { wasActive, needsRecovery, nextAccount } = await evaporateUser(db, userId);
    if (!needsRecovery) {
        broadcastAccountEvaporated(userId);
        dispatchAccountEvaporated(userId);
        return { wasActive, navigated: false };
    }
    await unsubscribePushBestEffort();
    const destination = nextAccount ? await pivotSessionTo(db, nextAccount) : await clearDeadCookie();
    // Broadcast only AFTER the pivot is written: another tab rendering this account reloads the
    // moment it hears us, and must find the survivor already active (pointer + cookie) — a reload
    // that raced the pivot would boot onto the public landing page or /login despite a survivor.
    broadcastAccountEvaporated(userId);
    window.location.href = destination;
    return { wasActive, navigated: true };
}

/**
 * `navigator.serviceWorker.ready` never settles while no worker is active (first visit, SW blocked,
 * dev preview without a registered worker) — an unbounded await here would hold the recovery, and
 * the session gate with it, forever. Push cannot exist without notification permission either, so
 * the whole step is skipped unless permission was granted.
 */
const PUSH_UNSUBSCRIBE_TIMEOUT_MS = 2_000;
// `let` so a unit test can shrink the deadline instead of waiting 2 s for the never-settling case.
let pushUnsubscribeTimeoutMs = PUSH_UNSUBSCRIBE_TIMEOUT_MS;

/** Test-only: override (or reset, with no argument) the push-unsubscribe deadline. */
export function setPushUnsubscribeTimeoutMsForTests(ms: number = PUSH_UNSUBSCRIBE_TIMEOUT_MS): void {
    pushUnsubscribeTimeoutMs = ms;
}

// Only when the device loses its active account: the browser holds ONE push subscription per
// origin, registered under whichever account was active (see pushSubscription.ts), so unsubscribing
// when a background account is deleted would silence notifications for the account still signed in.
async function unsubscribePushBestEffort(): Promise<void> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
        return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
        return;
    }
    try {
        await withDeadline(unsubscribeCurrentPushSubscription(), pushUnsubscribeTimeoutMs);
    } catch (err) {
        console.warn('[evaporate] push unsubscribe failed or timed out', err);
    }
}

async function unsubscribeCurrentPushSubscription(): Promise<void> {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    await subscription?.unsubscribe();
}

function withDeadline<T>(task: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        task.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

/** Makes `next` the device's active account (IDB pointer + best-effort cookie) and returns where to reload. */
async function pivotSessionTo(db: IDBPDatabase<MyDB>, next: StoredAccount): Promise<ReloadDestination> {
    await setActiveAccount(next.id, db);
    // The deleted account's cookie session is already gone server-side; point the device cookie at
    // the survivor so the reload boots under a live session. Best-effort — if it fails, the boot
    // path's cookie reconcile re-aligns it (or surfaces the reauth dialog).
    try {
        const { data: sessions } = await authClient.multiSession.listDeviceSessions();
        const target = sessions?.find((s) => s.user.id === next.id);
        if (target) {
            await authClient.multiSession.setActive({ sessionToken: target.session.token });
        }
    } catch (err) {
        console.warn('[evaporate] could not pivot the session cookie to the next account', err);
    }
    return '/';
}

/** Nobody is left on the device: clear the dead cookie and send the tab to the sign-in page. */
async function clearDeadCookie(): Promise<ReloadDestination> {
    // The server already revoked the session; signOut just clears the dead cookie. Failing is fine.
    await authClient.signOut().catch(() => undefined);
    return '/login';
}
