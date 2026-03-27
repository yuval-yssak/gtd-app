/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

// Build the test app the same way as index.ts — auth is a live ESM binding, safe after loadDataAccess()
const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await db.collection('user').deleteMany({});
    await db.collection('session').deleteMany({});
    await db.collection('account').deleteMany({});
    await db.collection('verification').deleteMany({});
    vi.restoreAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /auth/sign-in/social — initiate', () => {
    it('returns Google OAuth URL with required params', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/auth/sign-in/social', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: 'google', callbackURL: 'http://localhost:4173' }),
            }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { url: string; redirect: boolean };
        expect(body.redirect).toBe(true);
        const url = new URL(body.url);
        expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(url.searchParams.get('client_id')).toBeTruthy();
        expect(url.searchParams.get('state')).toBeTruthy();
        expect(url.searchParams.get('scope')).toContain('email');
    });

    it('returns GitHub OAuth URL with required params', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/auth/sign-in/social', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: 'github', callbackURL: 'http://localhost:4173' }),
            }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { url: string; redirect: boolean };
        const url = new URL(body.url);
        expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
        expect(url.searchParams.get('state')).toBeTruthy();
    });
});

describe('OAuth callback — new user', () => {
    it('Google: creates user + account docs, sets session cookie, redirects to client', async () => {
        const { res, sessionCookie } = await oauthLogin(app, 'google');

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('http://localhost:4173');
        expect(sessionCookie).toBeTruthy();

        const users = await db.collection('user').find({ email: 'alice@example.com' }).toArray();
        expect(users).toHaveLength(1);
        const accounts = await db.collection('account').find({ providerId: 'google' }).toArray();
        expect(accounts).toHaveLength(1);
    });

    it('GitHub: creates user + account docs, sets session cookie', async () => {
        const { res, sessionCookie } = await oauthLogin(app, 'github');

        expect(res.status).toBe(302);
        expect(sessionCookie).toBeTruthy();
        const users = await db.collection('user').find({ email: 'alice-gh@example.com' }).toArray();
        expect(users).toHaveLength(1);
    });
});

describe('OAuth callback — existing user', () => {
    it('does not duplicate user on second Google login; same userId in both sessions', async () => {
        const { sessionCookie: cookie1 } = await oauthLogin(app, 'google');
        vi.restoreAllMocks();
        const { sessionCookie: cookie2 } = await oauthLogin(app, 'google');

        const s1 = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${cookie1}` } }));
        const s2 = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${cookie2}` } }));
        const { user: u1 } = (await s1.json()) as { user: { id: string } };
        const { user: u2 } = (await s2.json()) as { user: { id: string } };
        expect(u1.id).toBe(u2.id);

        const users = await db.collection('user').find({}).toArray();
        expect(users).toHaveLength(1);
    });
});

describe('Account linking', () => {
    it('GitHub login with same email as Google user → same userId, two account docs', async () => {
        const { sessionCookie: googleCookie } = await oauthLogin(app, 'google');
        vi.restoreAllMocks();
        const { sessionCookie: githubCookie } = await oauthLogin(app, 'github', { email: 'alice@example.com' });

        const s1 = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${googleCookie}` } }));
        const s2 = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${githubCookie}` } }));
        const { user: u1 } = (await s1.json()) as { user: { id: string } };
        const { user: u2 } = (await s2.json()) as { user: { id: string } };
        expect(u1.id).toBe(u2.id);

        expect(await db.collection('user').countDocuments()).toBe(1);
        const accounts = await db.collection('account').find({}).toArray();
        expect(accounts.map((a) => a.providerId)).toContain('google');
        expect(accounts.map((a) => a.providerId)).toContain('github');
    });

    it('GitHub login with different email → two separate user docs', async () => {
        await oauthLogin(app, 'google');
        vi.restoreAllMocks();
        await oauthLogin(app, 'github', { email: 'bob@example.com', login: 'bob-gh' });

        expect(await db.collection('user').countDocuments()).toBe(2);
    });
});

describe('GET /auth/get-session', () => {
    it('returns user object when session cookie is valid', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        vi.restoreAllMocks();

        const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
        expect(res.status).toBe(200);
        const { user } = (await res.json()) as { user: { email: string } };
        expect(user.email).toBe('alice@example.com');
    });

    it('returns null when no session cookie', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/auth/get-session'));
        expect(res.status).toBe(200);
        expect(await res.json()).toBeNull();
    });
});

describe('POST /auth/sign-out', () => {
    it('clears session cookie and removes session from DB', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        vi.restoreAllMocks();

        expect(await db.collection('session').countDocuments()).toBe(1);

        const res = await app.fetch(
            new Request('http://localhost:4000/auth/sign-out', {
                method: 'POST',
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(res.status).toBe(200);
        expect(await db.collection('session').countDocuments()).toBe(0);
    });
});
