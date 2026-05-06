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

    /** Lists every token belonging to `userId`, including revoked ones. Sorted by createdTs DESC. */
    async listForUser(userId: string): Promise<ApiTokenInterface[]> {
        return this._collection.find({ user: userId }).sort({ createdTs: -1 }).toArray();
    }

    /** Counts active (not revoked) tokens for `userId`. Used to enforce the per-user mint cap. */
    async countActiveForUser(userId: string): Promise<number> {
        return this._collection.countDocuments({ user: userId, revokedTs: { $exists: false } });
    }

    /**
     * Revokes a token scoped to `userId` so a user can't revoke another user's row.
     * Returns `matched: false` when the token does not exist or belongs to someone else (handler maps to 404).
     * Idempotent — revoking an already-revoked token returns `matched: true, alreadyRevoked: true`.
     *
     * Note: find-then-update is not strictly atomic. Concurrent revokes of the same row both observe
     * `revokedTs` undefined and both write `revokedTs`; last-write-wins on the timestamp. Functionally
     * harmless — the token stays revoked — and the only externally visible effect is a slightly later
     * `revokedTs` than the first call to win the race. A `findOneAndUpdate` with `revokedTs: $exists`
     * guard would be strictly atomic; not worth the complexity for this UX-grade endpoint.
     */
    async revokeById(tokenId: string, userId: string, now: string): Promise<{ matched: boolean; alreadyRevoked: boolean }> {
        const existing = await this._collection.findOne({ _id: tokenId, user: userId });
        if (!existing) {
            return { matched: false, alreadyRevoked: false };
        }
        if (existing.revokedTs) {
            return { matched: true, alreadyRevoked: true };
        }
        await this._collection.updateOne({ _id: tokenId, user: userId }, { $set: { revokedTs: now } });
        return { matched: true, alreadyRevoked: false };
    }
}

export default new ApiTokensDAO();
