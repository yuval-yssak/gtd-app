/**
 * OAuth 2.1 Authorization Server for the remote MCP flow, implemented natively in Hono.
 *
 * The MCP SDK's own `server/auth/` router is Express-only, so we don't mount it — we expose the
 * spec endpoints (RFC 8414 / 9728 metadata, RFC 7591 DCR, authorize, token) directly on Hono and
 * reuse only the SDK's `AuthInfo` shape downstream (in routes/mcp.ts). The security-critical grant
 * logic lives in lib/mcpOAuth.ts; this file does request parsing, Better Auth session resolution,
 * and the minimal server-rendered login + consent HTML.
 *
 * Login federates to the existing Better Auth Google/GitHub providers: an unauthenticated browser
 * is shown sign-in buttons that POST back here, which calls `auth.api.signInSocial` with a
 * callbackURL returning to this same `/authorize` request — so the whole flow stays on the API
 * origin with no client SPA changes.
 */
import dayjs from 'dayjs';
import { type Context, Hono } from 'hono';
import oauthClientsDAO from '../dataAccess/oauthClientsDAO.js';
import {
    confineScopes,
    issueAuthCode,
    isValidRedirectUri,
    MCP_SUPPORTED_SCOPES,
    parseScopeParam,
    redeemAuthorizationCode,
    redeemRefreshToken,
    redirectUriIsRegistered,
    registerOAuthClient,
} from '../lib/mcpOAuth.js';
import { auth } from '../loaders/mainLoader.js';
import type { ApiTokenScope, OAuthClientInterface } from '../types/entities.js';

const DEFAULT_ACCESS_TTL_SEC = 3600;
const DEFAULT_REFRESH_TTL_SEC = 2_592_000; // 30 days

