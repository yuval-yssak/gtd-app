import type { MongoClient } from 'mongodb';
import type { DeviceSyncStateInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class DeviceSyncStateDAO extends AbstractDAO<DeviceSyncStateInterface> {
    override COLLECTION_NAME = 'deviceSyncState';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } }, // list all devices for a user — needed by purge logic (min lastSyncedTs)
        ]);
    }

    async upsert(state: DeviceSyncStateInterface): Promise<void> {
        await this._collection.replaceOne({ _id: state._id }, state, { upsert: true });
    }

    /** Delete devices where both lastSeenTs and lastSyncedTs are older than cutoffTs. Returns deleted device IDs. */
    async deleteStaleDevices(userId: string, cutoffTs: string): Promise<string[]> {
        const staleDevices = await this._collection.find({ user: userId, lastSeenTs: { $lt: cutoffTs }, lastSyncedTs: { $lt: cutoffTs } } as never).toArray();

        if (!staleDevices.length) {
            return [];
        }

        const staleIds = staleDevices.map((d) => d._id);
        await this._collection.deleteMany({ _id: { $in: staleIds } } as never);
        return staleIds;
    }
}

export default new DeviceSyncStateDAO();
