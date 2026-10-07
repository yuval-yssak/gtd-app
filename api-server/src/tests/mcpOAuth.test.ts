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
import { APP_NAME } from '../lib/appName.js';
import { pkceS256Challenge, verifyPkceS256 } from '../lib/mcpOAuth.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { mcpRoutes } from '../routes/mcp.js';
import { authorizationServerMetadata, mcpOAuthRoutes, protectedResourceMetadata, withAccountChooser } from '../routes/mcpOAuth.js';
import { collectCookies, GOOGLE_PROFILE, GOOGLE_TOKEN, makeFakeIdToken, mockGoogleOAuth, oauthLogin, SESSION_COOKIE } from './helpers.js';

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

function authorizeQuery(clientId: string, { scope = 'items.read items.write', state = 'xyz', challenge = CHALLENGE } = {}) {
    return new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope,
        state,
    });
}

/** GET /authorize as a browser carrying `cookieHeader`; returns the rendered page. */
async function renderAuthorizePage(query: URLSearchParams, cookieHeader: string) {
    const res = await app.fetch(new Request(`${ORIGIN}/mcp-oauth/authorize?${query}`, { headers: { Cookie: cookieHeader } }));
    expect(res.status).toBe(200);
    return res.text();
}

/** The hidden fields of the consent page's Allow form — for `email` when the page lists several accounts. */
function allowFormFields(html: string, email?: string) {
    const forms = html.split('<form ').filter((form) => form.includes('name="decision" value="allow"'));
    const form = email ? forms.find((candidate) => candidate.includes(`data-account="${email}"`)) : forms[0];
    if (!form) {
        throw new Error(`expected an Allow form${email ? ` for ${email}` : ''}`);
    }
    // Only `&amp;` is decoded: the values here (ids, base64url tokens, URLs without quotes) never carry other entities.
    const fields = [...form.slice(0, form.indexOf('</form>')).matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)];
    return new URLSearchParams(fields.map(([, name = '', value = '']) => [name, value.replaceAll('&amp;', '&')]));
}

