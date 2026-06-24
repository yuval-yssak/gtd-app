/**
 * OAuth 2.1 Authorization Server tests for the remote MCP flow. Covers the security-critical paths:
 * the PKCE S256 RFC-7636 vector, the full register → authorize(session) → token(code+PKCE) exchange,
 * code replay, refresh rotation + reuse-family-revocation, redirect_uri open-redirect rejection, and
 * the AS/RS metadata document shapes. Boots the real app against the PID-namespaced test Mongo.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import { pkceS256Challenge, verifyPkceS256 } from '../lib/mcpOAuth.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { mcpRoutes } from '../routes/mcp.js';
import { authorizationServerMetadata, mcpOAuthRoutes, protectedResourceMetadata } from '../routes/mcpOAuth.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const ORIGIN = 'http://localhost:4000';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata()))
    .get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata()))
    .route('/mcp-oauth', mcpOAuthRoutes)
    .route('/mcp', mcpRoutes);

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
        db.collection('oauthClients').deleteMany({}),
        db.collection('oauthAuthCodes').deleteMany({}),
        db.collection('oauthRefreshTokens').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

async function loginCookie(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    if (!sessionCookie) throw new Error('expected a session cookie from oauthLogin');
    return sessionCookie;
}

async function registerClient(redirectUris: string[] = [REDIRECT_URI]): Promise<string> {
    const res = await app.fetch(
        new Request(`${ORIGIN}/mcp-oauth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'Test MCP Client' }),
        }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; token_endpoint_auth_method: string };
    expect(body.token_endpoint_auth_method).toBe('none'); // public client by default
    return body.client_id;
}

/** Drives /authorize (logged in) → /authorize/decision(allow) and returns the issued `code`. */
async function authorizeAndConsent(clientId: string, sessionCookie: string, challenge: string, state = 'xyz'): Promise<string> {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'items.read items.write',
        state,
    });
    const decisionForm = new URLSearchParams(params);
    decisionForm.set('decision', 'allow');
    const res = await app.fetch(
        new Request(`${ORIGIN}/mcp-oauth/authorize/decision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            body: decisionForm.toString(),
            redirect: 'manual',
        }),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    if (!location) throw new Error('expected a redirect with the authorization code');
    const redirected = new URL(location);
    expect(redirected.searchParams.get('state')).toBe(state);
    const code = redirected.searchParams.get('code');
    if (!code) throw new Error('expected a code on the redirect');
    return code;
}

async function exchangeCode(clientId: string, code: string, verifier: string) {
    return app.fetch(
        new Request(`${ORIGIN}/mcp-oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                client_id: clientId,
                redirect_uri: REDIRECT_URI,
                code_verifier: verifier,
            }).toString(),
        }),
    );
}

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'; // 43 chars
const CHALLENGE = pkceS256Challenge(VERIFIER);

