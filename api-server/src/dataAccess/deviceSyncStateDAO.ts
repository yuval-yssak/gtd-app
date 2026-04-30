import type { MongoClient } from 'mongodb';
import type { DeviceSyncStateInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class DeviceSyncStateDAO extends AbstractDAO<DeviceSyncStateInterface> {
    override COLLECTION_NAME = 'deviceSyncState';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } }, // list all (device, user) rows for a user — purge logic (min lastSyncedTs)
            { key: { deviceId: 1 } }, // device-scoped queries — push-subscription pruning, listing a device's accounts
        ]);
    }

    async upsert(state: DeviceSyncStateInterface): Promise<void> {
        await this._collection.replaceOne({ _id: state._id }, state, { upsert: true });
    }

    /**
     * Deletes (device, user) rows where both lastSeenTs and lastSyncedTs are older than cutoffTs.
     * Returns the deviceIds of any device whose *last* row was just removed — those devices have
     * no active sessions left, so the caller can drop their push subscriptions too. Devices that
     * still have at least one active (device, user) row are NOT returned (a multi-account device
     * shouldn't lose push delivery just because one of its accounts went stale).
     *
     * Race acceptance: between the deleteMany and the per-deviceId countDocuments below, another
     * pull from a different user on the same device may upsert a fresh row. We may then mis-report
     * the device as fully drained and the caller may drop the push subscription. This is benign:
     * the client re-registers its push subscription on every authenticated mount (see
     * `client/src/db/pushSubscription.ts`), so the worst case is one missed push notification before
     * the next foreground sync.
     */
    async deleteStaleDevices(userId: string, cutoffTs: string): Promise<string[]> {
        const stale = await this._collection.find({ user: userId, lastSeenTs: { $lt: cutoffTs }, lastSyncedTs: { $lt: cutoffTs } } as never).toArray();

        if (!stale.length) {
            return [];
        }

        await this._collection.deleteMany({ _id: { $in: stale.map((d) => d._id) } } as never);

        // Only return deviceIds whose *every* (device, user) row was wiped — i.e. no other user on
        // this device is still active. Otherwise the push subscription is still in use.
        const fullyDrainedDeviceIds: string[] = [];
        for (const deviceId of new Set(stale.map((d) => d.deviceId))) {
            const remaining = await this._collection.countDocuments({ deviceId } as never);
            if (remaining === 0) {
                fullyDrainedDeviceIds.push(deviceId);
            }
        }
        return fullyDrainedDeviceIds;
    }
}

export default new DeviceSyncStateDAO();
