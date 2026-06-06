import type { MongoClient } from 'mongodb';
import type { ClaudeUsageInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

/**
 * Per-user-per-day Claude token-spend ledger. One document per `(user, day)`, keyed by the
 * deterministic `${user}:${day}` `_id` so the post-call increment is a single atomic upsert with
 * no separate unique index needed. Backs the Lane A spend cap (read before the call) and the COGS
 * metering (increment after the call).
 */
class ClaudeUsageDAO extends AbstractDAO<ClaudeUsageInterface> {
    override COLLECTION_NAME = 'claudeUsage';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        // `_id` already uniquely identifies a (user, day) row; this secondary index supports
        // per-user history queries (e.g. a future usage dashboard) without scanning.
        await this._collection.createIndexes([{ key: { user: 1, day: 1 } }]);
    }
}

export default new ClaudeUsageDAO();