describe('PKCE S256', () => {
    it('matches the RFC 7636 appendix B test vector', () => {
        expect(pkceS256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });
    it('rejects a too-short verifier and a wrong verifier', () => {
        expect(verifyPkceS256('short', CHALLENGE)).toBe(false);
        expect(verifyPkceS256('a'.repeat(43), CHALLENGE)).toBe(false);
        expect(verifyPkceS256(VERIFIER, CHALLENGE)).toBe(true);
    });
});

describe('metadata documents', () => {
    it('advertises S256-only and the expected endpoints', async () => {
        const res = await app.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
        const meta = (await res.json()) as { code_challenge_methods_supported: string[]; authorization_endpoint: string; token_endpoint: string };
        expect(meta.code_challenge_methods_supported).toEqual(['S256']);
        expect(meta.authorization_endpoint).toMatch(/\/mcp-oauth\/authorize$/);
        expect(meta.token_endpoint).toMatch(/\/mcp-oauth\/token$/);

        const rsRes = await app.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`));
        const rs = (await rsRes.json()) as { resource: string; authorization_servers: string[] };
        expect(rs.resource).toMatch(/\/mcp$/);
        expect(rs.authorization_servers).toHaveLength(1);
    });
});

describe('authorization code grant', () => {
    it('completes register → authorize → token and mints a usable expiring access token', async () => {
        const clientId = await registerClient();
        const sessionCookie = await loginCookie();
        const code = await authorizeAndConsent(clientId, sessionCookie, CHALLENGE);

        const tokenRes = await exchangeCode(clientId, code, VERIFIER);
        expect(tokenRes.status).toBe(200);
        expect(tokenRes.headers.get('cache-control')).toBe('no-store');
        const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string };
        expect(tokens.token_type).toBe('Bearer');
        expect(tokens.access_token.startsWith('gtd_')).toBe(true);
        expect(tokens.refresh_token.length).toBeGreaterThan(20);
        expect(tokens.scope).toBe('items.read items.write');

        // The access token is a real apiTokens row tagged oauth_access with an expiry.
        const row = await apiTokensDAO.findActiveByHash(hashToken(tokens.access_token));
        expect(row?.kind).toBe('oauth_access');
        expect(row?.oauthClientId).toBe(clientId);
        expect(row?.expiresTs).toBeDefined();
    });

    it('rejects a replayed authorization code (single-use)', async () => {
        const clientId = await registerClient();
        const sessionCookie = await loginCookie();
        const code = await authorizeAndConsent(clientId, sessionCookie, CHALLENGE);

        expect((await exchangeCode(clientId, code, VERIFIER)).status).toBe(200);
        const replay = await exchangeCode(clientId, code, VERIFIER);
        expect(replay.status).toBe(400);
        expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('rejects a wrong PKCE verifier', async () => {
        const clientId = await registerClient();
        const sessionCookie = await loginCookie();
        const code = await authorizeAndConsent(clientId, sessionCookie, CHALLENGE);

        const res = await exchangeCode(clientId, code, 'wrong-verifier-that-is-at-least-forty-three-chars-x');
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    });
});

describe('refresh token grant', () => {
    async function getInitialTokens(clientId: string, sessionCookie: string) {
        const code = await authorizeAndConsent(clientId, sessionCookie, CHALLENGE);
        const res = await exchangeCode(clientId, code, VERIFIER);
        return (await res.json()) as { access_token: string; refresh_token: string };
    }

    function refresh(clientId: string, refreshToken: string) {
        return app.fetch(
            new Request(`${ORIGIN}/mcp-oauth/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
            }),
        );
    }

    it('rotates the refresh token and revokes the prior access token', async () => {
        const clientId = await registerClient();
        const sessionCookie = await loginCookie();
        const first = await getInitialTokens(clientId, sessionCookie);

        const res = await refresh(clientId, first.refresh_token);
        expect(res.status).toBe(200);
        const next = (await res.json()) as { access_token: string; refresh_token: string };
        expect(next.refresh_token).not.toBe(first.refresh_token);

        // Prior access token must be revoked after rotation.
        expect(await apiTokensDAO.findActiveByHash(hashToken(first.access_token))).toBeNull();
        // New access token authenticates.
        expect(await apiTokensDAO.findActiveByHash(hashToken(next.access_token))).not.toBeNull();
    });

    it('detects reuse: replaying a rotated refresh token revokes the family', async () => {
        const clientId = await registerClient();
        const sessionCookie = await loginCookie();
        const first = await getInitialTokens(clientId, sessionCookie);

        const rotated = (await (await refresh(clientId, first.refresh_token)).json()) as { access_token: string; refresh_token: string };

        // Reuse the ORIGINAL (now-rotated) refresh token → invalid_grant + family revoked.
        const reuse = await refresh(clientId, first.refresh_token);
        expect(reuse.status).toBe(400);
        expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant');
        // The access token minted by the rotation is revoked as part of family teardown.
        expect(await apiTokensDAO.findActiveByHash(hashToken(rotated.access_token))).toBeNull();
    });

    it('does NOT consume the refresh token on a wrong client_id (recoverable error)', async () => {
        const clientId = await registerClient();
        const sessionCookie = await loginCookie();
        const first = await getInitialTokens(clientId, sessionCookie);

        // Refresh with a bogus client_id → rejected, and the original token must remain usable.
        const bad = await refresh('not-the-real-client', first.refresh_token);
        expect(bad.status).toBe(400);
        const retry = await refresh(clientId, first.refresh_token);
        expect(retry.status).toBe(200);
    });

    it('rejects an expired refresh token and mints nothing', async () => {
        const clientId = await registerClient();
        const sessionCookie = await loginCookie();
        const first = await getInitialTokens(clientId, sessionCookie);

        // Force the refresh row past its expiry, then attempt a refresh.
        await db.collection('oauthRefreshTokens').updateOne({ _id: hashToken(first.refresh_token) }, { $set: { expiresTs: '2000-01-01T00:00:00.000Z' } });
        const res = await refresh(clientId, first.refresh_token);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    });
});

