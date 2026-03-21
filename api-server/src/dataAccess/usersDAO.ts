import type { MongoClient } from 'mongodb'
import AbstractDAO from './abstractDAO.js'
import type { UserInterface } from '../types/entities.js'

class UsersDAO extends AbstractDAO<UserInterface> {
    override COLLECTION_NAME = 'users'

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName)
        await this._collection.createIndexes([{ key: { email: 1 } }])
    }
}

export default new UsersDAO()
