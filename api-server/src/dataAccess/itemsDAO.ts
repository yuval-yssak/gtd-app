import type { MongoClient } from 'mongodb';
import type { ItemInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class ItemsDAO extends AbstractDAO<ItemInterface> {
    override COLLECTION_NAME = 'items';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } },
            { key: { user: 1, status: 1 } },
            { key: { user: 1, expectedBy: 1 } },
            { key: { user: 1, timeStart: 1 } },
            { key: { user: 1, updatedTs: 1 } }, // used by sync: pull all items changed since last device sync
        ]);
    }
}

export default new ItemsDAO();