describe('open-redirect protection', () => {
    it('renders an error page (no redirect) for an unregistered redirect_uri', async () => {
        const clientId = await registerClient([REDIRECT_URI]);
        const sessionCookie = await loginCookie();
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: 'https://evil.example/callback',
            code_challenge: CHALLENGE,
            code_challenge_method: 'S256',
            scope: 'items.read',
        });
        const res = await app.fetch(
            new Request(`${ORIGIN}/mcp-oauth/authorize?${params.toString()}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
                redirect: 'manual',
            }),
        );
        expect(res.status).toBe(400);
        expect(res.headers.get('location')).toBeNull();
        expect(await res.text()).toContain('redirect_uri is not registered');
    });

    it('rejects DCR with a non-loopback http redirect_uri', async () => {
        const res = await app.fetch(
            new Request(`${ORIGIN}/mcp-oauth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    });
});

describe('authorize requires login', () => {
    it('renders the login page when there is no session', async () => {
        const clientId = await registerClient();
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: REDIRECT_URI,
            code_challenge: CHALLENGE,
            code_challenge_method: 'S256',
            scope: 'items.read',
        });
        const res = await app.fetch(new Request(`${ORIGIN}/mcp-oauth/authorize?${params.toString()}`));
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('Sign in with Google');
    });
});

describe('scope confinement', () => {
    it('confines the granted scope to a server-supported value even if the consent form requests an unknown scope', async () => {
        const clientId = await registerClient();
        const sessionCookie = await loginCookie();
        // Tamper the consent form: request a real scope plus an unsupported/elevated one.
        const decisionForm = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: REDIRECT_URI,
            code_challenge: CHALLENGE,
            code_challenge_method: 'S256',
            scope: 'items.read reassign webhooks.manage',
            state: 's',
            decision: 'allow',
        });
        const res = await app.fetch(
            new Request(`${ORIGIN}/mcp-oauth/authorize/decision`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
                body: decisionForm.toString(),
                redirect: 'manual',
            }),
        );
        expect(res.status).toBe(302);
        const code = new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';
        const tokens = (await (await exchangeCode(clientId, code, VERIFIER)).json()) as { scope: string };
        // reassign / webhooks.manage are not MCP-supported scopes → dropped; only items.read survives.
        expect(tokens.scope).toBe('items.read');
    });
});

describe('OAuth access-token expiry', () => {
    it('rejects an expired access token at /mcp with a 401', async () => {
        const clientId = await registerClient();
        const sessionCookie = await loginCookie();
        const code = await authorizeAndConsent(clientId, sessionCookie, CHALLENGE);
        const tokens = (await (await exchangeCode(clientId, code, VERIFIER)).json()) as { access_token: string };

        // Force the access-token row past its expiry, then hit /mcp.
        await db.collection('apiTokens').updateOne({ tokenHash: hashToken(tokens.access_token) }, { $set: { expiresTs: '2000-01-01T00:00:00.000Z' } });
        const res = await app.fetch(
            new Request(`${ORIGIN}/mcp`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
                }),
            }),
        );
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    });
});
