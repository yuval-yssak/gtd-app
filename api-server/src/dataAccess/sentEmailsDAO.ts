import type { MongoClient } from 'mongodb';
import type { SentEmailInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class SentEmailsDAO extends AbstractDAO<SentEmailInterface> {
    override COLLECTION_NAME = 'sentEmails';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            // Audit lookups by user, newest-first.
            { key: { userId: 1, sentAt: -1 } },
            // Operational: "how many warnings did we send last week" / debugging escalation flow.
            { key: { kind: 1, sentAt: -1 } },
        ]);
    }
}

export default new SentEmailsDAO();
