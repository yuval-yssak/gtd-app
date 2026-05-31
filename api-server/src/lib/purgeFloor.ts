import type { DeviceSyncStateInterface } from '../types/entities.js';

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
