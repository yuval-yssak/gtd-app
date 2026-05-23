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
            // Public API dedupe: external integrations may upsert by externalId.
            // Sparse + partial: only items that actually carry an externalId participate; in-app
            // items have no externalId and must not collide with each other.
            { key: { user: 1, externalId: 1 }, unique: true, partialFilterExpression: { externalId: { $type: 'string' } } },
            // Calendar exception race guard: two concurrent inbound paths (manual sync racing a
            // webhook delivery) can each see `resolveExceptionTarget` miss and both try to
            // create-on-miss for the same instance. The unique partial index forces the loser to
            // E11000 so `createItemForOrphanedException` can re-resolve and converge instead of
            // inserting a duplicate row. Only items carrying a string `calendarInstanceEventId`
            // participate — in-app items never set the field and must not collide.
            { key: { user: 1, calendarInstanceEventId: 1 }, unique: true, partialFilterExpression: { calendarInstanceEventId: { $type: 'string' } } },
            // Public API content-dedupe: lookup is { user, status:'inbox', contentHash, createdTs >= cutoff }.
            { key: { user: 1, status: 1, contentHash: 1, createdTs: 1 } },
        ]);
    }
}

export default new ItemsDAO();