/** This api-server's public origin — the OAuth issuer + RS metadata base. */
function issuerOrigin(): string {
    return (process.env.MCP_OAUTH_ISSUER ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
}

function accessTtlSec(): number {
    const raw = Number(process.env.MCP_OAUTH_ACCESS_TTL_SEC);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ACCESS_TTL_SEC;
}

function refreshTtlSec(): number {
    const raw = Number(process.env.MCP_OAUTH_REFRESH_TTL_SEC);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REFRESH_TTL_SEC;
}

function dcrEnabled(): boolean {
    return process.env.MCP_OAUTH_DCR_ENABLED !== 'false';
}

/** RFC 8414 Authorization Server Metadata. */
export function authorizationServerMetadata() {
    const origin = issuerOrigin();
    return {
        issuer: origin,
        authorization_endpoint: `${origin}/mcp-oauth/authorize`,
        token_endpoint: `${origin}/mcp-oauth/token`,
        registration_endpoint: `${origin}/mcp-oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        // S256 ONLY — advertising 'plain' would invite a PKCE downgrade.
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: MCP_SUPPORTED_SCOPES,
    };
}

/** RFC 9728 Protected Resource Metadata — points clients at this AS for the `/mcp` resource. */
export function protectedResourceMetadata() {
    const origin = issuerOrigin();
    return {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: MCP_SUPPORTED_SCOPES,
        bearer_methods_supported: ['header'],
    };
}

/** Minimal HTML escaping for the few dynamic values we interpolate into the consent/login pages. */
function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Collapses Hono's query record or parsed-body shape to a Map of plain string fields (drops files /
 * arrays). A Map (not a plain object) so reads are `.get()` — sidestepping `noPropertyAccessFromIndexSignature`.
 */
function toFieldMap(source: Record<string, unknown>): Map<string, string> {
    const out = new Map<string, string>();
    for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'string') {
            out.set(key, value);
        }
    }
    return out;
}

/** A single-string field reader over a field map. */
function fieldReader(fields: Map<string, string>): FieldReader {
    return (key) => fields.get(key);
}

/** Re-encodes a field map into a query string so login/consent forms round-trip every param verbatim. */
function authorizeQueryString(fields: Map<string, string>): string {
    const params = new URLSearchParams();
    for (const [key, value] of fields) {
        if (value.length > 0) {
            params.set(key, value);
        }
    }
    return params.toString();
}

function renderErrorPage(message: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Authorization error</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Authorization error</h1><p>${escapeHtml(message)}</p></body></html>`;
}

/** Login page: Google/GitHub buttons that POST back to /authorize/login preserving the authorize params. */
function renderLoginPage(queryString: string): string {
    const hidden = new URLSearchParams(queryString);
    const hiddenFields = [...hidden.entries()].map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
    const button = (provider: string, label: string) =>
        `<form method="post" action="/mcp-oauth/authorize/login" style="margin:0.5rem 0">${hiddenFields}<input type="hidden" name="provider" value="${provider}"><button type="submit" style="width:100%;padding:0.75rem;font-size:1rem;cursor:pointer">${escapeHtml(label)}</button></form>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in to GTD</title></head><body style="font-family:system-ui;max-width:24rem;margin:4rem auto;padding:0 1rem"><h1>Sign in to GTD</h1><p>An MCP client wants to connect to your GTD account.</p>${button('google', 'Sign in with Google')}${button('github', 'Sign in with GitHub')}</body></html>`;
}

/** Consent page: shows the client + requested scopes with Allow/Deny, POSTing to /authorize/decision. */
function renderConsentPage(client: OAuthClientInterface, scopes: ApiTokenScope[], queryString: string, userEmail: string): string {
    const hidden = new URLSearchParams(queryString);
    const hiddenFields = [...hidden.entries()].map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
    const clientLabel = client.clientName ?? client._id;
    const scopeList = scopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Authorize MCP access</title></head><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem"><h1>Authorize access</h1><p><strong>${escapeHtml(clientLabel)}</strong> wants to access your GTD account (<code>${escapeHtml(userEmail)}</code>) with:</p><ul>${scopeList}</ul><div style="display:flex;gap:0.75rem;margin-top:1.5rem"><form method="post" action="/mcp-oauth/authorize/decision" style="flex:1">${hiddenFields}<input type="hidden" name="decision" value="allow"><button type="submit" style="width:100%;padding:0.75rem;cursor:pointer">Allow</button></form><form method="post" action="/mcp-oauth/authorize/decision" style="flex:1">${hiddenFields}<input type="hidden" name="decision" value="deny"><button type="submit" style="width:100%;padding:0.75rem;cursor:pointer">Deny</button></form></div></body></html>`;
}

interface AuthorizeParams {
    clientId: string;
    redirectUri: string;
    responseType: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string | undefined;
    state: string | undefined;
}

/** A single-string field reader — works over Hono's query record or parsed form (both index-signature shapes). */
type FieldReader = (key: string) => string | undefined;

function readAuthorizeParams(get: FieldReader): AuthorizeParams {
    return {
        clientId: get('client_id') ?? '',
        redirectUri: get('redirect_uri') ?? '',
        responseType: get('response_type') ?? '',
        codeChallenge: get('code_challenge') ?? '',
        codeChallengeMethod: get('code_challenge_method') ?? '',
        scope: get('scope'),
        state: get('state'),
    };
}

/** Appends an OAuth error to a redirect_uri (used only AFTER the redirect_uri is proven registered). */
function redirectWithError(redirectUri: string, error: string, description: string, state: string | undefined): string {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (state) {
        url.searchParams.set('state', state);
    }
    return url.toString();
}

/**
 * Validates the authorize request up to the point a session is required. Returns the resolved
 * client + confined scopes on success, or a rendered error / redirect on failure. The redirect_uri
 * exact-match check runs FIRST and renders an error page (never a redirect) on mismatch — the
 * open-redirect gate.
 */
async function validateAuthorizeRequest(
    params: AuthorizeParams,
): Promise<{ ok: true; client: OAuthClientInterface; scopes: ApiTokenScope[] } | { ok: false; page: string } | { ok: false; redirect: string }> {
    const client = await oauthClientsDAO.findById(params.clientId);
    if (!client) {
        return { ok: false, page: renderErrorPage('Unknown client_id.') };
    }
    if (!redirectUriIsRegistered(client, params.redirectUri)) {
        return { ok: false, page: renderErrorPage('redirect_uri is not registered for this client.') };
    }
    // From here the redirect_uri is trusted, so spec errors go back to the client as a redirect.
    if (params.responseType !== 'code') {
        return {
            ok: false,
            redirect: redirectWithError(params.redirectUri, 'unsupported_response_type', 'only response_type=code is supported', params.state),
        };
    }
    if (!params.codeChallenge || params.codeChallengeMethod !== 'S256') {
        return {
            ok: false,
            redirect: redirectWithError(params.redirectUri, 'invalid_request', 'PKCE with code_challenge_method=S256 is required', params.state),
        };
    }
    const scopes = confineScopes(parseScopeParam(params.scope), client);
    if (scopes.length === 0) {
        return { ok: false, redirect: redirectWithError(params.redirectUri, 'invalid_scope', 'no requested scope is permitted for this client', params.state) };
    }
    return { ok: true, client, scopes };
}

/** Untrusted DCR request body — every field is validated/narrowed before use. */
interface RegisterRequestBody {
    redirect_uris?: unknown;
    client_name?: unknown;
    token_endpoint_auth_method?: unknown;
    grant_types?: unknown;
    scope?: unknown;
}

export const mcpOAuthRoutes = new Hono()
    // RFC 7591 Dynamic Client Registration.
    .post('/register', async (c) => {
        if (!dcrEnabled()) {
            return c.json({ error: 'invalid_request', error_description: 'dynamic client registration is disabled' }, 403);
        }
        const body: RegisterRequestBody = await c.req.json<RegisterRequestBody>().catch(() => ({}));
        const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
        if (redirectUris.length === 0 || !redirectUris.every(isValidRedirectUri)) {
            return c.json(
                {
                    error: 'invalid_redirect_uri',
                    error_description: 'redirect_uris must be a non-empty array of https or http-loopback URLs without fragments',
                },
                400,
            );
        }
        const { client, clientSecret } = await registerOAuthClient({
            redirectUris,
            ...(typeof body.client_name === 'string' ? { clientName: body.client_name } : {}),
            ...(typeof body.token_endpoint_auth_method === 'string' ? { tokenEndpointAuthMethod: body.token_endpoint_auth_method } : {}),
            ...(Array.isArray(body.grant_types) ? { grantTypes: body.grant_types.filter((g): g is string => typeof g === 'string') } : {}),
            ...(typeof body.scope === 'string' ? { scopes: parseScopeParam(body.scope) } : {}),
        });
        return c.json(
            {
                client_id: client._id,
                ...(clientSecret ? { client_secret: clientSecret } : {}),
                client_id_issued_at: dayjs(client.createdTs).unix(),
                redirect_uris: client.redirectUris,
                grant_types: client.grantTypes,
                token_endpoint_auth_method: client.tokenEndpointAuthMethod,
                scope: client.scopes.join(' '),
            },
            201,
        );
    })

    // Authorization endpoint — reached by browser navigation. Requires a Better Auth session;
    // if absent, render the login page; otherwise render the consent page.
    .get('/authorize', async (c) => {
        const fields = toFieldMap(c.req.query());
        const params = readAuthorizeParams(fieldReader(fields));
        const validation = await validateAuthorizeRequest(params);
        if (!validation.ok) {
            if ('page' in validation) {
                return c.html(validation.page, 400);
            }
            return c.redirect(validation.redirect);
        }
        const session = await auth.api.getSession({ headers: c.req.raw.headers });
        const queryString = authorizeQueryString(fields);
        if (!session) {
            return c.html(renderLoginPage(queryString));
        }
        return c.html(renderConsentPage(validation.client, validation.scopes, queryString, session.user.email));
    })

    // Login bounce: federate to Better Auth social sign-in with a callbackURL returning to /authorize.
    .post('/authorize/login', async (c) => {
        const fields = toFieldMap(await c.req.parseBody());
        const provider = fields.get('provider') ?? '';
        if (provider !== 'google' && provider !== 'github') {
            return c.html(renderErrorPage('Unsupported sign-in provider.'), 400);
        }
        const callbackURL = `${issuerOrigin()}/mcp-oauth/authorize?${authorizeQueryStringFromForm(fields)}`;
        const result = await auth.api.signInSocial({ body: { provider, callbackURL }, headers: c.req.raw.headers });
        if (!result?.url) {
            return c.html(renderErrorPage('Could not start sign-in. Please try again.'), 500);
        }
        return c.redirect(result.url);
    })

    // Consent decision: on allow, mint a one-time code and redirect to the client with code + state.
    .post('/authorize/decision', async (c) => {
        const fields = toFieldMap(await c.req.parseBody());
        const params = readAuthorizeParams(fieldReader(fields));
        const decision = fields.get('decision') ?? '';
        const session = await auth.api.getSession({ headers: c.req.raw.headers });
        if (!session) {
            // Session expired between consent render and submit — restart by showing login again.
            return c.html(renderLoginPage(authorizeQueryStringFromForm(fields)));
        }
        const validation = await validateAuthorizeRequest(params);
        if (!validation.ok) {
            if ('page' in validation) {
                return c.html(validation.page, 400);
            }
            return c.redirect(validation.redirect);
        }
        if (decision !== 'allow') {
            return c.redirect(redirectWithError(params.redirectUri, 'access_denied', 'the user denied the authorization request', params.state));
        }
        const code = await issueAuthCode({
            user: session.user.id,
            client: validation.client,
            redirectUri: params.redirectUri,
            codeChallenge: params.codeChallenge,
            scopes: validation.scopes,
        });
        const url = new URL(params.redirectUri);
        url.searchParams.set('code', code);
        if (params.state) {
            url.searchParams.set('state', params.state);
        }
        return c.redirect(url.toString());
    })

    // Token endpoint — application/x-www-form-urlencoded. authorization_code + refresh_token grants.
    .post('/token', async (c) => {
        const fields = toFieldMap(await c.req.parseBody());
        const grantType = fields.get('grant_type') ?? '';
        if (grantType === 'authorization_code') {
            return handleAuthorizationCodeGrant(c, fields);
        }
        if (grantType === 'refresh_token') {
            return handleRefreshGrant(c, fields);
        }
        return c.json({ error: 'unsupported_grant_type', error_description: 'grant_type must be authorization_code or refresh_token' }, 400);
    });

/** Rebuilds the authorize query string from posted form fields, dropping non-authorize control fields. */
function authorizeQueryStringFromForm(fields: Map<string, string>): string {
    const authorizeFields = new Map(fields);
    authorizeFields.delete('provider');
    authorizeFields.delete('decision');
    return authorizeQueryString(authorizeFields);
}

async function handleAuthorizationCodeGrant(c: Context, fields: Map<string, string>) {
    const clientSecret = fields.get('client_secret');
    const result = await redeemAuthorizationCode({
        code: fields.get('code') ?? '',
        clientId: fields.get('client_id') ?? '',
        redirectUri: fields.get('redirect_uri') ?? '',
        codeVerifier: fields.get('code_verifier') ?? '',
        ...(clientSecret ? { clientSecret } : {}),
        accessTtlSec: accessTtlSec(),
        refreshTtlSec: refreshTtlSec(),
    });
    return tokenResponse(c, result);
}

async function handleRefreshGrant(c: Context, fields: Map<string, string>) {
    const clientSecret = fields.get('client_secret');
    const result = await redeemRefreshToken({
        refreshToken: fields.get('refresh_token') ?? '',
        clientId: fields.get('client_id') ?? '',
        ...(clientSecret ? { clientSecret } : {}),
        accessTtlSec: accessTtlSec(),
        refreshTtlSec: refreshTtlSec(),
    });
    return tokenResponse(c, result);
}

/** Maps a GrantResult to the spec token response or an OAuth error body. */
function tokenResponse(c: Context, result: Awaited<ReturnType<typeof redeemAuthorizationCode>>) {
    if (!result.ok) {
        const status = result.error === 'invalid_client' ? 401 : 400;
        return c.json({ error: result.error, error_description: result.description }, status);
    }
    // no-store per OAuth 2.1 — token responses must never be cached.
    c.header('Cache-Control', 'no-store');
    return c.json({
        access_token: result.tokens.accessToken,
        token_type: 'Bearer',
        expires_in: result.tokens.expiresInSec,
        refresh_token: result.tokens.refreshToken,
        scope: result.tokens.scopes.join(' '),
    });
}
