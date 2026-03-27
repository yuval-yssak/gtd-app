import type { MongoClient } from 'mongodb';
import type { WorkContextInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class WorkContextsDAO extends AbstractDAO<WorkContextInterface> {
    override COLLECTION_NAME = 'workContexts';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } },
            { key: { user: 1, updatedTs: 1 } }, // used by sync: pull all workContexts changed since last device sync
        ]);
    }
}

export default new WorkContextsDAO();
