/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken, issueApiToken } from '../auth/apiTokens.js';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { PROD_TOKEN_CAP_PER_USER, tokensRoutes } from '../routes/tokens.js';
import { v1ItemsRoutes } from '../routes/v1Items.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/account/tokens', tokensRoutes)
    .route('/v1', v1ItemsRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('user').deleteMany({}),
        db.collection('session').deleteMany({}),
        db.collection('account').deleteMany({}),
        db.collection('verification').deleteMany({}),
        db.collection('apiTokens').deleteMany({}),
    ]);
});

async function loginAs(provider: 'google' | 'github', overrides: Record<string, unknown> = {}): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, provider, overrides);
    return sessionCookie!;
}

describe('POST /account/tokens', () => {
    it('mints a token, returns plaintext exactly once', async () => {
        const sessionCookie = await loginAs('google');
        const res = await authenticatedRequest(app, { method: 'POST', path: '/account/tokens', sessionCookie, body: { label: 'iOS Shortcut' } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { id: string; label: string; createdTs: string; plaintext: string };
        expect(body.label).toBe('iOS Shortcut');
        expect(body.plaintext.startsWith('gtd_')).toBe(true);
        expect(body.id).toBeTruthy();
        expect(body.createdTs).toBeTruthy();

        // GET must never echo the plaintext or tokenHash.
        const listRes = await authenticatedRequest(app, { method: 'GET', path: '/account/tokens', sessionCookie });
        const list = (await listRes.json()) as { tokens: Array<Record<string, unknown>> };
        expect(list.tokens).toHaveLength(1);
        expect(list.tokens[0]).not.toHaveProperty('plaintext');
        expect(list.tokens[0]).not.toHaveProperty('tokenHash');
        expect(list.tokens[0]).not.toHaveProperty('user');
    });

    it('falls back to "unlabeled" when label is omitted or blank', async () => {
        const sessionCookie = await loginAs('google');
        const res = await authenticatedRequest(app, { method: 'POST', path: '/account/tokens', sessionCookie, body: {} });
        const body = (await res.json()) as { label: string };
        expect(body.label).toBe('unlabeled');
    });

    it('mint response does not echo tokenHash or user (negative projection)', async () => {
        const sessionCookie = await loginAs('google');
        const res = await authenticatedRequest(app, { method: 'POST', path: '/account/tokens', sessionCookie, body: { label: 'projection' } });
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).not.toHaveProperty('tokenHash');
        expect(body).not.toHaveProperty('user');
        expect(Object.keys(body).sort()).toEqual(['createdTs', 'id', 'label', 'plaintext']);
    });

    it('treats a non-JSON body as an empty object and falls back to "unlabeled"', async () => {
        const sessionCookie = await loginAs('google');
        const res = await app.fetch(
            new Request('http://localhost:4000/account/tokens', {
                method: 'POST',
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}`, 'Content-Type': 'application/json' },
                body: 'this is not json',
            }),
        );
        expect(res.status).toBe(200);
        expect(((await res.json()) as { label: string }).label).toBe('unlabeled');
    });

    it('rejects non-string labels', async () => {
        const sessionCookie = await loginAs('google');
        const res = await authenticatedRequest(app, { method: 'POST', path: '/account/tokens', sessionCookie, body: { label: 42 } });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_label');
    });

    it('returns 401 without a session', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/account/tokens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: 'x' }),
            }),
        );
        expect(res.status).toBe(401);
    });

    it('enforces the per-user cap and returns 429 with the expected code', async () => {
        const sessionCookie = await loginAs('google');
        // Seed PROD_TOKEN_CAP_PER_USER tokens directly via the DAO so the test stays under 1s.
        const userRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
        const { user } = (await userRes.json()) as { user: { id: string } };
        for (let i = 0; i < PROD_TOKEN_CAP_PER_USER; i++) {
            await issueApiToken(user.id, `seed-${i}`);
        }
        const res = await authenticatedRequest(app, { method: 'POST', path: '/account/tokens', sessionCookie, body: { label: 'one-too-many' } });
        expect(res.status).toBe(429);
        expect(((await res.json()) as { code: string }).code).toBe('token_cap_reached');
    });

    it('does not count revoked tokens against the cap', async () => {
        const sessionCookie = await loginAs('google');
        const userRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
        const { user } = (await userRes.json()) as { user: { id: string } };
        // Cap minus one active + one revoked. The next mint should succeed.
        for (let i = 0; i < PROD_TOKEN_CAP_PER_USER - 1; i++) {
            await issueApiToken(user.id, `seed-${i}`);
        }
        const { record } = await issueApiToken(user.id, 'soon-to-revoke');
        await apiTokensDAO.revokeById(record._id, user.id, '2026-01-01T00:00:00.000Z');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/account/tokens', sessionCookie, body: { label: 'fresh' } });
        expect(res.status).toBe(200);
    });
});

describe('GET /account/tokens', () => {
    it('returns 401 without a session', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/account/tokens'));
        expect(res.status).toBe(401);
    });

    it("lists only the caller's tokens, not other users' tokens", async () => {
        const aliceCookie = await loginAs('google');
        await authenticatedRequest(app, { method: 'POST', path: '/account/tokens', sessionCookie: aliceCookie, body: { label: 'alice' } });

        const bobCookie = await loginAs('github', { email: 'bob@example.com', login: 'bob-gh' });
        await authenticatedRequest(app, { method: 'POST', path: '/account/tokens', sessionCookie: bobCookie, body: { label: 'bob' } });

        const aliceList = await authenticatedRequest(app, { method: 'GET', path: '/account/tokens', sessionCookie: aliceCookie });
        const aliceBody = (await aliceList.json()) as { tokens: Array<{ label: string }> };
        expect(aliceBody.tokens.map((t) => t.label)).toEqual(['alice']);

        const bobList = await authenticatedRequest(app, { method: 'GET', path: '/account/tokens', sessionCookie: bobCookie });
        const bobBody = (await bobList.json()) as { tokens: Array<{ label: string }> };
        expect(bobBody.tokens.map((t) => t.label)).toEqual(['bob']);
    });

    it('returns tokens sorted by createdTs DESC', async () => {
        const sessionCookie = await loginAs('google');
        const userRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
        const { user } = (await userRes.json()) as { user: { id: string } };
        // Seed three rows with explicit createdTs values via the DAO so we don't depend on insert timing.
        await apiTokensDAO.insertOne({ _id: 'tok-old', user: user.id, tokenHash: 'h-old', label: 'old', createdTs: '2020-01-01T00:00:00.000Z' });
        await apiTokensDAO.insertOne({ _id: 'tok-mid', user: user.id, tokenHash: 'h-mid', label: 'mid', createdTs: '2022-06-01T00:00:00.000Z' });
        await apiTokensDAO.insertOne({ _id: 'tok-new', user: user.id, tokenHash: 'h-new', label: 'new', createdTs: '2025-12-01T00:00:00.000Z' });

        const list = await authenticatedRequest(app, { method: 'GET', path: '/account/tokens', sessionCookie });
        const body = (await list.json()) as { tokens: Array<{ label: string }> };
        expect(body.tokens.map((t) => t.label)).toEqual(['new', 'mid', 'old']);
    });

    it('includes revoked tokens with revokedTs set', async () => {
        const sessionCookie = await loginAs('google');
        const mint = await authenticatedRequest(app, { method: 'POST', path: '/account/tokens', sessionCookie, body: { label: 'x' } });
        const { id } = (await mint.json()) as { id: string };
        await authenticatedRequest(app, { method: 'DELETE', path: `/account/tokens/${id}`, sessionCookie });

        const list = await authenticatedRequest(app, { method: 'GET', path: '/account/tokens', sessionCookie });
        const body = (await list.json()) as { tokens: Array<{ id: string; revokedTs?: string }> };
        expect(body.tokens).toHaveLength(1);
        expect(body.tokens[0]!.revokedTs).toBeTruthy();
    });
});

describe('DELETE /account/tokens/:id', () => {
    it('revokes a token; subsequent /v1 calls with that token return 401', async () => {
        const sessionCookie = await loginAs('google');
        const mint = await authenticatedRequest(app, { method: 'POST', path: '/account/tokens', sessionCookie, body: { label: 'live' } });
        const { id, plaintext } = (await mint.json()) as { id: string; plaintext: string };

        // Confirm token works pre-revoke.
        const before = await app.fetch(new Request('http://localhost:4000/v1/items', { headers: { Authorization: `Bearer ${plaintext}` } }));
        expect(before.status).toBe(200);

        const del = await authenticatedRequest(app, { method: 'DELETE', path: `/account/tokens/${id}`, sessionCookie });
        expect(del.status).toBe(200);

        const after = await app.fetch(new Request('http://localhost:4000/v1/items', { headers: { Authorization: `Bearer ${plaintext}` } }));
        expect(after.status).toBe(401);

        // Hash row should still exist with revokedTs set, so authentication can check it.
        const row = await apiTokensDAO.findOne({ tokenHash: hashToken(plaintext) });
        expect(row?.revokedTs).toBeTruthy();
    });

    it('is idempotent: revoking an already-revoked token still returns 200', async () => {
        const sessionCookie = await loginAs('google');
        const mint = await authenticatedRequest(app, { method: 'POST', path: '/account/tokens', sessionCookie, body: { label: 'idem' } });
        const { id } = (await mint.json()) as { id: string };
        const first = await authenticatedRequest(app, { method: 'DELETE', path: `/account/tokens/${id}`, sessionCookie });
        const second = await authenticatedRequest(app, { method: 'DELETE', path: `/account/tokens/${id}`, sessionCookie });
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
    });

    it('returns 404 when revoking a token belonging to another user', async () => {
        const aliceCookie = await loginAs('google');
        const aliceMint = await authenticatedRequest(app, { method: 'POST', path: '/account/tokens', sessionCookie: aliceCookie, body: { label: 'alice' } });
        const { id: aliceTokenId } = (await aliceMint.json()) as { id: string };

        const bobCookie = await loginAs('github', { email: 'bob@example.com', login: 'bob-gh' });
        const bobAttempt = await authenticatedRequest(app, { method: 'DELETE', path: `/account/tokens/${aliceTokenId}`, sessionCookie: bobCookie });
        expect(bobAttempt.status).toBe(404);

        // Alice's token must still be active.
        const aliceList = await authenticatedRequest(app, { method: 'GET', path: '/account/tokens', sessionCookie: aliceCookie });
        const body = (await aliceList.json()) as { tokens: Array<{ revokedTs?: string }> };
        expect(body.tokens[0]!.revokedTs).toBeUndefined();
    });

    it('returns 404 for an unknown token id', async () => {
        const sessionCookie = await loginAs('google');
        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/account/tokens/00000000-0000-0000-0000-000000000000',
            sessionCookie,
        });
        expect(res.status).toBe(404);
    });
});
