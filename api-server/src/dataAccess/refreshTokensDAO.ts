import type { MongoClient, ObjectId } from 'mongodb';
import AbstractDAO from './abstractDAO.js';

export interface RefreshTokenDoc {
    token: string;
    userId: ObjectId;
    email: string;
    expiresAt: Date; // TTL index — MongoDB auto-deletes expired docs
    createdAt: Date;
}

class RefreshTokensDAO extends AbstractDAO<RefreshTokenDoc> {
    override COLLECTION_NAME = 'refreshTokens';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        // expireAfterSeconds: 0 means MongoDB deletes the doc at exactly the expiresAt time
        await this._collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        await this._collection.createIndex({ token: 1 }, { unique: true });
        await this._collection.createIndex({ userId: 1 });
    }
}

export default new RefreshTokensDAO();
