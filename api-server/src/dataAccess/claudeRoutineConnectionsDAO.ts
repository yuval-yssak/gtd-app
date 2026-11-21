import type { MongoClient } from 'mongodb';
import type { ClaudeRoutineConnectionInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class ClaudeRoutineConnectionsDAO extends AbstractDAO<ClaudeRoutineConnectionInterface> {
    override COLLECTION_NAME = 'claudeRoutineConnections';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        // One Claude routine per user.
        await this._collection.createIndexes([{ key: { user: 1 }, unique: true }]);
    }
}

export default new ClaudeRoutineConnectionsDAO();
