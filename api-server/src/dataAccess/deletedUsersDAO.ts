import type { DeletedUserTombstone } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class DeletedUsersDAO extends AbstractDAO<DeletedUserTombstone> {
    override COLLECTION_NAME = 'deletedUsers';

    /** Idempotent: a re-run keeps the FIRST deletion's row — `deletedAt` records when the account actually went. */
    async upsertTombstone(tombstone: DeletedUserTombstone): Promise<void> {
        await this._collection.updateOne({ _id: tombstone._id }, { $setOnInsert: tombstone }, { upsert: true });
    }

    async findByUserId(userId: string): Promise<DeletedUserTombstone | null> {
        return this._collection.findOne({ _id: userId });
    }
}

export default new DeletedUsersDAO();
