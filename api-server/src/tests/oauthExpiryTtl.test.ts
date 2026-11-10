import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueApiToken, issueOAuthAccessToken } from '../auth/apiTokens.js';
import { issueAuthCode, pkceS256Challenge, redeemAuthorizationCode, registerOAuthClient, sha256 } from '../lib/mcpOAuth.js';
import { ensureExpiresAtTtl } from '../lib/ttlExpiry.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';

/**
 * MongoDB TTL indexes only reap documents whose indexed field is a BSON Date; a string field is
 * silently ignored. The OAuth rows keep their ISO `expiresTs` for query-time expiry checks and carry
 * a BSON `expiresAt` twin that the TTL index can actually act on.
 */

const EXPIRING_COLLECTIONS = ['apiTokens', 'oauthAuthCodes', 'oauthRefreshTokens'] as const;

/** The expiry-relevant slice of any of the three OAuth row shapes. */
interface ExpiringRow {
    _id: string;
    expiresTs?: string;
    expiresAt?: Date;
    [field: string]: unknown;
}

function expiringRows(collection: (typeof EXPIRING_COLLECTIONS)[number]) {
    return db.collection<ExpiringRow>(collection);
}

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all(EXPIRING_COLLECTIONS.map((name) => db.collection(name).deleteMany({})));
});

async function ttlIndexedFields(collection: string) {
    const indexes = await db.collection(collection).listIndexes().toArray();
    return indexes.filter((index) => 'expireAfterSeconds' in index).flatMap((index) => Object.keys(index.key));
}

describe('OAuth expiry TTL indexes', () => {
    it.each(EXPIRING_COLLECTIONS)('%s reaps on the BSON-Date expiresAt, never on the string expiresTs', async (collection) => {
        expect(await ttlIndexedFields(collection)).toEqual(['expiresAt']);
    });
});

describe('issued OAuth access tokens', () => {
    it('carry a BSON Date expiresAt matching expiresTs', async () => {
        const { record } = await issueOAuthAccessToken('user-1', 'client-1', ['items.read'], 3600);

        const row = await expiringRows('apiTokens').findOne({ _id: record._id });
        if (!row) {
            throw new Error('expected the access-token row');
        }
        expect(row.expiresAt).toBeInstanceOf(Date);
        expect(dayjs(row.expiresAt).toISOString()).toBe(row.expiresTs);
    });

    it('personal tokens get no expiry at all', async () => {
        const { record } = await issueApiToken('user-1', 'my-script');

        const row = await expiringRows('apiTokens').findOne({ _id: record._id });
        expect(row).not.toHaveProperty('expiresAt');
        expect(row).not.toHaveProperty('expiresTs');
    });
});

const PKCE_VERIFIER = 'ttl-test-pkce-verifier-that-is-at-least-forty-three-characters';
const REDIRECT_URI = 'http://127.0.0.1:65530/callback';

/** Issues a real authorization code and redeems it — the two other writers of expiring rows. */
async function issueAndRedeemCode() {
    const { client } = await registerOAuthClient({ redirectUris: [REDIRECT_URI] });
    const code = await issueAuthCode({
        user: 'user-1',
        client,
        redirectUri: REDIRECT_URI,
        codeChallenge: pkceS256Challenge(PKCE_VERIFIER),
        scopes: ['items.read'],
    });
    const grant = await redeemAuthorizationCode({
        code,
        clientId: client._id,
        redirectUri: REDIRECT_URI,
        codeVerifier: PKCE_VERIFIER,
        accessTtlSec: 3600,
        refreshTtlSec: 86400,
    });
    if (!grant.ok) {
        throw new Error(`code redemption failed: ${grant.description}`);
    }
    return { codeId: sha256(code), refreshId: sha256(grant.tokens.refreshToken) };
}

function expectReapableExpiry(row: ExpiringRow | null) {
    if (!row) {
        throw new Error('expected the expiring row');
    }
    expect(row.expiresAt).toBeInstanceOf(Date);
    expect(dayjs(row.expiresAt).toISOString()).toBe(row.expiresTs);
}

describe('issued authorization codes and refresh tokens', () => {
    it('both carry a BSON Date expiresAt matching expiresTs', async () => {
        const { codeId, refreshId } = await issueAndRedeemCode();

        expectReapableExpiry(await expiringRows('oauthAuthCodes').findOne({ _id: codeId }));
        expectReapableExpiry(await expiringRows('oauthRefreshTokens').findOne({ _id: refreshId }));
    });
});

describe('ensureExpiresAtTtl backfill', () => {
    it('stamps expiresAt on legacy rows that only carry the string expiresTs, and leaves non-expiring rows alone', async () => {
        const collection = expiringRows('apiTokens');
        // Future, so the TTL monitor cannot reap the row between backfill and the assertion.
        const legacyExpiry = dayjs().add(1, 'hour').toISOString();
        await collection.insertMany([
            { _id: 'legacy', user: 'u', tokenHash: 'h1', label: 'mcp-oauth:c', createdTs: legacyExpiry, expiresTs: legacyExpiry, kind: 'oauth_access' },
            { _id: 'personal', user: 'u', tokenHash: 'h2', label: 'mine', createdTs: legacyExpiry },
        ]);

        await ensureExpiresAtTtl(db, 'apiTokens');

        const legacy = await collection.findOne({ _id: 'legacy' });
        if (!legacy) {
            throw new Error('expected the legacy row');
        }
        expect(legacy.expiresAt).toEqual(dayjs(legacyExpiry).toDate());
        expect(await collection.findOne({ _id: 'personal' })).not.toHaveProperty('expiresAt');
    });

    it('a row with an unparseable expiresTs is skipped instead of failing boot', async () => {
        await expiringRows('apiTokens').insertOne({ _id: 'garbled', user: 'u', tokenHash: 'h3', label: 'x', createdTs: 'x', expiresTs: 'not-a-date' });

        await expect(ensureExpiresAtTtl(db, 'apiTokens')).resolves.toBeUndefined();

        expect(await expiringRows('apiTokens').findOne({ _id: 'garbled' })).not.toHaveProperty('expiresAt');
    });

    it('drops the pre-fix TTL index on the string expiresTs that never reaped anything', async () => {
        await db.collection('oauthAuthCodes').dropIndexes();
        await db.collection('oauthAuthCodes').createIndex({ expiresTs: 1 }, { expireAfterSeconds: 0 });

        await ensureExpiresAtTtl(db, 'oauthAuthCodes');

        expect(await ttlIndexedFields('oauthAuthCodes')).toEqual(['expiresAt']);
    });

    it('two processes booting at once against the legacy index both succeed', async () => {
        await db.collection('oauthAuthCodes').dropIndexes();
        await db.collection('oauthAuthCodes').createIndex({ expiresTs: 1 }, { expireAfterSeconds: 0 });

        await expect(Promise.all([ensureExpiresAtTtl(db, 'oauthAuthCodes'), ensureExpiresAtTtl(db, 'oauthAuthCodes')])).resolves.toBeDefined();
    });

    it('is idempotent across boots', async () => {
        await ensureExpiresAtTtl(db, 'oauthRefreshTokens');
        await ensureExpiresAtTtl(db, 'oauthRefreshTokens');

        expect(await ttlIndexedFields('oauthRefreshTokens')).toEqual(['expiresAt']);
    });
});
