import type { DeviceSyncStateInterface } from '../types/entities.js';

/**
 * Days without any activity (BOTH `lastSeenTs` and `lastSyncedTs` older than the cutoff) before a
 * device's `deviceSyncState` row is reaped, releasing its vote on the purge floor. Shared by the
 * pull-time reaper (routes/sync.ts) and the maintenance purge default (routes/maintenance.ts) so
 * the two paths can never drift apart.
 *
 * 30 days is only safe together with the `bootstrapRequired` 409 signal on /sync/pull: reaping a
 * row lets ops the device never pulled be purged, so a reaped-then-returning device would silently
 * skip that gap and believe it is fully synced. The 409 forces it into a full bootstrap instead.
 * Lowering this constant without that signal widens a silent data-loss window.
 */
export const STALE_DEVICE_DAYS = 30;

/**
 * The compound `(ts, _id)` purge floor: the exact position the slowest device has provably received.
 */
export interface PurgeFloor {
    ts: string;
    id: string;
}

/**
 * Computes the compound purge floor across a user's `deviceSyncState` rows — the lexicographic min of
 * the COMPOUND pair `(lastSyncedTs, lastSyncedId)`, NOT independent mins of each. Independent mins
 * could fabricate a `(ts, id)` no device actually reached, deleting ops a device still needs.
 * Legacy rows lacking `lastSyncedId` read as `''` (lowest id), so that device's boundary ms is never
 * purged until it next pulls and writes a real id.
 *
 * Returns `null` when the user has no device rows — callers must treat that as "nothing to purge"
 * (purging against a fabricated floor would delete in-flight ops).
 */
export function computePurgeFloor(deviceStates: DeviceSyncStateInterface[]): PurgeFloor | null {
    if (!deviceStates.length) {
        return null;
    }
    // reduce without a seed uses the first element; safe since we guard length above.
    const slowest = deviceStates.reduce((min, d) => {
        if (d.lastSyncedTs !== min.lastSyncedTs) {
            return d.lastSyncedTs < min.lastSyncedTs ? d : min;
        }
        return (d.lastSyncedId ?? '') < (min.lastSyncedId ?? '') ? d : min;
    });
    return { ts: slowest.lastSyncedTs, id: slowest.lastSyncedId ?? '' };
}
