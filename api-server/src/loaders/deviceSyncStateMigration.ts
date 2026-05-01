import type { Db } from 'mongodb';

/**
 * Pre-migration shape: a single cursor per device, no `deviceId` field, plain `_id = deviceId`.
 * Declared locally so dot-notation access satisfies `noPropertyAccessFromIndexSignature` without
 * a top-level type for a transient one-shot migration.
 */
interface LegacyDeviceSyncStateDoc {
    _id: string;
    user?: string;
    lastSyncedTs: string;
    lastSeenTs: string;
    name?: string;
}

/**
 * Migrates deviceSyncState rows from the old single-cursor-per-device shape
 * (`_id = deviceId`, single `user` field) to the per-(device, user) cursor shape
 * (`_id = '${deviceId}::${userId}'`, plus a queryable `deviceId` field).
 *
 * Why: a single shared cursor lets one Better Auth session advance past another
 * session's boundary op on the same device — see the cross-account move bug
 * where the moved item never landed in the target session's IndexedDB.
 *
 * Idempotent — re-running is a no-op (rows whose `_id` already contains '::' are skipped).
 *
 * Concurrent-deploy safe: uses `$setOnInsert` for all migrated fields so a fresher row written by
 * a live `/sync/push` or `/sync/pull` (in a blue/green deploy where the previous instance is still
 * serving traffic) is never overwritten. Two migration instances racing converge to the same final
 * state — the first to insert wins, the second is a no-op.
 *
 * Per-user attribution caveat: the legacy doc's `lastSyncedTs` reflects the most recent writer's
 * pull (push/pull both stamp `user` and `lastSyncedTs`). The migration carries the value forward
 * for the user named in `oldDoc.user` — correct for that user. Other users that shared this device
 * have no row post-migration; their first pull will create a fresh row at epoch, replaying every
 * op since they last synced. LWW makes the replay idempotent; it's a one-time bandwidth spike.
 */
export async function migrateDeviceSyncStateToPerUserCursor(db: Db): Promise<void> {
    const coll = db.collection<LegacyDeviceSyncStateDoc>('deviceSyncState');

    // Find old-shape docs: _id is a plain deviceId (no '::' separator).
    const oldDocs = await coll.find({ _id: { $not: /::/ } as never }).toArray();
    if (!oldDocs.length) {
        return;
    }

    console.log(`[migrate] deviceSyncState: converting ${oldDocs.length} legacy row(s) to per-(device, user) cursors`);

    for (const oldDoc of oldDocs) {
        const oldId = oldDoc._id;
        const userId = oldDoc.user;
        // Defensive: skip malformed rows. A row missing `user` has no migration target — leave it for cleanup later.
        if (!userId || !oldDoc.lastSyncedTs || !oldDoc.lastSeenTs) {
            continue;
        }

        const newId = `${oldId}::${userId}`;
        const setOnInsert: { deviceId: string; user: string; lastSyncedTs: string; lastSeenTs: string; name?: string } = {
            deviceId: oldId,
            user: userId,
            lastSyncedTs: oldDoc.lastSyncedTs,
            lastSeenTs: oldDoc.lastSeenTs,
        };
        if (oldDoc.name) {
            setOnInsert.name = oldDoc.name;
        }

        // $setOnInsert preserves any fresher row written by a concurrently-running app instance —
        // critical for blue/green deploys where the old instance is still serving live traffic.
        await coll.updateOne({ _id: newId } as never, { $setOnInsert: setOnInsert } as never, { upsert: true });
        await coll.deleteOne({ _id: oldId } as never);
    }
}
