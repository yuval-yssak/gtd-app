/**
 * OAuth 2.1 (Authorization Code + PKCE) primitives for the remote MCP server, decoupled from Hono
 * so the security-critical logic (PKCE verification, code redemption, refresh rotation, redirect_uri
 * validation, scope confinement) is unit-testable without booting an HTTP server.
 *
 * The route layer (routes/mcpOAuth.ts) does request parsing, session resolution, and HTML rendering;
 * everything that decides "is this grant valid / what token should we mint" lives here.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { issueOAuthAccessToken } from '../auth/apiTokens.js';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import oauthAuthCodesDAO from '../dataAccess/oauthAuthCodesDAO.js';
import oauthClientsDAO from '../dataAccess/oauthClientsDAO.js';
import oauthRefreshTokensDAO from '../dataAccess/oauthRefreshTokensDAO.js';
import { type ApiTokenScope, MINTABLE_API_TOKEN_SCOPES, type OAuthClientInterface } from '../types/entities.js';

/** Scopes the remote MCP authorization server advertises + permits. Read+write across all entity domains. */
export const MCP_SUPPORTED_SCOPES: ApiTokenScope[] = [
    'items.capture',
    'items.read',
    'items.write',
    'routines.read',
    'routines.write',
    'people.read',
    'people.write',
    'contexts.read',
    'contexts.write',
];

const AUTH_CODE_TTL_SEC = 60;

/** Sha-256 hex — the storage/lookup key for codes, refresh tokens, and client secrets. */
export function sha256(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
}

/** Base64url of a sha256 digest — the PKCE S256 transform of a verifier. */
export function pkceS256Challenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Verifies an RFC 7636 S256 PKCE pair. The verifier must be 43–128 chars (RFC range) and its S256
 * transform must equal the stored challenge. Returns false on any mismatch — never throws.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
    if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) {
        return false;
    }
    return pkceS256Challenge(verifier) === challenge;
}

/** Generates an opaque high-entropy token (auth code / refresh token). No `gtd_` prefix — these aren't bearer tokens. */
export function generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
}

/**
 * Validates a redirect_uri for registration / authorization. Allows absolute https URLs and
 * http loopback (localhost / 127.0.0.1) for native MCP clients; rejects fragments and any
 * non-http(s) scheme. This is the open-redirect gate's structural half — exact-match against the
 * client's registered list is the other half (see `redirectUriIsRegistered`).
 */
export function isValidRedirectUri(uri: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(uri);
    } catch {
        return false;
    }
    if (parsed.hash) {
        return false;
    }
    if (parsed.protocol === 'https:') {
        return true;
    }
    if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
        return true;
    }
    return false;
}

/** Exact-match (verbatim string equality) against the client's registered redirect URIs. */
export function redirectUriIsRegistered(client: OAuthClientInterface, redirectUri: string): boolean {
    return client.redirectUris.includes(redirectUri);
}

/**
 * Confines requested scopes to the intersection of {requested} ∩ {client-permitted} ∩ {server-supported}.
 * Unknown/unsupported scopes are silently dropped (standard OAuth downscoping) rather than erroring,
 * so a client over-asking still gets a usable token bounded to what it may actually have.
 */
export function confineScopes(requested: readonly string[], client: OAuthClientInterface): ApiTokenScope[] {
    const clientScopes = new Set(client.scopes);
    const supported = new Set(MCP_SUPPORTED_SCOPES);
    return requested.filter(
        (s): s is ApiTokenScope =>
            MINTABLE_API_TOKEN_SCOPES.has(s as ApiTokenScope) && clientScopes.has(s as ApiTokenScope) && supported.has(s as ApiTokenScope),
    );
}

/** Parses a space-delimited OAuth scope string into a trimmed, non-empty token array. */
export function parseScopeParam(scope: string | undefined): string[] {
    if (!scope) {
        return [];
    }
    return scope.split(/\s+/).filter((s) => s.length > 0);
}

export interface RegisterClientInput {
    redirectUris: string[];
    clientName?: string;
    tokenEndpointAuthMethod?: string;
    grantTypes?: string[];
    scopes?: string[];
}

export interface RegisteredClientResult {
    client: OAuthClientInterface;
    /** Plaintext secret — present only for confidential clients; returned to the caller exactly once. */
    clientSecret?: string;
}

/**
 * Registers a new OAuth client (RFC 7591). Defaults to a PUBLIC client (PKCE-only, no secret) —
 * the correct default for MCP clients. Confidential clients get a one-time plaintext secret;
 * only its sha256 is persisted.
 */