/** POST /authorize/decision as a same-origin browser form submission (unless `headers` says otherwise). */
async function postDecision(form: URLSearchParams, cookieHeader: string, headers: Record<string, string> = { 'Sec-Fetch-Site': 'same-origin' }) {
    return app.fetch(
        new Request(`${ORIGIN}/mcp-oauth/authorize/decision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader, ...headers },
            body: form.toString(),
            redirect: 'manual',
        }),
    );
}

/** The `code` on a successful decision's redirect back to the client. */
function issuedCode(res: Response, state = 'xyz') {
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    if (!location) {
        throw new Error('expected a redirect back to the client');
    }
    const redirected = new URL(location);
    expect(redirected.searchParams.get('state')).toBe(state);
    const code = redirected.searchParams.get('code');
    if (!code) {
        throw new Error('expected a code on the redirect');
    }
    return code;
}

/** Drives /authorize (logged in) → submits the rendered Allow form, like a browser, and returns the issued `code`. */
async function authorizeAndConsent(clientId: string, sessionCookie: string, challenge: string, state = 'xyz'): Promise<string> {
    const cookieHeader = `${SESSION_COOKIE}=${sessionCookie}`;
    const html = await renderAuthorizePage(authorizeQuery(clientId, { state, challenge }), cookieHeader);
    return issuedCode(await postDecision(allowFormFields(html), cookieHeader), state);
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

describe('sign-in and consent pages', () => {
    it('name the product, never the GTD mark, on the page a human sees', async () => {
        const clientId = await registerClient();
        const query = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: REDIRECT_URI,
            code_challenge: CHALLENGE,
            code_challenge_method: 'S256',
            scope: 'items.read',
            state: 'xyz',
        });
        const signedOut = await app.fetch(new Request(`${ORIGIN}/mcp-oauth/authorize?${query}`));
        expect(signedOut.status).toBe(200);
        const signInHtml = await signedOut.text();
        expect(signInHtml).toContain(`<h1>Sign in to ${APP_NAME}</h1>`);
        expect(signInHtml).not.toMatch(/\bGTD\b/);

        const sessionCookie = await loginCookie();
        const signedIn = await app.fetch(new Request(`${ORIGIN}/mcp-oauth/authorize?${query}`, { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
        expect(signedIn.status).toBe(200);
        const consentHtml = await signedIn.text();
        expect(consentHtml).toContain(`wants to access your ${APP_NAME} account`);
        expect(consentHtml).not.toMatch(/\bGTD\b/);
    });
});

describe('choosing the account to connect', () => {
    // Better Auth reads the Google identity from the id_token, so Bob needs his own token, not only a profile.
    const BOB_PROFILE = { ...GOOGLE_PROFILE, id: 'g2', email: 'bob@example.com', name: 'Bob Jones', given_name: 'Bob', family_name: 'Jones' };
    const BOB_TOKEN = {
        ...GOOGLE_TOKEN,
        id_token: makeFakeIdToken({ sub: 'g2', email: 'bob@example.com', email_verified: true, name: 'Bob Jones', iat: 1700000000, exp: 9999999999 }),
    };

    /** Merges cookie headers, later values winning per name — a minimal browser cookie jar. */
    function cookieJar(...headers: string[]) {
        const pairs = headers.flatMap((header) => header.split('; ')).filter((pair) => pair.includes('='));
        const byName = new Map(pairs.map((pair) => [pair.slice(0, pair.indexOf('=')), pair]));
        return [...byName.values()].join('; ');
    }

    /** POSTs a sign-in form from the Authorize/sign-in page; returns the provider redirect + the cookies it set. */
    async function startSignIn(query: URLSearchParams, cookieHeader: string, provider: 'google' | 'github' = 'google') {
        const form = new URLSearchParams(query);
        form.set('provider', provider);
        const res = await app.fetch(
            new Request(`${ORIGIN}/mcp-oauth/authorize/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader, 'Sec-Fetch-Site': 'same-origin' },
                body: form.toString(),
            }),
        );
        expect(res.status).toBe(302);
        const location = res.headers.get('location');
        if (!location) {
            throw new Error('expected a redirect to the provider');
        }
        return { providerUrl: new URL(location), cookies: collectCookies(res) };
    }

    /** Completes the Google callback as `token`'s user; returns the browser's cookie jar and where it lands. */
    async function finishGoogleSignIn(start: { providerUrl: URL; cookies: string }, jarBefore: string, token = GOOGLE_TOKEN) {
        mockGoogleOAuth({ token, profile: token === BOB_TOKEN ? BOB_PROFILE : GOOGLE_PROFILE });
        const callback = await app.fetch(
            new Request(`${ORIGIN}/auth/callback/google?code=test-code&state=${start.providerUrl.searchParams.get('state')}`, {
                headers: { Cookie: cookieJar(jarBefore, start.cookies) },
            }),
        );
        return { jar: cookieJar(jarBefore, collectCookies(callback)), returnTo: new URL(callback.headers.get('location') ?? '', ORIGIN) };
    }

    async function aliceJar() {
        const { res } = await oauthLogin(app, 'google');
        return collectCookies(res);
    }

    /** Alice signed in, then Bob added through the consent page's "Use a different account". */
    async function aliceThenBob(query: URLSearchParams) {
        const alice = await aliceJar();
        const start = await startSignIn(query, alice);
        return finishGoogleSignIn(start, alice, BOB_TOKEN);
    }

    it('a browser with no session completes sign-in and reaches the consent page', async () => {
        const clientId = await registerClient();
        const query = authorizeQuery(clientId);
        const start = await startSignIn(query, '');
        // Without the forwarded state cookie the callback fails with state_mismatch.
        expect(start.cookies).toContain('better-auth.state=');
        const { jar, returnTo } = await finishGoogleSignIn(start, '');
        expect(returnTo.pathname).toBe('/mcp-oauth/authorize');
        expect(await renderAuthorizePage(returnTo.searchParams, jar)).toContain('<code>alice@example.com</code>');
    });

    it('forces the provider account chooser for Google and GitHub', async () => {
        const query = authorizeQuery(await registerClient());
        const google = await startSignIn(query, '', 'google');
        expect(google.providerUrl.hostname).toBe('accounts.google.com');
        expect(google.providerUrl.searchParams.get('prompt')).toBe('select_account');
        const github = await startSignIn(query, '', 'github');
        expect(github.providerUrl.hostname).toBe('github.com');
        expect(github.providerUrl.searchParams.get('prompt')).toBe('select_account');
    });

    it('offers a different-account sign-in on the consent page', async () => {
        const html = await renderAuthorizePage(authorizeQuery(await registerClient()), await aliceJar());
        expect(html).toContain('<code>alice@example.com</code>');
        expect(html).toContain('data-testid="switchAccount"');
        expect(html).toContain('Use a different account with Google');
        expect(html).toContain('Use a different account with GitHub');
    });

    it('after signing in another account, the consent page offers both and mints for the one clicked', async () => {
        const clientId = await registerClient();
        const query = authorizeQuery(clientId);
        const { jar, returnTo } = await aliceThenBob(query);
        expect(returnTo.pathname).toBe('/mcp-oauth/authorize');
        const html = await renderAuthorizePage(returnTo.searchParams, jar);
        expect(html).toContain('Allow for alice@example.com');
        expect(html).toContain('Allow for bob@example.com');

        const code = issuedCode(await postDecision(allowFormFields(html, 'bob@example.com'), jar));
        const bob = await db.collection('user').findOne({ email: 'bob@example.com' });
        const codeRow = await db.collection('oauthAuthCodes').findOne({});
        expect(code).toBeTruthy();
        expect(codeRow?.user).toBe(bob?._id.toString());
    });

    it('mints for the clicked account even if the active session flipped before submit', async () => {
        const clientId = await registerClient();
        const { jar, returnTo } = await aliceThenBob(authorizeQuery(clientId));
        const bobForm = allowFormFields(await renderAuthorizePage(returnTo.searchParams, jar), 'bob@example.com');
        // The web app's sync pivots the active session back to its own account at any moment.
        const alice = await aliceJar();
        const flipped = cookieJar(jar, alice.split('; ').find((pair) => pair.startsWith(`${SESSION_COOKIE}=`)) ?? '');

        issuedCode(await postDecision(bobForm, flipped));
        const bob = await db.collection('user').findOne({ email: 'bob@example.com' });
        expect((await db.collection('oauthAuthCodes').findOne({}))?.user).toBe(bob?._id.toString());
    });
});

