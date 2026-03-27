import type { MongoClient } from 'mongodb';
import type { RoutineInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class RoutinesDAO extends AbstractDAO<RoutineInterface> {
    override COLLECTION_NAME = 'routines';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } },
            { key: { user: 1, updatedTs: 1 } }, // used by sync: pull all routines changed since last device sync
        ]);
    }
}

export default new RoutinesDAO();
