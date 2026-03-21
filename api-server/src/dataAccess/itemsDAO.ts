import type { MongoClient } from 'mongodb'
import AbstractDAO from './abstractDAO.js'
import type { ItemInterface } from '../types/entities.js'

class ItemsDAO extends AbstractDAO<ItemInterface> {
    override COLLECTION_NAME = 'items'

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName)
        await this._collection.createIndexes([
            { key: { user: 1 } },
            { key: { user: 1, status: 1 } },
            { key: { user: 1, expectedBy: 1 } },
            { key: { user: 1, timeStart: 1 } },
        ])
    }
}

export default new ItemsDAO()
