import type { MongoClient } from 'mongodb';
import type { OAuthAuthCodeInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

/**
 * One-time OAuth authorization codes. `_id` is the sha256 hash of the code plaintext.
 * Redemption is a single atomic `findOneAndUpdate` that both validates (unconsumed + unexpired)
 * and consumes (`consumedTs`) the row — the replay guard. A TTL index reaps expired rows.
 */
class OAuthAuthCodesDAO extends AbstractDAO<OAuthAuthCodeInterface> {
    override COLLECTION_NAME = 'oauthAuthCodes';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        // GC consumed/expired codes shortly after expiry. Security relies on the atomic consume
        // below, NOT on the TTL — a not-yet-reaped expired code is rejected by the `expiresTs` guard.
        await this._collection.createIndex({ expiresTs: 1 }, { expireAfterSeconds: 0 });
    }

    /**
     * Atomically consumes a code: matches only an unconsumed, unexpired row for `codeHash` and
     * stamps `consumedTs`. Returns the pre-update document (so the caller can read its bindings),
     * or null when the code is unknown, already consumed (replay), or expired.
     */
    async consume(codeHash: string, nowIso: string): Promise<OAuthAuthCodeInterface | null> {
        return this._collection.findOneAndUpdate(
            { _id: codeHash, consumedTs: { $exists: false }, expiresTs: { $gt: nowIso } },
            { $set: { consumedTs: nowIso } },
            { returnDocument: 'before' },
        );
    }
}

export default new OAuthAuthCodesDAO();
