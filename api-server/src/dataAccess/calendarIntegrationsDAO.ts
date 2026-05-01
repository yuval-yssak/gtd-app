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
     *
     * Reconnect path: a row marked `'suspended'` or `'revoked'` by the auth-escalation flow is
     * cleared back to `'active'` here, and all three escalation timestamps are unset, so
     * completing OAuth is the user-facing way to recover from a revoked integration.
     */
    async upsertEncrypted(integration: CalendarIntegrationInterface): Promise<void> {
        const { _id, createdTs, ...rest } = integration;
        const encryptedRest = {
            ...rest,
            accessToken: encrypt(integration.accessToken),
            refreshToken: encrypt(integration.refreshToken),
            status: 'active' as const,
        };
        // $setOnInsert preserves createdTs and _id on reconnect — only $set on mutable fields.
        // $unset clears any prior escalation timestamps so a reconnected integration looks fresh.
        await this.updateOne(
            { user: integration.user, provider: integration.provider },
            {
                $set: encryptedRest,
                $setOnInsert: { _id, createdTs },
                $unset: { suspendedAt: '', revokedAt: '', lastAuthErrorAt: '' },
            },
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
        await this.insertOne(encrypted);
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
            { _id: id, user: userId },
            {
                $set: {
                    accessToken: encrypt(accessToken),
                    refreshToken: encrypt(refreshToken),
                    tokenExpiry,
                    updatedTs: dayjs().toISOString(),
                },
            },
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
        const docs = await this.findArray({ user: userId });
        return docs.map(decryptIntegration);
    }

    /** Fetches a single integration with tokens decrypted. */
    async findByOwnerAndIdDecrypted(id: string, userId: string): Promise<CalendarIntegrationInterface | null> {
        const doc = await this.findByOwnerAndId(id, userId);
        return doc ? decryptIntegration(doc) : null;
    }

    /** Updates the target calendarId (user-selected calendar to sync against). */
    async updateCalendarId(id: string, userId: string, calendarId: string): Promise<void> {
        await this.updateOne({ _id: id, user: userId }, { $set: { calendarId, updatedTs: dayjs().toISOString() } });
    }

    /** Bumps lastSyncedTs to mark a successful pull from Google Calendar. */
    async bumpLastSyncedTs(id: string, userId: string, ts: string): Promise<void> {
        // updatedTs tracks when the document itself was modified — decouple from lastSyncedTs
        // so it always reflects wall-clock "now", not the sync cursor time.
        await this.updateOne({ _id: id, user: userId }, { $set: { lastSyncedTs: ts, updatedTs: dayjs().toISOString() } });
    }

    /**
     * Reads a single integration by id without decrypting tokens. The auth-escalation flow only
     * needs status + timestamps + user, so skipping the decrypt avoids surfacing plaintext tokens
     * in code paths that don't need them.
     */
    async findById(id: string): Promise<CalendarIntegrationInterface | null> {
        return this.findOne({ _id: id } as never);
    }

    /**
     * Atomically transitions an integration from `'active'` (or no status field — legacy rows) to
     * `'suspended'`. Returns `true` if this call won the race and made the change. Used by the
     * escalation state machine to ensure exactly one warning email per suspension event.
     */
    async markSuspendedIfActive(id: string, ts: string): Promise<boolean> {
        const result = await this.updateOne({ _id: id, $or: [{ status: 'active' }, { status: { $exists: false } }] } as never, {
            $set: { status: 'suspended', suspendedAt: ts, lastAuthErrorAt: ts, updatedTs: ts },
        });
        return result.modifiedCount === 1;
    }

    /**
     * Atomically transitions an integration from `'suspended'` to `'revoked'`. Returns `true` if
     * this call won the race. Paired with `markSuspendedIfActive` so concurrent escalation
     * attempts produce at most one warning email + one revoked email per integration.
     */
    async markRevokedIfSuspended(id: string, ts: string): Promise<boolean> {
        const result = await this.updateOne({ _id: id, status: 'suspended' } as never, {
            $set: { status: 'revoked', revokedAt: ts, lastAuthErrorAt: ts, updatedTs: ts },
        });
        return result.modifiedCount === 1;
    }

    /** Records a fresh `invalid_grant` occurrence on an already-suspended integration without changing status. */
    async bumpLastAuthErrorAt(id: string, ts: string): Promise<void> {
        await this.updateOne({ _id: id } as never, { $set: { lastAuthErrorAt: ts } });
    }

    /**
     * Clears auth-escalation state — sets status back to `'active'` and unsets the three
     * escalation timestamps. Generally callers should use `upsertEncrypted` (which clears these
     * as a side effect of the OAuth reconnect); this method is exposed for tests and direct
     * recovery paths.
     */
    async clearAuthStatus(id: string): Promise<void> {
        await this.updateOne({ _id: id } as never, {
            $set: { status: 'active', updatedTs: dayjs().toISOString() },
            $unset: { suspendedAt: '', revokedAt: '', lastAuthErrorAt: '' },
        });
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
