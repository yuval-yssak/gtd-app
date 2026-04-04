import { redirect } from '@tanstack/router-core';
import type { IDBPDatabase } from 'idb';
import { getActiveAccount } from '../db/accountHelpers';
import { authClient } from '../lib/authClient';
import type { MyDB } from '../types/MyDB';

export async function authenticatedRouteGuard({ context }: { context: { db: IDBPDatabase<MyDB> } }) {
    const { db } = context;
    const activeAccount = await getActiveAccount(db);

    if (!activeAccount) {
        throw redirect({ to: '/login' });
    }

    // Allow through immediately — don't await the server check so slow/offline
    // networks never block the route. The background check handles the rare case
    // of a revoked session (e.g. account deleted server-side).
    verifySessionInBackground();
}

// Fire-and-forget: if the server confirms the session is gone, force re-login.
// Network errors are ignored — the user may be offline, which is a valid state.
function verifySessionInBackground() {
    fetchSessionSafely()
        .then(({ session, networkError }) => {
            if (!networkError && !session) {
                // Session revoked server-side; redirect outside TanStack Router since
                // we have no router reference here and a full reload is fine in this edge case.
                window.location.href = '/login';
            }
        })
        .catch((err) => console.error('[auth] background session check failed:', err));
}

// Wraps authClient.getSession() to distinguish a missing session from a network failure.
// Returns networkError=true when the fetch throws (offline/DNS), false when the server responded.
async function fetchSessionSafely() {
    try {
        const result = await authClient.getSession();
        return { session: result.data, networkError: false };
    } catch {
        return { session: null, networkError: true };
    }
}
