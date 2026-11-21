import type { MongoClient } from 'mongodb';
import type { ClaudeAskInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class ClaudeAsksDAO extends AbstractDAO<ClaudeAskInterface> {
    override COLLECTION_NAME = 'claudeAsks';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        // `{ user, itemId, createdTs }` serves both the per-item history and the in-flight guard
        // ("latest ask on this item"); `{ user }` serves bootstrap and account deletion.
        await this._collection.createIndexes([{ key: { user: 1 } }, { key: { user: 1, itemId: 1, createdTs: -1 } }]);
    }
}

export default new ClaudeAsksDAO();
