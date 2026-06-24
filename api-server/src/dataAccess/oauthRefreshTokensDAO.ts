import type { MongoClient } from 'mongodb';
import type { OAuthRefreshTokenInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

/**
 * Rotating OAuth refresh tokens. `_id` is the sha256 hash of the refresh plaintext. Each use
 * rotates (atomic `findOneAndUpdate` sets `rotatedToId`); a second use of an already-rotated row
 * is reuse → the caller revokes the whole family.
 */
class OAuthRefreshTokensDAO extends AbstractDAO<OAuthRefreshTokenInterface> {
    override COLLECTION_NAME = 'oauthRefreshTokens';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } },
            // GC expired refresh rows. Partial so rows without an expiry are never reaped.
            { key: { expiresTs: 1 }, expireAfterSeconds: 0, partialFilterExpression: { expiresTs: { $exists: true } } },
        ]);
    }

    /**
     * Atomically claims a refresh-token rotation: matches only an unrevoked, unexpired, not-yet-rotated
     * row for `refreshHash` and stamps `rotatedToId` with the REAL successor id (so the family chain is
     * durably walkable). Returns the pre-update document, or null when the token is unknown, revoked,
     * expired, or ALREADY rotated (a concurrent winner / reuse — caller must revoke the family).
     *
     * The expiry guard mirrors the access-token path (`findActiveUnexpiredByHash`): the TTL reaper is
     * best-effort, so expiry must be enforced here too rather than relying on the row being gone.
     */
    async rotate(refreshHash: string, successorId: string, nowIso: string): Promise<OAuthRefreshTokenInterface | null> {
        return this._collection.findOneAndUpdate(
            {
                _id: refreshHash,
                revokedTs: { $exists: false },
                rotatedToId: { $exists: false },
                $or: [{ expiresTs: { $exists: false } }, { expiresTs: { $gt: nowIso } }],
            },
            { $set: { rotatedToId: successorId } },
            { returnDocument: 'before' },
        );
    }

    /** Reads a refresh row by hash regardless of state — used to detect reuse and walk the family for revocation. */
    async findByHash(refreshHash: string): Promise<OAuthRefreshTokenInterface | null> {
        return this._collection.findOne({ _id: refreshHash });
    }

    /** Marks a refresh row revoked. Used during reuse-detection family revocation. */
    async revokeById(refreshId: string, now: string): Promise<void> {
        await this._collection.updateOne({ _id: refreshId }, { $set: { revokedTs: now } });
    }
}

export default new OAuthRefreshTokensDAO();
