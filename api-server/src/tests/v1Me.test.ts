/** Identity-only endpoint that returns the authenticated caller's userId + token label. The
 * primary consumer is the local MCP server, which uses it to translate an account-label slug
 * into the userId expected by /v1/reassign — so the model never has to know raw UUIDs. */
/** biome-ignore-all lint/style/noNonNullAssertion: tests assert preconditions before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1MeRoutes } from '../routes/v1/me.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/v1', v1MeRoutes);

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
        db.collection('apiTokens').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

async function login(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    const sessionRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    return user.id;
}

describe('GET /v1/me', () => {
    it('returns the userId and label of the authenticated caller', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 'work-laptop', ['items.read']);
        const res = await app.fetch(new Request('http://localhost:4000/v1/me', { headers: { Authorization: `Bearer ${plaintext}` } }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { userId: string; label: string };
        expect(body.userId).toBe(userId);
        expect(body.label).toBe('work-laptop');
    });

    it('returns 401 when no Authorization header is present', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/v1/me'));
        expect(res.status).toBe(401);
    });

    it('returns 401 for a garbage bearer token', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/v1/me', { headers: { Authorization: 'Bearer gtd_definitely-not-real' } }));
        expect(res.status).toBe(401);
    });
});
