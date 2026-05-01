import type { IDBPDatabase } from 'idb';
import type { MyDB } from '../types/MyDB';
import { getActiveAccount } from './accountHelpers';
import { syncSingleUser } from './multiUserSync';
import { flushSyncQueue } from './syncHelpers';

/**
 * Dispatches the immediate flush triggered by `queueSyncOp` to the right code path:
 *
 * - Same account as the active Better Auth session → lightweight `flushSyncQueue` with a userIdFilter.
 * - Different account (or no active account at all) → `syncSingleUser`, which acquires the session
 *   gate, pivots the cookie via `multiSession.setActive`, flushes scoped to that user, and
 *   restores the previously-active session afterwards.
 *
 * Without that pivot on the cross-account branch the server's misroute guard
 * (`api-server/src/routes/sync.ts` ≈196) rejects the push with a 400 because session.user.id
 * wouldn't match the snapshot's userId.
 *
 * Note: the active-account read is a TOCTOU. If the user swaps accounts between the read and the
 * same-account flush firing its request, the request runs under the new active session — same
 * misroute-guard failure mode this dispatch is meant to prevent. The window is sub-millisecond
 * and an account swap during that window is rare; if it ever surfaces in practice the safer
 * (slower) fix is to route every dispatch through `syncSingleUser` regardless.
 */
export async function dispatchOpFlush(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    const active = await getActiveAccount(db);
    const sameAccount = active?.id === userId;
    return sameAccount ? flushSyncQueue(db, { userIdFilter: userId }) : syncSingleUser(db, userId);
}
