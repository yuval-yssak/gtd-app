import type { MongoClient } from 'mongodb';
import type { PushSubscriptionRecord } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class PushSubscriptionsDAO extends AbstractDAO<PushSubscriptionRecord> {
    override COLLECTION_NAME = 'pushSubscriptions';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } }, // look up all subscriptions for a user when broadcasting a push
        ]);
    }

    async upsert(record: PushSubscriptionRecord): Promise<void> {
        // Keyed by deviceId so re-subscribing (e.g. after token expiry) replaces the old record
        await this._collection.replaceOne({ _id: record._id }, record, { upsert: true });
    }

    async deleteByDevice(deviceId: string, userId: string): Promise<void> {
        await this._collection.deleteOne({ _id: deviceId, user: userId } as never);
    }
}

export default new PushSubscriptionsDAO();
