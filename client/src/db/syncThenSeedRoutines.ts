import type { IDBPDatabase } from 'idb';
import type { MyDB } from '../types/MyDB';
import { syncAllLoggedInUsers } from './multiUserSync';
import { materializePendingNextActionRoutines } from './routineItemHelpers';

/**
 * Syncs every logged-in account, then materializes the active account's due nextAction routines —
 * only when that account's own pass synced. A skipped pass (expired session, reaped device) leaves
 * IDB stale, and seeding off a view that lacks the routine's open item mints a duplicate occurrence.
 */
export async function syncThenSeedRoutines(db: IDBPDatabase<MyDB>, activeUserId: string, onUserSynced?: (userId: string) => Promise<void>) {
    const syncedUserIds = new Set<string>();
    const result = await syncAllLoggedInUsers(db, {
        onUserSynced: async (userId) => {
            syncedUserIds.add(userId);
            await onUserSynced?.(userId);
        },
    });
    if (!result.navigated && syncedUserIds.has(activeUserId)) {
        await materializePendingNextActionRoutines(db, activeUserId);
    }
    return result;
}