export async function registerOAuthClient(input: RegisterClientInput): Promise<RegisteredClientResult> {
    const authMethod =
        input.tokenEndpointAuthMethod === 'client_secret_post' || input.tokenEndpointAuthMethod === 'client_secret_basic'
            ? input.tokenEndpointAuthMethod
            : 'none';
    const requestedScopes = (input.scopes ?? MCP_SUPPORTED_SCOPES).filter((s): s is ApiTokenScope => MCP_SUPPORTED_SCOPES.includes(s as ApiTokenScope));
    const scopes = requestedScopes.length > 0 ? requestedScopes : MCP_SUPPORTED_SCOPES;

    const clientSecret = authMethod === 'none' ? undefined : generateOpaqueToken();
    const client: OAuthClientInterface = {
        _id: randomUUID(),
        redirectUris: input.redirectUris,
        grantTypes: input.grantTypes ?? ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethod: authMethod,
        scopes,
        createdTs: dayjs().toISOString(),
        ...(input.clientName ? { clientName: input.clientName } : {}),
        ...(clientSecret ? { clientSecretHash: sha256(clientSecret) } : {}),
    };
    await oauthClientsDAO.insertOne(client);
    return { client, ...(clientSecret ? { clientSecret } : {}) };
}

export interface IssueAuthCodeInput {
    user: string;
    client: OAuthClientInterface;
    redirectUri: string;
    codeChallenge: string;
    scopes: ApiTokenScope[];
}

/** Mints + persists a one-time authorization code (stored hashed) and returns the plaintext code. */
export async function issueAuthCode(input: IssueAuthCodeInput): Promise<string> {
    const code = generateOpaqueToken();
    const now = dayjs();
    await oauthAuthCodesDAO.insertOne({
        _id: sha256(code),
        user: input.user,
        clientId: input.client._id,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: 'S256',
        scopes: input.scopes,
        expiresTs: now.add(AUTH_CODE_TTL_SEC, 'second').toISOString(),
        createdTs: now.toISOString(),
    });
    return code;
}

export interface TokenSet {
    accessToken: string;
    refreshToken: string;
    expiresInSec: number;
    scopes: ApiTokenScope[];
}

export type GrantResult = { ok: true; tokens: TokenSet } | { ok: false; error: 'invalid_grant' | 'invalid_client' | 'invalid_request'; description: string };

interface MintedTokenSet extends TokenSet {
    /** sha256 hash of the new refresh token = its `_id`. Used to link a rotation chain for reuse detection. */
    refreshTokenId: string;
    /** `apiTokens._id` of the new access token. Lets a lost rotation race revoke exactly what it minted. */
    accessTokenId: string;
}

/**
 * Mints a paired access + refresh token for a user/client/scope grant, persisting the refresh row.
 * Shared by the authorization_code and refresh_token grants. Returns the new refresh row's id so a
 * rotation can link the prior row to this one (the chain a reuse-detection walk follows).
 */
async function mintTokenSet(user: string, clientId: string, scopes: ApiTokenScope[], accessTtlSec: number, refreshTtlSec: number): Promise<MintedTokenSet> {
    const { plaintext: accessToken, record } = await issueOAuthAccessToken(user, clientId, scopes, accessTtlSec);
    const refreshToken = generateOpaqueToken();
    const refreshTokenId = sha256(refreshToken);
    await oauthRefreshTokensDAO.insertOne({
        _id: refreshTokenId,
        user,
        clientId,
        scopes,
        accessTokenId: record._id,
        expiresTs: dayjs().add(refreshTtlSec, 'second').toISOString(),
        createdTs: dayjs().toISOString(),
    });
    return { accessToken, refreshToken, refreshTokenId, accessTokenId: record._id, expiresInSec: accessTtlSec, scopes };
}

/** Strips the internal id fields so callers see only the public TokenSet shape. */
function toPublicTokenSet(minted: MintedTokenSet): TokenSet {
    const { refreshTokenId, accessTokenId, ...tokens } = minted;
    void refreshTokenId;
    void accessTokenId;
    return tokens;
}

/**
 * Verifies client authentication for a token request: looks up the client and, for confidential
 * clients, checks the secret. Public clients (no `clientSecretHash`) pass on PKCE alone. Returns the
 * client on success or an `invalid_client` failure. Shared by both grant paths so the rule lives once.
 */
async function authenticateClient(
    clientId: string,
    clientSecret: string | undefined,
): Promise<{ ok: true; client: OAuthClientInterface } | { ok: false; error: 'invalid_client'; description: string }> {
    const client = await oauthClientsDAO.findById(clientId);
    if (!client) {
        return { ok: false, error: 'invalid_client', description: 'unknown client' };
    }
    if (client.clientSecretHash && (!clientSecret || sha256(clientSecret) !== client.clientSecretHash)) {
        return { ok: false, error: 'invalid_client', description: 'client authentication failed' };
    }
    return { ok: true, client };
}

export interface AuthCodeGrantInput {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    clientSecret?: string;
    accessTtlSec: number;
    refreshTtlSec: number;
}

/**
 * Redeems an authorization_code grant. Atomically consumes the code (replay guard), then verifies
 * the client/redirect_uri binding, the PKCE verifier, and (for confidential clients) the secret —
 * before minting a token set. Any failure returns `invalid_grant`/`invalid_client` and mints nothing.
 */