describe('consent forgery protection', () => {
    async function aliceConsent(clientId: string) {
        const cookieHeader = `${SESSION_COOKIE}=${await loginCookie()}`;
        const html = await renderAuthorizePage(authorizeQuery(clientId), cookieHeader);
        return { cookieHeader, form: allowFormFields(html) };
    }

    async function expectNoCodeIssued(res: Response) {
        expect(res.status).not.toBe(302);
        expect(await db.collection('oauthAuthCodes').countDocuments()).toBe(0);
    }

    it('an Allow without the CSRF token re-renders consent and issues no code', async () => {
        const { cookieHeader, form } = await aliceConsent(await registerClient());
        form.delete('csrf');
        const res = await postDecision(form, cookieHeader);
        await expectNoCodeIssued(res);
        expect(await res.text()).toContain('Authorize access');
    });

    it("a CSRF token minted for another client's page does not authorize this one", async () => {
        const { cookieHeader, form } = await aliceConsent(await registerClient());
        form.set('client_id', await registerClient());
        await expectNoCodeIssued(await postDecision(form, cookieHeader));
    });

    it('an Allow naming a user this browser is not signed in to issues no code', async () => {
        const { cookieHeader, form } = await aliceConsent(await registerClient());
        form.set('user_id', 'someone-else');
        await expectNoCodeIssued(await postDecision(form, cookieHeader));
    });

    it('a re-rendered consent page drops the stale fields and its Allow then succeeds', async () => {
        const { cookieHeader, form } = await aliceConsent(await registerClient());
        form.set('csrf', 'forged');
        const rerender = await postDecision(form, cookieHeader);
        await expectNoCodeIssued(rerender);
        const html = await rerender.text();
        expect(html).not.toContain('value="forged"');

        const retry = allowFormFields(html);
        expect(retry.getAll('csrf')).toHaveLength(1);
        expect(retry.getAll('user_id')).toHaveLength(1);
        issuedCode(await postDecision(retry, cookieHeader));
    });

    it('rejects cross-site submissions of the consent and sign-in forms', async () => {
        const { cookieHeader, form } = await aliceConsent(await registerClient());
        const crossSite = await postDecision(form, cookieHeader, { 'Sec-Fetch-Site': 'cross-site' });
        expect(crossSite.status).toBe(403);
        const foreignOrigin = await postDecision(form, cookieHeader, { Origin: 'https://evil.example' });
        expect(foreignOrigin.status).toBe(403);
        await expectNoCodeIssued(crossSite);

        form.set('provider', 'google');
        const login = await app.fetch(
            new Request(`${ORIGIN}/mcp-oauth/authorize/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' },
                body: form.toString(),
            }),
        );
        expect(login.status).toBe(403);
    });

    it('forbids framing the sign-in and consent pages', async () => {
        const query = authorizeQuery(await registerClient());
        const signIn = await app.fetch(new Request(`${ORIGIN}/mcp-oauth/authorize?${query}`));
        const consent = await app.fetch(
            new Request(`${ORIGIN}/mcp-oauth/authorize?${query}`, { headers: { Cookie: `${SESSION_COOKIE}=${await loginCookie()}` } }),
        );
        for (const page of [signIn, consent]) {
            expect(page.headers.get('x-frame-options')).toBe('DENY');
            expect(page.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
        }
    });
});

describe('withAccountChooser', () => {
    it('adds prompt=select_account and keeps every other param', () => {
        const url = new URL(withAccountChooser('https://accounts.google.com/o/oauth2/auth?client_id=c&state=s&scope=openid+email'));
        expect(url.searchParams.get('prompt')).toBe('select_account');
        expect(url.searchParams.get('client_id')).toBe('c');
        expect(url.searchParams.get('state')).toBe('s');
        expect(url.searchParams.get('scope')).toBe('openid email');
    });

    it('overrides a prompt the provider URL already carries', () => {
        expect(new URL(withAccountChooser('https://github.com/login/oauth/authorize?prompt=consent')).searchParams.getAll('prompt')).toEqual([
            'select_account',
        ]);
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
        const cookieHeader = `${SESSION_COOKIE}=${sessionCookie}`;
        const form = allowFormFields(await renderAuthorizePage(authorizeQuery(clientId, { scope: 'items.read', state: 's' }), cookieHeader));
        // Tamper the consent form: request a real scope plus an unsupported/elevated one.
        form.set('scope', 'items.read reassign webhooks.manage');
        const code = issuedCode(await postDecision(form, cookieHeader), 's');
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
