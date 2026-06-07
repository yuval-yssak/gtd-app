import dayjs from 'dayjs';
import type { MongoClient } from 'mongodb';
import { hasAtLeastOne } from '../lib/typeUtils.js';
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

    /**
     * Enforces the invariant that an integration with at least one enabled config always has exactly one default.
     * No-op when a default already exists or no enabled configs remain. Promotes the oldest enabled config otherwise,
     * so a deterministic survivor is chosen after the default is added/disabled/removed by another code path.
     */
    async ensureDefaultExists(integrationId: string): Promise<void> {
        const enabled = await this.findEnabledByIntegration(integrationId);
        if (!hasAtLeastOne(enabled) || enabled.some((config) => config.isDefault)) {
            return;
        }
        // Oldest enabled config wins; tie-break on _id so same-millisecond sequential adds resolve deterministically
        // (findEnabledByIntegration is unsorted, so without this the winner would depend on storage order).
        const oldest = enabled.reduce((earliest, config) => {
            const created = dayjs(config.createdTs);
            const earliestCreated = dayjs(earliest.createdTs);
            if (created.isBefore(earliestCreated)) return config;
            if (created.isSame(earliestCreated) && config._id < earliest._id) return config;
            return earliest;
        });
        await this.setDefault(oldest._id, integrationId);
    }

    async upsertSyncToken(configId: string, syncToken: string, lastSyncedTs: string): Promise<void> {
        await this.updateOne({ _id: configId } as never, { $set: { syncToken, lastSyncedTs, updatedTs: dayjs().toISOString() } });
    }

    async upsertTimeZone(configId: string, timeZone: string): Promise<void> {
        await this.updateOne({ _id: configId } as never, { $set: { timeZone, updatedTs: dayjs().toISOString() } });
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
