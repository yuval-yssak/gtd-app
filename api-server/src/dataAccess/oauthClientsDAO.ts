import type { MongoClient } from 'mongodb';
import type { OAuthClientInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

/**
 * Registered OAuth clients for the remote MCP flow (RFC 7591 Dynamic Client Registration).
 * `_id` is the `client_id`. Lookup is by `_id` during `/authorize` and `/token`.
 */
class OAuthClientsDAO extends AbstractDAO<OAuthClientInterface> {
    override COLLECTION_NAME = 'oauthClients';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        // `_id` carries the unique index implicitly; no secondary indexes needed at this scale.
    }

    async findById(clientId: string): Promise<OAuthClientInterface | null> {
        return this._collection.findOne({ _id: clientId });
    }
}

export default new OAuthClientsDAO();
