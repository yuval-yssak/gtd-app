import type { IDBPDatabase } from 'idb';
import { authClient } from '../lib/authClient';
import type { MyDB } from '../types/MyDB';
import { getActiveAccount, getLoggedInUserIds, setActiveAccount } from './accountHelpers';
import { bootstrapFromServer, flushSyncQueue, pullFromServer } from './syncHelpers';

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
    const userIds = await getLoggedInUserIds(db);
    if (!userIds.length) {
        return;
    }
    const sessions = await loadDeviceSessionsByUserId();
    const previouslyActive = await getActiveAccount(db);
    const previouslyActiveSession = previouslyActive ? sessions.get(previouslyActive.id) : undefined;
    try {
        for (const userId of userIds) {
            await syncOneUser(db, userId, sessions, options);
        }
    } finally {
        await restorePreviouslyActiveSession(db, previouslyActive?.id, previouslyActiveSession);
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
 * this user, then runs flush + pull + the caller-supplied per-user hook. The pivot is skipped
 * when no entry exists — single-account flows (and the dev-login bypass used by e2e tests) only
 * carry the primary `better-auth.session_token` cookie, so `listDeviceSessions()` returns empty
 * and no swap is needed: the existing active session already belongs to this user.
 */
async function syncOneUser(db: IDBPDatabase<MyDB>, userId: string, sessions: Map<string, DeviceSession>, options: SyncAllLoggedInUsersOptions): Promise<void> {
    const session = sessions.get(userId);
    if (session) {
        await authClient.multiSession.setActive({ sessionToken: session.sessionToken });
        await setActiveAccount(userId, db);
    }
    await flushSyncQueue(db, { userIdFilter: userId });
    await pullOrBootstrap(db);
    if (options.onUserSynced) {
        await options.onUserSynced(userId);
    }
}

/** Bootstraps when the device has never synced (no per-device cursor); otherwise does an incremental pull. */
async function pullOrBootstrap(db: IDBPDatabase<MyDB>): Promise<void> {
    const syncState = await db.get('deviceSyncState', 'local');
    if (!syncState) {
        await bootstrapFromServer(db);
        return;
    }
    await pullFromServer(db);
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
