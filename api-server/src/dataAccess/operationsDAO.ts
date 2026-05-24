import type { MongoClient } from 'mongodb';
import type { OperationInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class OperationsDAO extends AbstractDAO<OperationInterface> {
    override COLLECTION_NAME = 'operations';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1, ts: 1 } }, // incremental pull: all ops for user since a given ts
            { key: { user: 1, entityType: 1, entityId: 1, ts: 1 } }, // entity history lookup
        ]);
    }

    async deleteOlderThan(userId: string, ts: string): Promise<void> {
        // $lte: all devices have advanced their cursor to at least `ts`, meaning they've
        // received every op at that timestamp. Safe to delete ops at and before `ts`.
        await this._collection.deleteMany({ user: userId, ts: { $lte: ts } } as never);
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
