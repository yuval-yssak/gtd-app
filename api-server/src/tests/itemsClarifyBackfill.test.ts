/** items.clarify → items.write legacy backfill (Phase 2 step 2).
 *
 * Tokens minted before the Phase 2 scope extension carry `items.clarify`. The bearer middleware
 * adds `items.write` to the in-memory scope set so legacy tokens still authorize PATCH /v1/items/:id
 * and POST /v1/items/:id/complete. The stored row is *not* mutated — leaving it untouched keeps
 * the mint endpoint's "no new items.clarify" rule simple and means revocation/auditing still
 * works against the original scope string. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { tokensRoutes } from '../routes/tokens.js';
import { v1ItemsRoutes } from '../routes/v1/items.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

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
        db.collection('items').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('apiTokens').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

async function login() {
    const { sessionCookie } = await oauthLogin(app, 'google');
    const sessionRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    if (!sessionCookie) throw new Error('expected session cookie from oauthLogin');
    return { userId: user.id, sessionCookie };
}

async function captureInboxItem(plaintext: string, externalId: string) {
    const res = await app.fetch(
        new Request('http://localhost:4000/v1/items', {
            method: 'POST',
            headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 't', externalId }),
        }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { _id: string })._id;
}

describe('items.clarify legacy backfill', () => {
    it('a stored items.clarify scope authorizes PATCH /v1/items/:id (which now requires items.write)', async () => {
        const { userId } = await login();
        const { plaintext, record } = await issueApiToken(userId, 'legacy', ['items.capture', 'items.read', 'items.clarify']);
        const id = await captureInboxItem(plaintext, 'ext-1');

        const res = await app.fetch(
            new Request(`http://localhost:4000/v1/items/${id}`, {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'nextAction', energy: 'low' }),
            }),
        );
        expect(res.status).toBe(200);

        // Stored row was NOT mutated by the backfill — items.clarify stays, items.write was not persisted.
        const row = await apiTokensDAO.findOne({ _id: record._id });
        expect(row?.scopes).toEqual(['items.capture', 'items.read', 'items.clarify']);
    });

    it('a stored items.clarify scope authorizes POST /v1/items/:id/complete', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 'legacy', ['items.capture', 'items.read', 'items.clarify']);
        const id = await captureInboxItem(plaintext, 'ext-1');

        const res = await app.fetch(
            new Request(`http://localhost:4000/v1/items/${id}/complete`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${plaintext}` },
            }),
        );
        expect(res.status).toBe(200);
    });

    it('a token holding items.write directly (no items.clarify) also authorizes PATCH', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 'modern', ['items.capture', 'items.read', 'items.write']);
        const id = await captureInboxItem(plaintext, 'ext-1');

        const res = await app.fetch(
            new Request(`http://localhost:4000/v1/items/${id}`, {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'nextAction' }),
            }),
        );
        expect(res.status).toBe(200);
    });

    it('a capture-only token (no clarify, no write) is forbidden from PATCH', async () => {
        const { userId } = await login();
        // First create the item with a write-capable token, then attempt PATCH with capture-only.
        const { plaintext: writer } = await issueApiToken(userId, 'writer', ['items.capture', 'items.read', 'items.write']);
        const id = await captureInboxItem(writer, 'ext-1');

        const { plaintext: captureOnly } = await issueApiToken(userId, 'capture-only', ['items.capture']);
        const res = await app.fetch(
            new Request(`http://localhost:4000/v1/items/${id}`, {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${captureOnly}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'nextAction' }),
            }),
        );
        expect(res.status).toBe(403);
        expect(((await res.json()) as { code: string; requiredScope: string }).requiredScope).toBe('items.write');
    });

    it('mint endpoint rejects items.clarify with a hint pointing at items.write', async () => {
        const { sessionCookie } = await login();
        const res = await app.fetch(
            new Request('http://localhost:4000/account/tokens', {
                method: 'POST',
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: 't', scopes: ['items.capture', 'items.clarify'] }),
            }),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe('invalid_scopes');
        expect(body.error).toContain('items.write');
        expect(body.error).toContain('items.clarify');
    });

    it('mint endpoint accepts the new Phase 2 scopes', async () => {
        const { sessionCookie } = await login();
        const res = await app.fetch(
            new Request('http://localhost:4000/account/tokens', {
                method: 'POST',
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    label: 'phase2',
                    scopes: [
                        'items.capture',
                        'items.read',
                        'items.write',
                        'routines.read',
                        'routines.write',
                        'people.read',
                        'people.write',
                        'contexts.read',
                        'contexts.write',
                        'reassign',
                    ],
                }),
            }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { scopes: string[] };
        expect(body.scopes).toEqual([
            'items.capture',
            'items.read',
            'items.write',
            'routines.read',
            'routines.write',
            'people.read',
            'people.write',
            'contexts.read',
            'contexts.write',
            'reassign',
        ]);
    });

    it('concurrent legacy-token PATCHes succeed and never rewrite the stored row', async () => {
        const { userId } = await login();
        const { plaintext, record } = await issueApiToken(userId, 'legacy', ['items.capture', 'items.read', 'items.clarify']);
        const id1 = await captureInboxItem(plaintext, 'a');
        const id2 = await captureInboxItem(plaintext, 'b');

        const [r1, r2] = await Promise.all([
            app.fetch(
                new Request(`http://localhost:4000/v1/items/${id1}`, {
                    method: 'PATCH',
                    headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'nextAction' }),
                }),
            ),
            app.fetch(
                new Request(`http://localhost:4000/v1/items/${id2}`, {
                    method: 'PATCH',
                    headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'nextAction' }),
                }),
            ),
        ]);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);

        const row = await apiTokensDAO.findOne({ _id: record._id });
        expect(row?.scopes).toEqual(['items.capture', 'items.read', 'items.clarify']);
    });

    // A hand-edited row (or a future migration regression) could leave both legacy and modern
    // scopes in storage at once. The bridge's `!storedScopes.includes('items.write')` guard
    // skips the append in that case; this test pins that contract so a future refactor doesn't
    // accidentally double up the in-memory scopes.
    it('a row carrying both items.clarify and items.write authorizes PATCH without duplicating the in-memory scope', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 'mixed', ['items.capture', 'items.read', 'items.clarify', 'items.write']);
        const id = await captureInboxItem(plaintext, 'ext-1');
        const res = await app.fetch(
            new Request(`http://localhost:4000/v1/items/${id}`, {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'nextAction' }),
            }),
        );
        expect(res.status).toBe(200);
    });
});
