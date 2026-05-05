import type { MongoClient } from 'mongodb';
import type { ApiTokenInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class ApiTokensDAO extends AbstractDAO<ApiTokenInterface> {
    override COLLECTION_NAME = 'apiTokens';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            // Lookups during auth go through tokenHash. Unique so two tokens cannot collide
            // (collision implies the random source is broken; better to fail loudly than silently overwrite).
            { key: { tokenHash: 1 }, unique: true },
            // List-tokens-for-user view in settings.
            { key: { user: 1 } },
        ]);
    }

    /** Returns the token row for `tokenHash`, or null if missing or revoked. */
    async findActiveByHash(tokenHash: string): Promise<ApiTokenInterface | null> {
        return this._collection.findOne({ tokenHash, revokedTs: { $exists: false } });
    }

    /** Best-effort lastUsedTs bump — never blocks the request lifecycle. Errors are caller's responsibility. */
    async touchLastUsed(tokenId: string, now: string): Promise<void> {
        await this._collection.updateOne({ _id: tokenId }, { $set: { lastUsedTs: now } });
    }
}

export default new ApiTokensDAO();
