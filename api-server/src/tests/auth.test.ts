/** biome-ignore-all lint/style/noNonNullAssertion: we mock them */
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authConfig } from '../config.js';
import refreshTokensDAO from '../dataAccess/refreshTokensDAO.js';
import usersDAO from '../dataAccess/usersDAO.js';
import { closeDataAccess, loadDataAccess } from '../loaders/mainLoader.js';
import { authRoutes } from '../routes/auth.js';
import { githubRoutes } from '../routes/authGitHub.js';

// GitHubEmailEntry is not exported from authGitHub.ts, so define it here
type GitHubEmailEntry = { email: string; primary: boolean; verified: boolean; visibility: string | null };

// Mirrors the JWT payload shape produced by signAccessToken
type AccessTokenPayload = { contents: { id: string; email: string }[] };

const app = new Hono().route('/auth', authRoutes).route('/auth/github', githubRoutes);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract a cookie value from the Set-Cookie headers of a Response. */
function getCookieValue(response: Response, name: string): string | undefined {
    for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const [key, value] = pair.split('=');
        if (key?.trim() === name) return value?.trim();
    }
    return undefined;
}

/** Build a Cookie request header string from name→value pairs. */
function cookieHeader(pairs: Record<string, string>): string {
    return Object.entries(pairs)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

/** Assert that a Set-Cookie header clears the named cookie (value empty, Max-Age=0). */
function assertCookieCleared(response: Response, name: string) {
    // Hono's deleteCookie sets value="" and Max-Age=0, producing `name=; ...; Max-Age=0`
    const cleared = response.headers.getSetCookie().some((h) => h.startsWith(`${name}=;`) && h.includes('Max-Age=0'));
    expect(cleared, `expected ${name} cookie to be cleared`).toBe(true);
}

// ─── Default OAuth mock data ──────────────────────────────────────────────────

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
};

const GITHUB_PROFILE = {
    id: 100,
    login: 'alice-gh',
    name: 'Alice GitHub',
    email: 'alice-gh@example.com',
    avatar_url: 'https://avatars.test/alice',
};

const GITHUB_TOKEN = { access_token: 'gh-at', scope: 'user:email', token_type: 'bearer' };

/**
 * Spy on globalThis.fetch and stub responses for each OAuth provider URL.
 * Any unexpected URL throws so tests fail loudly rather than silently hitting real APIs.
 * Uses spyOn (not stubGlobal) so vi.restoreAllMocks() in beforeEach can undo it cleanly.
 */
function mockOAuth({
    googleToken = GOOGLE_TOKEN,
    googleProfile = GOOGLE_PROFILE,
    githubToken = GITHUB_TOKEN,
    githubProfile = GITHUB_PROFILE,
    githubEmails = [] as GitHubEmailEntry[],
} = {}) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = input.toString();
        if (url === 'https://oauth2.googleapis.com/token') return Response.json(googleToken);
        if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') return Response.json(googleProfile);
        if (url === 'https://github.com/login/oauth/access_token') return Response.json(githubToken);
        if (url === 'https://api.github.com/user') return Response.json(githubProfile);
        if (url === 'https://api.github.com/user/emails') return Response.json(githubEmails);
        throw new Error(`Unexpected fetch to ${url}`);
    });
}

// ─── Login helpers ────────────────────────────────────────────────────────────

async function googleLogin(profileOverrides: Partial<typeof GOOGLE_PROFILE> = {}) {
    mockOAuth({ googleProfile: { ...GOOGLE_PROFILE, ...profileOverrides } });
    const res = await app.fetch(new Request('http://localhost/auth/google/callback?code=test-code'));
    return {
        res,
        accessToken: getCookieValue(res, 'accessToken'),
        refreshToken: getCookieValue(res, 'refreshToken'),
    };
}

async function githubLogin(profileOverrides: Partial<typeof GITHUB_PROFILE> = {}) {
    mockOAuth({ githubProfile: { ...GITHUB_PROFILE, ...profileOverrides } });
    const res = await app.fetch(new Request('http://localhost/auth/github/callback?code=test-code'));
    return {
        res,
        accessToken: getCookieValue(res, 'accessToken'),
        refreshToken: getCookieValue(res, 'refreshToken'),
    };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await usersDAO.deleteAll();
    await refreshTokensDAO.deleteAll();
    vi.restoreAllMocks(); // clear fetch spy between tests
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /auth/google — redirect', () => {
    it('redirects to Google OAuth URL with required params', async () => {
        const res = await app.fetch(new Request('http://localhost/auth/google'));
        expect(res.status).toBe(302);
        const url = new URL(res.headers.get('location')!);
        expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(url.searchParams.get('client_id')).toBeTruthy();
        expect(url.searchParams.get('redirect_uri')).toBeTruthy();
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('scope')).toBe('openid email profile');
    });
});

