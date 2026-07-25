import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';

/**
 * Reaps this user's stale (device, user) sync rows — both lastSeenTs AND lastSyncedTs older than
 * cutoffTs — plus the associated cleanup, so the pull-time reaper (routes/sync.ts) and the
 * on-demand maintenance purge (routes/maintenance.ts) can never drift apart:
 *
 * - The deviceUsers join row for each reaped (device, user) pair goes too: the pair no longer
 *   syncs, so push fan-out must stop targeting it. If the device is in fact still making
 *   authenticated requests, the auth middleware upserts the row right back — self-healing.
 * - The push subscription goes only for fully drained devices (no account has a sync row left);
 *   a multi-account device keeps receiving pushes for its surviving accounts.
 *
 * The user-initiated DELETE /devices/:deviceId performs the same cleanup for a single explicit row.
 */
export async function reapStaleDevices(userId: string, cutoffTs: string): Promise<{ removedDeviceIds: string[]; fullyDrainedDeviceIds: string[] }> {
    const { removedDeviceIds, fullyDrainedDeviceIds } = await deviceSyncStateDAO.deleteStaleDevices(userId, cutoffTs);
    await Promise.all(removedDeviceIds.map((deviceId) => deviceUsersDAO.remove(deviceId, userId)));
    await pushSubscriptionsDAO.deleteByDeviceIds(fullyDrainedDeviceIds, userId);
    return { removedDeviceIds, fullyDrainedDeviceIds };
}
