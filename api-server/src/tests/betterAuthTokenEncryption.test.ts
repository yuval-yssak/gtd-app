/**
 * Step 3A of the production-readiness work: Better Auth's `account.encryptOAuthTokens` is on, so
 * the Google/GitHub sign-in tokens land in Mongo as ciphertext, and the one-off migration
 * (`scripts/encryptBetterAuthTokens.ts`) converts rows written before the flag — idempotently.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLikelyEncryptedToken, readBetterAuthToken } from '../lib/betterAuthTokenCrypto.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { encryptPlaintextAccountTokens } from '../scripts/encryptBetterAuthTokens.js';
import { GOOGLE_TOKEN, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

interface AccountRow {
    providerId: string;
    accessToken?: string | null;
    refreshToken?: string | null;
    idToken?: string | null;
}

beforeAll(async () => {
    await loadDataAccess('gtd_test_ba_token_encryption');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all(['user', 'session', 'account', 'verification'].map((name) => db.collection(name).deleteMany({})));
});

describe('account.encryptOAuthTokens', () => {
    it('stores the provider tokens as ciphertext that our helper can read back, and the session still works', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const account = await db.collection<AccountRow>('account').findOne({ providerId: 'google' });
        if (!account) {
            throw new Error('expected a google account row');
        }

        expect(account.accessToken).not.toBe(GOOGLE_TOKEN.access_token);
        expect(account.refreshToken).not.toBe(GOOGLE_TOKEN.refresh_token);
        expect(isLikelyEncryptedToken(account.accessToken ?? '')).toBe(true);
        expect(isLikelyEncryptedToken(account.refreshToken ?? '')).toBe(true);
        // Known gap, pinned so an upgrade that starts covering it is noticed: 1.5.6 stores idToken in plaintext.
        expect(account.idToken).toBe(GOOGLE_TOKEN.id_token);
        await expect(readBetterAuthToken(account.accessToken)).resolves.toBe(GOOGLE_TOKEN.access_token);
        await expect(readBetterAuthToken(account.refreshToken)).resolves.toBe(GOOGLE_TOKEN.refresh_token);

        const sessionRes = await app.fetch(
            new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }),
        );
        const { user } = (await sessionRes.json()) as { user: { email: string } };
        expect(user.email).toBe('alice@example.com');
    });
});

describe('encryptPlaintextAccountTokens (migration script)', () => {
    it('encrypts plaintext rows, leaves encrypted rows alone, and is idempotent', async () => {
        await db.collection('account').insertMany([
            { providerId: 'google', userId: 'u1', accessToken: 'ya29.plain', refreshToken: '1//plain-rt', idToken: 'eyJ.plain.jwt' },
            { providerId: 'github', userId: 'u2', accessToken: 'gho_plain' },
            { providerId: 'google', userId: 'u3', accessToken: null },
        ]);

        const first = await encryptPlaintextAccountTokens(db, { dryRun: false });
        expect(first).toEqual({ rowsScanned: 3, rowsUpdated: 2, fieldsEncrypted: 3 });

        const rows = await db.collection<AccountRow & { userId: string }>('account').find({}).sort({ userId: 1 }).toArray();
        const [u1, u2, u3] = rows;
        if (!u1 || !u2 || !u3) {
            throw new Error('expected three rows');
        }
        expect(isLikelyEncryptedToken(u1.accessToken ?? '')).toBe(true);
        await expect(readBetterAuthToken(u1.accessToken)).resolves.toBe('ya29.plain');
        await expect(readBetterAuthToken(u1.refreshToken)).resolves.toBe('1//plain-rt');
        // idToken is outside Better Auth's encryption, so the script leaves it exactly as stored.
        expect(u1.idToken).toBe('eyJ.plain.jwt');
        await expect(readBetterAuthToken(u2.accessToken)).resolves.toBe('gho_plain');
        expect(u3.accessToken).toBeNull();

        const second = await encryptPlaintextAccountTokens(db, { dryRun: false });
        expect(second).toEqual({ rowsScanned: 3, rowsUpdated: 0, fieldsEncrypted: 0 });
        const u1Again = await db.collection<AccountRow>('account').findOne({ userId: 'u1' } as never);
        expect(u1Again?.accessToken).toBe(u1.accessToken);
    });

    it('never overwrites a row that changed between the read and the write (a sign-in mid-migration)', async () => {
        await db.collection('account').insertOne({ providerId: 'google', userId: 'u1', accessToken: 'ya29.old' });
        const realFind = db.collection('account').find.bind(db.collection('account'));
        // Snapshot the row, then let a "sign-in" replace the token before the migration writes.
        vi.spyOn(db, 'collection').mockImplementationOnce((() => ({
            find: (...args: Parameters<typeof realFind>) => {
                const cursor = realFind(...args);
                return {
                    toArray: async () => {
                        const rows = await cursor.toArray();
                        await db.collection('account').updateOne({ userId: 'u1' } as never, { $set: { accessToken: 'ya29.fresh-from-signin' } });
                        return rows;
                    },
                };
            },
        })) as never);

        const summary = await encryptPlaintextAccountTokens(db, { dryRun: false });

        expect(summary.rowsUpdated).toBe(0);
        const row = await db.collection<AccountRow>('account').findOne({ userId: 'u1' } as never);
        expect(row?.accessToken).toBe('ya29.fresh-from-signin');
    });

    it('dryRun counts the work without writing', async () => {
        await db.collection('account').insertOne({ providerId: 'google', userId: 'u1', accessToken: 'ya29.plain' });
        const summary = await encryptPlaintextAccountTokens(db, { dryRun: true });
        expect(summary).toEqual({ rowsScanned: 1, rowsUpdated: 1, fieldsEncrypted: 1 });
        const row = await db.collection<AccountRow>('account').findOne({ userId: 'u1' } as never);
        expect(row?.accessToken).toBe('ya29.plain');
    });
});

describe('readBetterAuthToken', () => {
    it('passes plaintext through and returns null for empty values', async () => {
        await expect(readBetterAuthToken('ya29.plaintext-looking')).resolves.toBe('ya29.plaintext-looking');
        await expect(readBetterAuthToken(null)).resolves.toBeNull();
        await expect(readBetterAuthToken('')).resolves.toBeNull();
    });
});
