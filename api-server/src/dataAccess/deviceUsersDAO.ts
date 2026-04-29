import dayjs from 'dayjs';
import type { MongoClient } from 'mongodb';
import type { DeviceUserInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

function compositeId(deviceId: string, userId: string) {
    return `${deviceId}:${userId}`;
}

class DeviceUsersDAO extends AbstractDAO<DeviceUserInterface> {
    override COLLECTION_NAME = 'deviceUsers';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { deviceId: 1 } }, // list every account hosted on a device
            { key: { userId: 1 } }, // list every device that hosts a given account
        ]);
    }

    /**
     * Insert the (deviceId, userId) row if missing; otherwise just bump `lastSeenTs`.
     * Called fire-and-forget from the auth middleware on every authenticated request,
     * so it must be cheap and safe to retry.
     */
    async upsert(deviceId: string, userId: string): Promise<void> {
        const now = dayjs().toISOString();
        await this._collection.updateOne(
            { _id: compositeId(deviceId, userId) } as never,
            {
                $set: { deviceId, userId, lastSeenTs: now },
                $setOnInsert: { createdTs: now },
            },
            { upsert: true },
        );
    }

    async remove(deviceId: string, userId: string): Promise<void> {
        await this._collection.deleteOne({ _id: compositeId(deviceId, userId) } as never);
    }

    /** Remove every row for a device — used when a push subscription is gone (404/410). */
    async removeAllForDevice(deviceId: string): Promise<void> {
        await this._collection.deleteMany({ deviceId } as never);
    }

    async findUsersByDevice(deviceId: string) {
        return this.findArray({ deviceId });
    }

    async findDevicesByUser(userId: string) {
        return this.findArray({ userId });
    }
}

export default new DeviceUsersDAO();
