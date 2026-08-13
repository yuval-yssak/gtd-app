import type { IDBPDatabase } from 'idb';
import { API_SERVER } from '../constants/globals';
import type { MyDB } from '../types/MyDB';
import { getActiveAccount } from './accountHelpers';
import { flushSyncQueue, pullFromServer } from './syncHelpers';

/**
 * Resolves whom the ambient cookie session authenticates as, straight from the server. The
 * Service Worker cannot run the Better Auth client (React-only) and must NOT trust IDB's
 * `activeAccount` for request attribution: the local-first account switch writes ONLY IDB, so
 * until a foreground tab runs `reconcileActiveSessionCookie` the cookie can point at a different
 * account than IDB does. Any SW-driven sync scoped by IDB in that window would be attributed to
 * the wrong user. Returns null when offline / unauthenticated — callers defer to the next
 * foreground pass.
 */
export async function fetchSessionUserId(): Promise<string | null> {
    try {
        const res = await fetch(`${API_SERVER}/auth/get-session`, { credentials: 'include' });
        if (!res.ok) {
            return null;
        }
        const body = (await res.json()) as { user?: { id?: string } } | null;
        return body?.user?.id ?? null;
    } catch {
        return null;
    }
}

type ResolveSessionUserId = () => Promise<string | null>;

/**
 * Background-context flush, correct by construction under cookie/IDB drift: scopes the push to
 * the user the cookie actually authenticates as, so `/sync/push` can never attribute another
 * account's queued ops (including guard-exempt `snapshot: null` deletes) to the session user.
 * Returns the session userId that was flushed, or null when no usable session was reachable.
 */
export async function flushQueueForSessionUser(
    db: IDBPDatabase<MyDB>,
    resolveSessionUserId: ResolveSessionUserId = fetchSessionUserId,
): Promise<string | null> {
    const sessionUserId = await resolveSessionUserId();
    if (!sessionUserId) {
        return null;
    }
    await flushSyncQueue(db, { userIdFilter: sessionUserId });
    return sessionUserId;
}

export type BackgroundPullOutcome = 'pulled' | 'skipped_no_session' | 'skipped_drift';

/**
 * Background-context pull. Pulls only when the cookie session and IDB's `activeAccount` agree —
 * a drift window (offline switch not yet reconciled) means the server would answer with the
 * cookie-user's ops while the cursor write would land under IDB's user, corrupting the cursor.
 * Skipping is safe: the next foreground boot reconciles the cookie and syncs every account.
 */
export async function pullForSessionUser(
    db: IDBPDatabase<MyDB>,
    resolveSessionUserId: ResolveSessionUserId = fetchSessionUserId,
): Promise<BackgroundPullOutcome> {
    const sessionUserId = await resolveSessionUserId();
    if (!sessionUserId) {
        return 'skipped_no_session';
    }
    const active = await getActiveAccount(db);
    if (!active || active.id !== sessionUserId) {
        console.warn(
            `[background-sync] cookie session (${sessionUserId}) and IDB active account (${active?.id ?? 'none'}) diverge — skipping pull until reconcile`,
        );
        return 'skipped_drift';
    }
    await pullFromServer(db, sessionUserId);
    return 'pulled';
}
