import dayjs from 'dayjs';
import type { MongoClient } from 'mongodb';
import { decrypt, encrypt } from '../lib/tokenEncryption.js';
import type { CalendarIntegrationInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class CalendarIntegrationsDAO extends AbstractDAO<CalendarIntegrationInterface> {
    override COLLECTION_NAME = 'calendarIntegrations';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } },
            // Enforce at most one integration per provider per user — prevents duplicate
            // integrations from concurrent OAuth completions (two tabs finishing at once).
            { key: { user: 1, provider: 1 }, unique: true },
        ]);
    }

    /**
     * Upserts an integration keyed by (user, provider), encrypting tokens at rest.
     * Upserting instead of inserting prevents duplicates from concurrent OAuth completions.
     */
    async upsertEncrypted(integration: CalendarIntegrationInterface): Promise<void> {
        const { _id, createdTs, ...rest } = integration;
        const encryptedRest = {
            ...rest,
            accessToken: encrypt(integration.accessToken),
            refreshToken: encrypt(integration.refreshToken),
        };
        // $setOnInsert preserves createdTs and _id on reconnect — only $set on mutable fields.
        await this.updateOne(
            { user: integration.user, provider: integration.provider } as never,
            { $set: encryptedRest, $setOnInsert: { _id, createdTs } } as never,
            { upsert: true },
        );
    }

    /**
     * Stores an integration with tokens encrypted at rest.
     * @internal **Test-only** — production code must use `upsertEncrypted` to enforce the
     * unique `(user, provider)` constraint and prevent duplicate integrations.
     */
    async insertEncrypted(integration: CalendarIntegrationInterface): Promise<void> {
        const encrypted: CalendarIntegrationInterface = {
            ...integration,
            accessToken: encrypt(integration.accessToken),
            refreshToken: encrypt(integration.refreshToken),
        };
        await this.insertOne(encrypted as never);
    }

    /** Updates only the token fields (called after an OAuth token refresh).
     *  Expects plaintext tokens — encrypts them internally. Never pass pre-encrypted bytes. */
    async updateTokens({
        id,
        userId,
        accessToken,
        refreshToken,
        tokenExpiry,
    }: {
        id: string;
        userId: string;
        accessToken: string;
        refreshToken: string;
        tokenExpiry: string;
    }): Promise<void> {
        const result = await this.updateOne(
            { _id: id, user: userId } as never,
            {
                $set: {
                    accessToken: encrypt(accessToken),
                    refreshToken: encrypt(refreshToken),
                    tokenExpiry,
                    updatedTs: dayjs().toISOString(),
                },
            } as never,
        );
        // Warn rather than throw — this is called from a fire-and-forget token event handler.
        // A miss means the integration was deleted between the provider being created and the
        // token refresh completing; the warning surfaces it without crashing the parent request.
        if (result.matchedCount === 0) {
            console.warn(`[calendarIntegrationsDAO] updateTokens: no integration matched id=${id} userId=${userId}`);
        }
    }

    /** Fetches all integrations for a user with tokens decrypted. */
    async findByUserDecrypted(userId: string): Promise<CalendarIntegrationInterface[]> {
        const docs = await this.findArray({ user: userId } as never);
        return docs.map(decryptIntegration);
    }

    /** Fetches a single integration with tokens decrypted. */
    async findByOwnerAndIdDecrypted(id: string, userId: string): Promise<CalendarIntegrationInterface | null> {
        const doc = await this.findByOwnerAndId(id, userId);
        return doc ? decryptIntegration(doc) : null;
    }

    /** Updates the target calendarId (user-selected calendar to sync against). */
    async updateCalendarId(id: string, userId: string, calendarId: string): Promise<void> {
        await this.updateOne({ _id: id, user: userId } as never, { $set: { calendarId, updatedTs: dayjs().toISOString() } } as never);
    }

    /** Bumps lastSyncedTs to mark a successful pull from Google Calendar. */
    async bumpLastSyncedTs(id: string, userId: string, ts: string): Promise<void> {
        // updatedTs tracks when the document itself was modified — decouple from lastSyncedTs
        // so it always reflects wall-clock "now", not the sync cursor time.
        await this.updateOne({ _id: id, user: userId } as never, { $set: { lastSyncedTs: ts, updatedTs: dayjs().toISOString() } } as never);
    }
}

function decryptIntegration(doc: CalendarIntegrationInterface): CalendarIntegrationInterface {
    return {
        ...doc,
        accessToken: decrypt(doc.accessToken),
        refreshToken: decrypt(doc.refreshToken),
    };
}

export default new CalendarIntegrationsDAO();
