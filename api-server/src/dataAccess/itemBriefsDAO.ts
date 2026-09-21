import type { MongoClient } from 'mongodb';
import type { ItemBriefInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class ItemBriefsDAO extends AbstractDAO<ItemBriefInterface> {
    override COLLECTION_NAME = 'itemBriefs';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        // `_id` (=== item._id) is the implicit unique key. `{ user, sourceHash }` serves the
        // generation sweep's "is this brief still current" lookups once Phase 2 lands.
        await this._collection.createIndexes([{ key: { user: 1 } }, { key: { user: 1, sourceHash: 1 } }]);
    }
}

export default new ItemBriefsDAO();
