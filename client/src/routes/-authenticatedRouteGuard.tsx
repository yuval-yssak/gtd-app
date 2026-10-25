import { redirect } from '@tanstack/router-core';
import type { IDBPDatabase } from 'idb';
import { getActiveAccount, hydrateAccountFromSession } from '../db/accountHelpers';
import { authClient } from '../lib/authClient';
import { hasAtLeastOne } from '../lib/typeUtils';
import type { MyDB } from '../types/MyDB';

export async function authenticatedRouteGuard({ context }: { context: { db: IDBPDatabase<MyDB> } }) {
    const { db } = context;
    const activeAccount = await getActiveAccount(db);

    if (activeAccount) {
        // Allow through immediately — don't await the server check so slow/offline
        // networks never block the route. The background check handles the rare case
        // of a revoked session (e.g. account deleted server-side).
        verifySessionInBackground();
        return;
    }

    // No local account. Before redirecting to /login, try to recover from a still-valid
    // server session — this happens after the user clears site data while the Better-Auth
    // httpOnly cookie remains. Without this branch, the login route's beforeLoad sees the
    // server session and redirects to '/', which sends us back here in an infinite loop.
    if (!(await recoverAccountFromServerSession(db))) {
        throw redirect({ to: '/login' });
    }
}

/**
 * Hydrates the local account store from a still-valid server session. Returns false when there
 * is no session or the server could not be reached — offline is a valid state, and the caller
 * decides whether that means "sign in" (the guard) or "show the public page" (the homepage).
 */
export async function recoverAccountFromServerSession(db: IDBPDatabase<MyDB>) {
    const { session, networkError } = await fetchSessionSafely();
    if (networkError || !session) {
        return false;
    }
    await hydrateAccountFromSession(db, session);
    return true;
}

// Fire-and-forget: if the server confirms there is no session left on this device, force re-login.
// Network errors are ignored — the user may be offline, which is a valid state.
function verifySessionInBackground() {
    confirmSignedOutEverywhere()
        .then((isSignedOut) => {
            if (isSignedOut) {
                // Redirect outside TanStack Router: we have no router reference here, and a full
                // reload is fine in this edge case.
                window.location.href = '/login';
            }
        })
        .catch((err) => console.error('[auth] background session check failed:', err));
}

/**
 * Whether the server confirms this device is signed out of every account. A dead cookie session
 * alone is not that: a sync pass can leave the cookie on a just-revoked account while another
 * account on the device is live — the boot cookie reconcile then re-aligns the cookie to IDB's
 * active account and the sync pass flags the dead one for re-login. Anything short of a clean
 * "no sessions" answer (offline, a 5xx, a rate limit) keeps the user in.
 */
export async function confirmSignedOutEverywhere() {
    const { session, networkError } = await fetchSessionSafely();
    if (session || networkError) {
        return false;
    }
    return !(await hasLiveDeviceSession());
}

/** Fails open: an unanswered or failed list counts as "still signed in somewhere". */
async function hasLiveDeviceSession() {
    try {
        // Better Auth resolves an HTTP error as `{ data: null, error }` rather than throwing.
        const { data, error } = await authClient.multiSession.listDeviceSessions();
        return Boolean(error) || !data || hasAtLeastOne(data);
    } catch {
        return true;
    }
}

/** A stalled ("lie-fi") connection must not blank the public homepage or /login for minutes. */
const SESSION_FETCH_TIMEOUT_MS = 8_000;

// Wraps authClient.getSession() to distinguish a missing session from a network failure.
// Returns networkError=true when the fetch throws or times out (offline/DNS/lie-fi), false when
// the server responded.
async function fetchSessionSafely() {
    try {
        const result = await authClient.getSession({ fetchOptions: { signal: AbortSignal.timeout(SESSION_FETCH_TIMEOUT_MS) } });
        return { session: result.data, networkError: false };
    } catch {
        return { session: null, networkError: true };
    }
}
