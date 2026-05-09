/** Identity-only endpoint that returns the authenticated caller's userId + token label. The
 * primary consumer is the local MCP server, which uses it to translate an account-label slug
 * into the userId expected by /v1/reassign — so the model never has to know raw UUIDs. */
/** biome-ignore-all lint/style/noNonNullAssertion: tests assert preconditions before using ! */
import { Hono } from 'hono';
import { ObjectId } from 'mongodb';
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
    it('returns the userId, label, and email of the authenticated caller', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 'work-laptop', ['items.read']);
        const res = await app.fetch(new Request('http://localhost:4000/v1/me', { headers: { Authorization: `Bearer ${plaintext}` } }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { userId: string; label: string; email: string };
        expect(body.userId).toBe(userId);
        expect(body.label).toBe('work-laptop');
        // Helpers' GOOGLE_PROFILE.email — the Better Auth user row Better Auth created on first sign-in.
        expect(body.email).toBe('alice@example.com');
    });

    it('returns email:"" and 200 when the user row was deleted out from under a still-valid token', async () => {
        // Defensive: the bearer middleware already validated the userId, but if the user row is
        // gone (manual cleanup, account deletion mid-flight), /v1/me should still return a stable
        // shape rather than 500.
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 'orphan', ['items.read']);
        // Better Auth's mongodbAdapter keys `user._id` as ObjectId whose hex equals `userId`.
        await db.collection('user').deleteOne({ _id: new ObjectId(userId) } as never);
        const res = await app.fetch(new Request('http://localhost:4000/v1/me', { headers: { Authorization: `Bearer ${plaintext}` } }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { userId: string; label: string; email: string };
        expect(body.userId).toBe(userId);
        expect(body.label).toBe('orphan');
        expect(body.email).toBe('');
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
