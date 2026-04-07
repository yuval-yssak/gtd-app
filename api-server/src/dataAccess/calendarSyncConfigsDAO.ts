import dayjs from 'dayjs';
import type { MongoClient } from 'mongodb';
import type { CalendarSyncConfigInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class CalendarSyncConfigsDAO extends AbstractDAO<CalendarSyncConfigInterface> {
    override COLLECTION_NAME = 'calendarSyncConfigs';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } },
            // One sync config per calendar per integration — prevents duplicate watches.
            { key: { integrationId: 1, calendarId: 1 }, unique: true },
            // Fast lookup when a Google webhook fires — keyed by the channel UUID we generate.
            { key: { webhookChannelId: 1 } },
        ]);
    }

    async findByIntegration(integrationId: string): Promise<CalendarSyncConfigInterface[]> {
        return this.findArray({ integrationId });
    }

    async findEnabledByIntegration(integrationId: string): Promise<CalendarSyncConfigInterface[]> {
        return this.findArray({ integrationId, enabled: true });
    }

    async findByUser(userId: string): Promise<CalendarSyncConfigInterface[]> {
        return this.findArray({ user: userId });
    }

    async findByWebhookChannelId(channelId: string): Promise<CalendarSyncConfigInterface | null> {
        return this.findOne({ webhookChannelId: channelId });
    }

    /** Sets one config as default and unsets all others for the same integration. */
    async setDefault(configId: string, integrationId: string): Promise<void> {
        const now = dayjs().toISOString();
        // Clear isDefault on all sibling configs first, then set the target.
        await this.updateMany({ integrationId, _id: { $ne: configId } as never }, { $set: { isDefault: false, updatedTs: now } });
        await this.updateOne({ _id: configId } as never, { $set: { isDefault: true, updatedTs: now } });
    }

    async upsertSyncToken(configId: string, syncToken: string, lastSyncedTs: string): Promise<void> {
        await this.updateOne({ _id: configId } as never, { $set: { syncToken, lastSyncedTs, updatedTs: dayjs().toISOString() } });
    }

    async upsertWebhookFields(configId: string, channelId: string, resourceId: string, expiry: string): Promise<void> {
        await this.updateOne({ _id: configId } as never, {
            $set: { webhookChannelId: channelId, webhookResourceId: resourceId, webhookExpiry: expiry, updatedTs: dayjs().toISOString() },
        });
    }

    async clearWebhookFields(configId: string): Promise<void> {
        await this.updateOne({ _id: configId } as never, {
            $unset: { webhookChannelId: '', webhookResourceId: '', webhookExpiry: '' },
            $set: { updatedTs: dayjs().toISOString() },
        });
    }

    /** Deletes all sync configs belonging to an integration (cascade on integration delete). */
    async deleteByIntegration(integrationId: string): Promise<void> {
        await this._collection.deleteMany({ integrationId } as never);
    }

    /** Finds all configs whose webhook channel expires within the given horizon. */
    async findExpiringSoon(horizon: string): Promise<CalendarSyncConfigInterface[]> {
        return this.findArray({ enabled: true, webhookExpiry: { $lt: horizon, $exists: true } });
    }

    /** Finds enabled configs that need a webhook channel — either missing or expiring within the horizon. */
    async findNeedingWebhook(horizon: string): Promise<CalendarSyncConfigInterface[]> {
        return this.findArray({
            enabled: true,
            $or: [{ webhookExpiry: { $exists: false } }, { webhookExpiry: { $lt: horizon } }],
        });
    }
}

export default new CalendarSyncConfigsDAO();
