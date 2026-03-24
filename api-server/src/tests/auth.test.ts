/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';

// Build the test app the same way as index.ts — auth is a live ESM binding, safe after loadDataAccess()
const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

// ─── Cookie helpers ────────────────────────────────────────────────────────────

function getCookieValue(response: Response, name: string): string | undefined {
    for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const [key, value] = pair?.split('=') ?? [];
        if (key?.trim() === name) return value?.trim();
    }
    return undefined;
}

/** Collect all Set-Cookie pairs as a single Cookie header string for use in follow-up requests. */
function collectCookies(response: Response): string {
    return response.headers
        .getSetCookie()
        .map((h) => h.split(';')[0])
        .join('; ');
}

// No __Secure- prefix in dev (useSecureCookies is false when NODE_ENV !== 'production')
const SESSION_COOKIE = 'better-auth.session_token';

// ─── OAuth mock data ───────────────────────────────────────────────────────────

/**
 * Build a structurally valid but unsigned JWT (jose's decodeJwt validates format,
 * not the signature). Better Auth's Google provider calls decodeJwt(id_token) at
 * callback time, so the id_token must be a real three-part base64url string.
 */
function makeFakeIdToken(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${payload}.fake-sig`;
}

const GOOGLE_PROFILE = {
    id: 'g1',
    email: 'alice@example.com',
    verified_email: true,
    name: 'Alice Smith',
    given_name: 'Alice',
    family_name: 'Smith',
    picture: 'https://pic.test/alice',
};

const GOOGLE_TOKEN = {
    access_token: 'goog-at',
    expires_in: 3600,
    refresh_token: 'goog-rt',
    scope: 'openid email profile',
    token_type: 'Bearer',
    id_token: makeFakeIdToken({
        sub: 'g1',
        email: 'alice@example.com',
        email_verified: true,
        name: 'Alice Smith',
        picture: 'https://pic.test/alice',
        iat: 1700000000,
        exp: 9999999999,
    }),
};

const GITHUB_PROFILE = {
    id: 100,
    login: 'alice-gh',
    name: 'Alice GitHub',
    email: 'alice-gh@example.com',
    avatar_url: 'https://avatars.test/alice',
};

const GITHUB_TOKEN = { access_token: 'gh-at', scope: 'user:email', token_type: 'bearer' };

function mockOAuth({ googleToken = GOOGLE_TOKEN, googleProfile = GOOGLE_PROFILE, githubToken = GITHUB_TOKEN, githubProfile = GITHUB_PROFILE } = {}) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = input.toString();
        if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json(googleToken);
        // Better Auth fetches Google userinfo from openidconnect endpoint
        if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return Response.json(googleProfile);
        if (url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) return Response.json(googleProfile);
        if (url.startsWith('https://github.com/login/oauth/access_token')) return Response.json(githubToken);
        if (url.startsWith('https://api.github.com/user/emails')) return Response.json([]);
        if (url.startsWith('https://api.github.com/user')) return Response.json(githubProfile);
        throw new Error(`Unexpected fetch to ${url}`);
    });
}

// ─── Login helper ──────────────────────────────────────────────────────────────

/**
 * Full OAuth round-trip:
 *   1. POST /auth/sign-in/social → Better Auth returns JSON { url } + sets state cookies
 *   2. Extract state from the provider redirect URL in the response body
 *   3. Mock provider fetch calls
 *   4. GET /auth/callback/{provider}?code=...&state=... (carrying state cookies) → session cookie
 *
 * Better Auth stores OAuth state in a signed cookie + DB verification record, so the state
 * cookies from step 1 must be forwarded in step 4 or the callback will reject the state.
 */
async function oauthLogin(provider: 'google' | 'github', profileOverrides: Record<string, unknown> = {}) {
    const signInRes = await app.fetch(
        new Request('http://localhost:4000/auth/sign-in/social', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, callbackURL: 'http://localhost:4173' }),
        }),
    );
    expect(signInRes.status).toBe(200);

    const { url } = (await signInRes.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    const stateCookies = collectCookies(signInRes);

    if (provider === 'google') {
        mockOAuth({ googleProfile: { ...GOOGLE_PROFILE, ...profileOverrides } });
    } else {
        mockOAuth({ githubProfile: { ...GITHUB_PROFILE, ...profileOverrides } });
    }

    const callbackRes = await app.fetch(
        new Request(`http://localhost:4000/auth/callback/${provider}?code=test-code&state=${state}`, {
            headers: { Cookie: stateCookies },
        }),
    );

    return { res: callbackRes, sessionCookie: getCookieValue(callbackRes, SESSION_COOKIE) };
}

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
        const { res, sessionCookie } = await oauthLogin('google');

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('http://localhost:4173');
        expect(sessionCookie).toBeTruthy();

        const users = await db.collection('user').find({ email: 'alice@example.com' }).toArray();
        expect(users).toHaveLength(1);
        const accounts = await db.collection('account').find({ providerId: 'google' }).toArray();
        expect(accounts).toHaveLength(1);
    });

    it('GitHub: creates user + account docs, sets session cookie', async () => {
        const { res, sessionCookie } = await oauthLogin('github');

        expect(res.status).toBe(302);
        expect(sessionCookie).toBeTruthy();
        const users = await db.collection('user').find({ email: 'alice-gh@example.com' }).toArray();
        expect(users).toHaveLength(1);
    });
});

describe('OAuth callback — existing user', () => {
    it('does not duplicate user on second Google login; same userId in both sessions', async () => {
        const { sessionCookie: cookie1 } = await oauthLogin('google');
        vi.restoreAllMocks();
        const { sessionCookie: cookie2 } = await oauthLogin('google');

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
        const { sessionCookie: googleCookie } = await oauthLogin('google');
        vi.restoreAllMocks();
        const { sessionCookie: githubCookie } = await oauthLogin('github', { email: 'alice@example.com' });

        const s1 = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${googleCookie}` } }));
        const s2 = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${githubCookie}` } }));
        const { user: u1 } = (await s1.json()) as { user: { id: string } };
        const { user: u2 } = (await s2.json()) as { user: { id: string } };
        expect(u1.id).toBe(u2.id);

        expect(await db.collection('user').countDocuments()).toBe(1);
        const accounts = await db.collection('account').find({}).toArray();
        expect(accounts.map((a) => a['providerId'])).toContain('google');
        expect(accounts.map((a) => a['providerId'])).toContain('github');
    });

    it('GitHub login with different email → two separate user docs', async () => {
        await oauthLogin('google');
        vi.restoreAllMocks();
        await oauthLogin('github', { email: 'bob@example.com', login: 'bob-gh' });

        expect(await db.collection('user').countDocuments()).toBe(2);
    });
});

describe('GET /auth/get-session', () => {
    it('returns user object when session cookie is valid', async () => {
        const { sessionCookie } = await oauthLogin('google');
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
        const { sessionCookie } = await oauthLogin('google');
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
