import type { MongoClient } from 'mongodb';
import type { OperationInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class OperationsDAO extends AbstractDAO<OperationInterface> {
    override COLLECTION_NAME = 'operations';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            // Compound (ts, _id) so incremental pull paginates on the totally-ordered pair, not a
            // bare millisecond — a same-`ts` batch can't be split across two pulls and lose ops.
            { key: { user: 1, ts: 1, _id: 1 } },
            // Kept (now a strict prefix of the compound index): dropping costs more operational risk
            // than the redundant index saves on this low-throughput workload.
            { key: { user: 1, ts: 1 } }, // incremental pull: all ops for user since a given ts
            { key: { user: 1, entityType: 1, entityId: 1, ts: 1 } }, // entity history lookup
        ]);
    }

    /**
     * Incremental-pull query on the compound cursor `(since, sinceId)`: returns ops strictly greater
     * than that pair under `(ts, _id)` ordering. MongoDB has no native tuple `$gt`, so we express it
     * as an `$or` of "newer ms" plus "same ms, higher id". The same-ms clause MUST be `$gt` (not
     * `$gte`) — `$gte` would re-emit the cursor op every pull, an endless re-delivery loop.
     * A missing/empty `sinceId` ('' sorts below every id) degrades to `$gte since` semantics, which
     * re-checks the whole boundary ms — safe (applies are idempotent) and strictly better than the
     * old `$gt ts` that skipped it.
     */
    async findOpsAfter(userId: string, since: string, sinceId: string): Promise<OperationInterface[]> {
        return await this.findArray(
            { user: userId, $or: [{ ts: { $gt: since } }, { ts: since, _id: { $gt: sinceId } } as never] },
            { sort: { ts: 1, _id: 1 } },
        );
    }

    async deleteOlderThan(userId: string, minTs: string, minId: string): Promise<void> {
        // Delete only ops at-or-below the compound floor `(minTs, minId)` — the exact position the
        // slowest device has provably received. The same-ms clause MUST be `_id: { $lte: minId }`,
        // NOT `ts: { $lte: minTs }`: a bare `$lte ts` would delete same-ms ops *past* the slowest
        // device's acked position that it hasn't pulled yet, the purge-side dual of the pull bug.
        await this._collection.deleteMany({
            user: userId,
            $or: [{ ts: { $lt: minTs } }, { ts: minTs, _id: { $lte: minId } }],
        } as never);
    }

    /**
     * Owner-scoped single-op delete. Returns the result so callers (e.g. /sync/issues/:opId/dismiss)
     * can branch on `deletedCount === 0` to surface a 404 instead of pretending the op was removed.
     * Distinct from `deleteByOwner` (void-returning) on AbstractDAO since the panel handler needs
     * to discriminate "not found" from "deleted" to keep the UX honest.
     */
    async deleteOne(opId: string, userId: string) {
        return await this._collection.deleteOne({ _id: opId, user: userId } as never);
    }
}

export default new OperationsDAO();
