import type { MongoClient } from 'mongodb';
import type { ReviewInboxInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class ReviewInboxesDAO extends AbstractDAO<ReviewInboxInterface> {
    override COLLECTION_NAME = 'reviewInboxes';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } },
            { key: { user: 1, updatedTs: 1 } }, // used by sync: pull all reviewInboxes changed since last device sync
        ]);
    }
}

export default new ReviewInboxesDAO();
