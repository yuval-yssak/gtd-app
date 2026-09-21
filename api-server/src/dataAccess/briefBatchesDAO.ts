import type { MongoClient } from 'mongodb';
import type { BriefBatchInterface, BriefBatchResultCounts, BriefBatchStatus } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class BriefBatchesDAO extends AbstractDAO<BriefBatchInterface> {
    override COLLECTION_NAME = 'briefBatches';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        // The sweep's only query is "which batches are still processing". Terminal rows are kept as
        // an operator audit trail but bounded by a TTL on the BSON-Date `expiresAt` — at a 15-minute
        // cadence they would otherwise grow without limit on a 512 MB M0 cluster.
        await this._collection.createIndexes([{ key: { status: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }]);
    }

    findProcessing(): Promise<BriefBatchInterface[]> {
        return this.findArray({ status: 'processing' });
    }

    async markHarvested(batchId: string, harvestedTs: string, resultCounts: BriefBatchResultCounts): Promise<void> {
        await this.updateOne({ _id: batchId }, { $set: { status: 'harvested', harvestedTs, resultCounts } });
    }

    /** Terminal states with nothing to tally: `expired` (never ended in time) or `failed` (Anthropic no longer knows it). */
    async markTerminal(batchId: string, status: Extract<BriefBatchStatus, 'expired' | 'failed'>): Promise<void> {
        await this.updateOne({ _id: batchId }, { $set: { status } });
    }
}

export default new BriefBatchesDAO();