export async function redeemAuthorizationCode(input: AuthCodeGrantInput): Promise<GrantResult> {
    const now = dayjs().toISOString();
    const codeRow = await oauthAuthCodesDAO.consume(sha256(input.code), now);
    if (!codeRow) {
        return { ok: false, error: 'invalid_grant', description: 'authorization code is invalid, expired, or already used' };
    }
    if (codeRow.clientId !== input.clientId || codeRow.redirectUri !== input.redirectUri) {
        return { ok: false, error: 'invalid_grant', description: 'client_id or redirect_uri does not match the authorization request' };
    }
    if (!verifyPkceS256(input.codeVerifier, codeRow.codeChallenge)) {
        return { ok: false, error: 'invalid_grant', description: 'PKCE verification failed' };
    }
    const clientAuth = await authenticateClient(input.clientId, input.clientSecret);
    if (!clientAuth.ok) {
        return clientAuth;
    }
    const tokens = await mintTokenSet(codeRow.user, codeRow.clientId, codeRow.scopes, input.accessTtlSec, input.refreshTtlSec);
    return { ok: true, tokens: toPublicTokenSet(tokens) };
}

export interface RefreshGrantInput {
    refreshToken: string;
    clientId: string;
    clientSecret?: string;
    accessTtlSec: number;
    refreshTtlSec: number;
}

/**
 * Redeems a refresh_token grant with mandatory rotation + reuse detection (OAuth 2.1). The prior
 * refresh row is atomically marked rotated; a row that was ALREADY rotated signals token reuse
 * (compromise) → the whole family is revoked and the grant fails. On success the previous access
 * token is revoked so it can't outlive the rotation.
 */
export async function redeemRefreshToken(input: RefreshGrantInput): Promise<GrantResult> {
    const now = dayjs().toISOString();
    const refreshHash = sha256(input.refreshToken);

    // 1. Read-only validation BEFORE any mutation, so a recoverable error (wrong client_id, bad
    //    secret) never consumes the token. A row that's already rotated is reuse → revoke the family.
    const existing = await oauthRefreshTokensDAO.findByHash(refreshHash);
    if (!existing || existing.revokedTs || (existing.expiresTs && existing.expiresTs <= now)) {
        return { ok: false, error: 'invalid_grant', description: 'refresh token is invalid, revoked, or expired' };
    }
    if (existing.rotatedToId) {
        await revokeFamilyOnReuse(refreshHash, now);
        return { ok: false, error: 'invalid_grant', description: 'refresh token has already been used (reuse detected)' };
    }
    if (existing.clientId !== input.clientId) {
        return { ok: false, error: 'invalid_grant', description: 'refresh token was not issued to this client' };
    }
    const clientAuth = await authenticateClient(input.clientId, input.clientSecret);
    if (!clientAuth.ok) {
        return clientAuth;
    }

    // 2. Mint the successor, then atomically claim the rotation linking the predecessor to the REAL
    //    successor id — durable before the successor is usable (no sentinel, no crash window). The
    //    atomic guard (unrotated + unrevoked + unexpired) is the concurrency winner check. A crash
    //    between mint and rotate leaves an undelivered orphan token pair (plaintext never returned to
    //    any client) that the TTL index reaps — strictly safer than an unwalkable chain.
    const minted = await mintTokenSet(existing.user, existing.clientId, existing.scopes, input.accessTtlSec, input.refreshTtlSec);
    const claimed = await oauthRefreshTokensDAO.rotate(refreshHash, minted.refreshTokenId, now);
    if (!claimed) {
        // A concurrent request won the rotation race. Tear down the tokens we just minted and revoke
        // the family — both requests presenting the same refresh is itself a reuse signal.
        await oauthRefreshTokensDAO.revokeById(minted.refreshTokenId, now);
        await apiTokensDAO.revokeByIdUnscoped(minted.accessTokenId, now);
        await revokeFamilyOnReuse(refreshHash, now);
        return { ok: false, error: 'invalid_grant', description: 'refresh token has already been used (reuse detected)' };
    }
    // Revoke the access token the predecessor refresh was paired with — it must not outlive its refresh.
    if (claimed.accessTokenId) {
        await apiTokensDAO.revokeByIdUnscoped(claimed.accessTokenId, now);
    }
    return { ok: true, tokens: toPublicTokenSet(minted) };
}

/**
 * On detected refresh-token reuse, revoke the entire rotation family: starting at the reused row,
 * walk `rotatedToId` forward, revoking each refresh row and its paired access token. This kills the
 * successor tokens a thief may already hold. Best-effort — failures don't change the `invalid_grant`
 * already returned. A depth cap guards against a pathological/corrupt cycle.
 */
async function revokeFamilyOnReuse(refreshHash: string, now: string): Promise<void> {
    let cursorId: string | undefined = refreshHash;
    for (let depth = 0; cursorId && depth < 100; depth++) {
        const row = await oauthRefreshTokensDAO.findByHash(cursorId);
        if (!row) {
            return;
        }
        await oauthRefreshTokensDAO.revokeById(row._id, now);
        if (row.accessTokenId) {
            await apiTokensDAO.revokeByIdUnscoped(row.accessTokenId, now);
        }
        cursorId = row.rotatedToId;
    }
}