describe('GET /auth/google/callback — new user', () => {
    it('creates user document, sets both cookies, redirects to clientUrl', async () => {
        mockOAuth();
        const res = await app.fetch(new Request('http://localhost/auth/google/callback?code=test-code'));

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBeTruthy();

        const users = await usersDAO.findArray({ email: 'alice@example.com' });
        expect(users).toHaveLength(1);
        expect(users[0]!.firstName).toBe('Alice');
        expect(users[0]!.lastName).toBe('Smith');
        expect(users[0]!.tokens).toHaveLength(1);
        expect(users[0]!.tokens[0]!.provider).toBe('google');

        expect(getCookieValue(res, 'accessToken')).toBeTruthy();
        expect(getCookieValue(res, 'refreshToken')).toBeTruthy();

        const rtDocs = await refreshTokensDAO.findArray();
        expect(rtDocs).toHaveLength(1);
    });
});

describe('GET /auth/google/callback — existing user', () => {
    it('does not duplicate user; issues JWT with same _id; replaces provider token', async () => {
        // First login
        mockOAuth();
        const res1 = await app.fetch(new Request('http://localhost/auth/google/callback?code=code-1'));
        const at1 = getCookieValue(res1, 'accessToken')!;
        const {
            contents: [{ id: userId1 }],
        } = jwt.verify(at1, authConfig.jwtSecret) as AccessTokenPayload;

        // Second login — same user, new access_token from Google
        vi.restoreAllMocks();
        mockOAuth({ googleToken: { ...GOOGLE_TOKEN, access_token: 'goog-at-2' } });
        const res2 = await app.fetch(new Request('http://localhost/auth/google/callback?code=code-2'));
        const at2 = getCookieValue(res2, 'accessToken')!;
        const {
            contents: [{ id: userId2 }],
        } = jwt.verify(at2, authConfig.jwtSecret) as AccessTokenPayload;

        expect(userId2).toBe(userId1);

        const users = await usersDAO.findArray();
        expect(users).toHaveLength(1);
        // tokens[] still has only one entry (pull-then-push replaces, not appends)
        expect(users[0].tokens).toHaveLength(1);
        expect(users[0].tokens[0].provider).toBe('google');
    });
});

describe('GET /auth/google/callback — errors', () => {
    it('returns 400 when code is missing', async () => {
        const res = await app.fetch(new Request('http://localhost/auth/google/callback'));
        expect(res.status).toBe(400);
    });

    it('returns 500 when Google token exchange returns non-OK status', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            if (input.toString() === 'https://oauth2.googleapis.com/token') return new Response('fail', { status: 500 });
            throw new Error(`Unexpected fetch to ${input}`);
        });
        const res = await app.fetch(new Request('http://localhost/auth/google/callback?code=bad'));
        expect(res.status).toBe(500);
    });
});

describe('GET /auth/github — redirect', () => {
    it('redirects to GitHub OAuth URL with required params', async () => {
        const res = await app.fetch(new Request('http://localhost/auth/github'));
        expect(res.status).toBe(302);
        const url = new URL(res.headers.get('location')!);
        expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
        expect(url.searchParams.get('client_id')).toBeDefined();
        expect(url.searchParams.get('redirect_uri')).toBeTruthy();
        expect(url.searchParams.get('scope')).toBe('user:email');
    });
});

describe('GET /auth/github/callback — new user (email on user object)', () => {
    it('creates user, sets cookies, redirects', async () => {
        mockOAuth();
        const res = await app.fetch(new Request('http://localhost/auth/github/callback?code=test-code'));

        expect(res.status).toBe(302);
        const users = await usersDAO.findArray({ email: 'alice-gh@example.com' });
        expect(users).toHaveLength(1);
        expect(getCookieValue(res, 'accessToken')).toBeTruthy();
        expect(getCookieValue(res, 'refreshToken')).toBeTruthy();
    });
});

describe('GET /auth/github/callback — private email fallback', () => {
    it('calls /user/emails when profile.email is null and uses primary verified email', async () => {
        const emailsSpy = vi.fn().mockResolvedValue(Response.json([{ email: 'priv@example.com', primary: true, verified: true, visibility: null }]));

        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = input.toString();
            if (url === 'https://github.com/login/oauth/access_token') return Response.json(GITHUB_TOKEN);
            if (url === 'https://api.github.com/user') return Response.json({ ...GITHUB_PROFILE, email: null });
            if (url === 'https://api.github.com/user/emails') return emailsSpy();
            throw new Error(`Unexpected fetch to ${url}`);
        });

        const res = await app.fetch(new Request('http://localhost/auth/github/callback?code=test-code'));
        expect(res.status).toBe(302);
        expect(emailsSpy).toHaveBeenCalledOnce();

        const users = await usersDAO.findArray({ email: 'priv@example.com' });
        expect(users).toHaveLength(1);
    });
});

describe('GET /auth/github/callback — errors', () => {
    it('returns 400 when code is missing', async () => {
        const res = await app.fetch(new Request('http://localhost/auth/github/callback'));
        expect(res.status).toBe(400);
    });
});

