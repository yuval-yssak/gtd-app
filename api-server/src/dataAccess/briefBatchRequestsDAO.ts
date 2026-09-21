import type { MongoClient } from 'mongodb';
import type { BriefBatchRequestInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class BriefBatchRequestsDAO extends AbstractDAO<BriefBatchRequestInterface> {
    override COLLECTION_NAME = 'briefBatchRequests';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        // Harvest loads one batch's rows in a single query; the dev reset deletes by user. The TTL
        // is a backstop: a crash between the request-row insert and the batch-row insert (or between
        // markHarvested and deleteByBatch) strands rows no `processing` enumeration can reach.
        // `expiresAt` is a BSON Date on purpose — a TTL index on an ISO-string field never fires.
        await this._collection.createIndexes([{ key: { batchId: 1 } }, { key: { user: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }]);
    }

    /** One batch's request identities keyed by `custom_id`, so out-of-order results resolve in O(1). */
    async findByBatch(batchId: string): Promise<Map<string, BriefBatchRequestInterface>> {
        const rows = await this.findArray({ batchId });
        return new Map(rows.map((row) => [row._id, row]));
    }

    async deleteByBatch(batchId: string): Promise<void> {
        await this._collection.deleteMany({ batchId });
    }
}

export default new BriefBatchRequestsDAO();
