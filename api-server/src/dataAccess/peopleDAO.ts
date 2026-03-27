import type { MongoClient } from 'mongodb';
import type { PersonInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class PeopleDAO extends AbstractDAO<PersonInterface> {
    override COLLECTION_NAME = 'people';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } },
            { key: { user: 1, updatedTs: 1 } }, // used by sync: pull all people changed since last device sync
        ]);
    }
}

export default new PeopleDAO();
