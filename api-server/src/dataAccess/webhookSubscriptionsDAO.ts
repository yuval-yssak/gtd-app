import type { MongoClient } from 'mongodb';
import type { WebhookEvent, WebhookSubscriptionInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class WebhookSubscriptionsDAO extends AbstractDAO<WebhookSubscriptionInterface> {
    override COLLECTION_NAME = 'webhookSubscriptions';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            // Enumerate the user's subscriptions in the settings UI and the fan-out path.
            { key: { user: 1 } },
            // Filter by event when fanning out a public-API mutation. Multikey index on the events array.
            { key: { user: 1, events: 1 } },
        ]);
    }

    /** Returns all of the user's subscriptions, including disabled ones — the UI shows them dimmed. */
    async listForUser(userId: string): Promise<WebhookSubscriptionInterface[]> {
        return this._collection.find({ user: userId }).sort({ createdTs: -1 }).toArray();
    }

    /** Returns the active (non-disabled) subscriptions matching `event` for fan-out. */
    async listActiveForEvent(userId: string, event: WebhookEvent): Promise<WebhookSubscriptionInterface[]> {
        return this._collection.find({ user: userId, events: event, disabledTs: { $exists: false } }).toArray();
    }

    /** Counts active subscriptions for the per-user cap check. */
    async countActiveForUser(userId: string): Promise<number> {
        return this._collection.countDocuments({ user: userId, disabledTs: { $exists: false } });
    }

    /** Sets `lastDeliveredTs` and resets `failureCount` to zero — called after a 2xx delivery. */
    async recordSuccess(subscriptionId: string, now: string): Promise<void> {
        await this._collection.updateOne({ _id: subscriptionId }, { $set: { lastDeliveredTs: now, failureCount: 0 } });
    }

    /**
     * Increments `failureCount`. Auto-disables the subscription if it reaches `maxFailures`.
     * Returns the post-update failure count so the worker can emit the final-failure log line.
     */
    async recordFailure(subscriptionId: string, maxFailures: number, now: string): Promise<number> {
        const updated = await this._collection.findOneAndUpdate({ _id: subscriptionId }, { $inc: { failureCount: 1 } }, { returnDocument: 'after' });
        const count = updated?.failureCount ?? 0;
        if (count >= maxFailures && !updated?.disabledTs) {
            await this._collection.updateOne({ _id: subscriptionId }, { $set: { disabledTs: now, disabledReason: 'consecutive_failures' } });
        }
        return count;
    }
}

export default new WebhookSubscriptionsDAO();
