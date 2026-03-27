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
}

export default new OperationsDAO();