describe('Account linking', () => {
    it('GitHub login with same email as Google user → same _id, both providers in tokens[]', async () => {
        const { accessToken: at1 } = await googleLogin();
        const {
            contents: [{ id: userId1 }],
        } = jwt.verify(at1!, authConfig.jwtSecret) as AccessTokenPayload;

        vi.restoreAllMocks();

        // GitHub login for the same email address
        const { accessToken: at2 } = await githubLogin({ email: 'alice@example.com' });
        const {
            contents: [{ id: userId2 }],
        } = jwt.verify(at2!, authConfig.jwtSecret) as AccessTokenPayload;

        expect(userId2).toBe(userId1);

        const users = await usersDAO.findArray();
        expect(users).toHaveLength(1);

        const providers = users[0].tokens.map((t) => t.provider);
        expect(providers).toContain('google');
        expect(providers).toContain('github');
    });

    it('GitHub login with different email → two separate user documents', async () => {
        await googleLogin(); // alice@example.com
        vi.restoreAllMocks();
        await githubLogin({ email: 'bob@example.com', login: 'bob-gh' });

        const users = await usersDAO.findArray();
        expect(users).toHaveLength(2);
    });
});

describe('GET /auth/check', () => {
    it('returns 200 with user payload when access token is valid', async () => {
        const { accessToken } = await googleLogin();
        const res = await app.fetch(
            new Request('http://localhost/auth/check', {
                headers: { Cookie: cookieHeader({ accessToken: accessToken! }) },
            }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as AccessTokenPayload;
        expect(body.contents[0].email).toBe('alice@example.com');
    });

    it('returns 401 when no cookie is sent', async () => {
        const res = await app.fetch(new Request('http://localhost/auth/check'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when token is tampered/invalid', async () => {
        const res = await app.fetch(
            new Request('http://localhost/auth/check', {
                headers: { Cookie: 'accessToken=bogus.token.here' },
            }),
        );
        expect(res.status).toBe(403);
    });
});

describe('POST /auth/refresh', () => {
    it('issues new cookies and removes old refresh token from DB', async () => {
        const { accessToken, refreshToken } = await googleLogin();

        const res = await app.fetch(
            new Request('http://localhost/auth/refresh', {
                method: 'POST',
                headers: { Cookie: cookieHeader({ accessToken: accessToken!, refreshToken: refreshToken! }) },
            }),
        );

        expect(res.status).toBe(200);

        const newAt = getCookieValue(res, 'accessToken');
        const newRt = getCookieValue(res, 'refreshToken');
        expect(newAt).toBeTruthy();
        expect(newRt).toBeTruthy();
        expect(newRt).not.toBe(refreshToken); // token was rotated

        const oldInDb = await refreshTokensDAO.findArray({ token: refreshToken! });
        expect(oldInDb).toHaveLength(0);

        const newInDb = await refreshTokensDAO.findArray({ token: newRt! });
        expect(newInDb).toHaveLength(1);
    });

    it('returns 401 when no refresh token cookie', async () => {
        const res = await app.fetch(new Request('http://localhost/auth/refresh', { method: 'POST' }));
        expect(res.status).toBe(401);
    });

    it('returns 401 when refresh token is not in DB', async () => {
        const res = await app.fetch(
            new Request('http://localhost/auth/refresh', {
                method: 'POST',
                headers: { Cookie: 'refreshToken=not-in-db' },
            }),
        );
        expect(res.status).toBe(401);
    });
});

describe('POST /auth/sign-out', () => {
    it('deletes refresh token from DB and clears both cookies', async () => {
        const { accessToken, refreshToken } = await googleLogin();

        const res = await app.fetch(
            new Request('http://localhost/auth/sign-out', {
                method: 'POST',
                headers: { Cookie: cookieHeader({ accessToken: accessToken!, refreshToken: refreshToken! }) },
            }),
        );

        expect(res.status).toBe(200);

        const rtDocs = await refreshTokensDAO.findArray({ token: refreshToken! });
        expect(rtDocs).toHaveLength(0);

        assertCookieCleared(res, 'accessToken');
        assertCookieCleared(res, 'refreshToken');
    });

    it('returns 200 gracefully when no cookies are present', async () => {
        const res = await app.fetch(new Request('http://localhost/auth/sign-out', { method: 'POST' }));
        expect(res.status).toBe(200);
    });
});

describe('POST /auth/sign-out-all', () => {
    it('deletes all sessions for the user and clears cookies', async () => {
        // Two logins → two refresh token rows for the same user
        await googleLogin();
        vi.restoreAllMocks();
        const { accessToken: at2, refreshToken: rt2 } = await googleLogin();

        const before = await refreshTokensDAO.findArray();
        expect(before).toHaveLength(2);

        const res = await app.fetch(
            new Request('http://localhost/auth/sign-out-all', {
                method: 'POST',
                headers: { Cookie: cookieHeader({ accessToken: at2!, refreshToken: rt2! }) },
            }),
        );

        expect(res.status).toBe(200);

        const after = await refreshTokensDAO.findArray();
        expect(after).toHaveLength(0);

        assertCookieCleared(res, 'accessToken');
        assertCookieCleared(res, 'refreshToken');
    });
});
