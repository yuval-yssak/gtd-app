import { Buffer } from 'node:buffer';
import { expect, vi } from 'vitest';
// Imported and re-exported under SESSION_COOKIE so call sites in this file and test files are unchanged
import { SESSION_COOKIE_NAME as SESSION_COOKIE } from '../auth/constants.js';

export { SESSION_COOKIE };

// Minimal interface so helpers work with any Hono app variant without importing Hono types.
// Hono's fetch() is typed as Response | Promise<Response>, so we mirror that here.
// All call sites use await, which handles both cases transparently.
interface FetchApp {
    fetch: (request: Request) => Response | Promise<Response>;
}

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

export const GOOGLE_PROFILE = {
    id: 'g1',
    email: 'alice@example.com',
    verified_email: true,
    name: 'Alice Smith',
    given_name: 'Alice',
    family_name: 'Smith',
    picture: 'https://pic.test/alice',
};

export const GOOGLE_TOKEN = {
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

export const GITHUB_PROFILE = {
    id: 100,
    login: 'alice-gh',
    name: 'Alice GitHub',
    email: 'alice-gh@example.com',
    avatar_url: 'https://avatars.test/alice',
};

export const GITHUB_TOKEN = { access_token: 'gh-at', scope: 'user:email', token_type: 'bearer' };

export function mockGoogleOAuth({ token = GOOGLE_TOKEN, profile = GOOGLE_PROFILE } = {}) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = input.toString();
        if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json(token);
        if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return Response.json(profile);
        if (url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) return Response.json(profile);
        throw new Error(`Unexpected fetch to ${url}`);
    });
}

export function mockGitHubOAuth({ token = GITHUB_TOKEN, profile = GITHUB_PROFILE } = {}) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = input.toString();
        if (url.startsWith('https://github.com/login/oauth/access_token')) return Response.json(token);
        if (url.startsWith('https://api.github.com/user/emails')) return Response.json([]);
        if (url.startsWith('https://api.github.com/user')) return Response.json(profile);
        throw new Error(`Unexpected fetch to ${url}`);
    });
}

export function getCookieValue(response: Response, name: string): string | undefined {
    for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const [key, value] = pair?.split('=') ?? [];
        if (key?.trim() === name) return value?.trim();
    }
    return undefined;
}

/** Collect all Set-Cookie pairs as a single Cookie header string for use in follow-up requests. */
export function collectCookies(response: Response): string {
    return response.headers
        .getSetCookie()
        .map((h) => h.split(';')[0])
        .join('; ');
}

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
export async function oauthLogin(app: FetchApp, provider: 'google' | 'github', profileOverrides: Record<string, unknown> = {}) {
    const signInRes = await app.fetch(
        new Request('http://localhost:4000/auth/sign-in/social', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, callbackURL: 'http://localhost:4173' }),
        }),
    );
    expect(signInRes.status).toBe(200);

    const { url } = (await signInRes.json()) as { url: string };
    const state = new URL(url).searchParams.get('state');
    const stateCookies = collectCookies(signInRes);

    if (provider === 'google') {
        mockGoogleOAuth({ profile: { ...GOOGLE_PROFILE, ...profileOverrides } });
    } else {
        mockGitHubOAuth({ profile: { ...GITHUB_PROFILE, ...profileOverrides } });
    }

    const callbackRes = await app.fetch(
        new Request(`http://localhost:4000/auth/callback/${provider}?code=test-code&state=${state}`, {
            headers: { Cookie: stateCookies },
        }),
    );

    return { res: callbackRes, sessionCookie: getCookieValue(callbackRes, SESSION_COOKIE) };
}

interface AuthRequestOptions {
    method: string;
    path: string;
    sessionCookie: string;
    body?: unknown;
}

/** Convenience wrapper for making authenticated requests with a session cookie. */
export async function authenticatedRequest(app: FetchApp, { method, path, sessionCookie, body }: AuthRequestOptions): Promise<Response> {
    return app.fetch(
        new Request(`http://localhost:4000${path}`, {
            method,
            headers: {
                Cookie: `${SESSION_COOKIE}=${sessionCookie}`,
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
    );
}
