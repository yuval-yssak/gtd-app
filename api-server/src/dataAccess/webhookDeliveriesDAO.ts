import type { MongoClient } from 'mongodb';
import type { WebhookDeliveryInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class WebhookDeliveriesDAO extends AbstractDAO<WebhookDeliveryInterface> {
    override COLLECTION_NAME = 'webhookDeliveries';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            // Worker queue: pull pending deliveries whose nextAttemptTs has passed. Filter on
            // `claimed` is in-app rather than indexed (cardinality is too low to benefit).
            { key: { nextAttemptTs: 1, deliveredTs: 1 } },
            // Audit / debugging: list deliveries for a subscription.
            { key: { user: 1, subscriptionId: 1 } },
        ]);
    }

    /**
     * Atomically claims up to `limit` pending deliveries for a worker tick. Marks each row's
     * `claimed=true` so two workers running concurrently can't deliver the same row twice.
     * Returns the claimed rows in `nextAttemptTs` order.
     */
    async claimDueDeliveries(now: string, limit: number): Promise<WebhookDeliveryInterface[]> {
        const claimed: WebhookDeliveryInterface[] = [];
        for (let i = 0; i < limit; i++) {
            const row = await this._collection.findOneAndUpdate(
                {
                    deliveredTs: { $exists: false },
                    abandonedTs: { $exists: false },
                    nextAttemptTs: { $lte: now },
                    claimed: { $ne: true },
                },
                { $set: { claimed: true } },
                { sort: { nextAttemptTs: 1 }, returnDocument: 'after' },
            );
            if (!row) {
                break;
            }
            claimed.push(row);
        }
        return claimed;
    }

    /** Marks a delivery as successfully delivered. Caller is responsible for updating the parent subscription too. */
    async markDelivered(deliveryId: string, now: string): Promise<void> {
        await this._collection.updateOne({ _id: deliveryId }, { $set: { deliveredTs: now }, $unset: { claimed: '' } });
    }

    /**
     * Pushes the next attempt out by `retryDelayMs` and records the error. Releases the claim
     * so the next worker tick can pick it up. If `maxAttempts` has been reached, the row is
     * marked abandoned instead.
     */
    async recordRetry(
        deliveryId: string,
        attempts: number,
        maxAttempts: number,
        retryDelayMs: number,
        now: Date,
        errorMsg: string,
    ): Promise<{ abandoned: boolean }> {
        if (attempts >= maxAttempts) {
            await this._collection.updateOne(
                { _id: deliveryId },
                { $set: { abandonedTs: now.toISOString(), lastError: errorMsg, attempts }, $unset: { claimed: '' } },
            );
            return { abandoned: true };
        }
        const next = new Date(now.getTime() + retryDelayMs).toISOString();
        await this._collection.updateOne({ _id: deliveryId }, { $set: { nextAttemptTs: next, lastError: errorMsg, attempts }, $unset: { claimed: '' } });
        return { abandoned: false };
    }
}

export default new WebhookDeliveriesDAO();
