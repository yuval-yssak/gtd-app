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
}

export default new DeviceSyncStateDAO();
