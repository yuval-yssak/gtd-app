/**
 * Remote MCP resource endpoint (`/mcp`). Serves the same GTD tools as the local stdio binary over
 * the MCP Streamable HTTP transport, mounted into this Hono app.
 *
 * Auth: a `Authorization: Bearer gtd_…` access token, resolved against Mongo on every request
 * (revocation + OAuth expiry enforced in the query — no cache, per the guardrail). It accepts BOTH
 * short-lived OAuth access tokens (the Option-2 flow) AND plain personal `gtd_` tokens (Option-1
 * passthrough) — any valid token authenticates. On failure we return 401 with a `WWW-Authenticate`
 * header pointing at the protected-resource metadata so MCP clients can auto-discover the auth server.
 *
 * Tools call back into this same process's `/v1/*` API over loopback HTTP, signed with the caller's
 * own token — so every tool call reuses the full `/v1` middleware stack (scopes, rate limit,
 * notification fan-out) and is scoped to the authenticated user. Transport is STATELESS
 * (sessionIdGenerator: undefined, enableJsonResponse: true) because Cloud Run has multiple instances
 * with no sticky sessions; a per-request McpServer is built and torn down each call.
 */

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { hashToken } from '../auth/apiTokens.js';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import { createRemoteApiClient } from '../mcp/apiClient.js';
import { registerAllTools, SERVER_INSTRUCTIONS } from '../mcp/registerTools.js';
import { classifyEnvironment, resolveWebBase } from '../mcp/webBase.js';
import { DEFAULT_API_TOKEN_SCOPES } from '../types/entities.js';

const TOKEN_PREFIX = 'gtd_';

/** Loopback base for in-process /v1 calls. Tools sign these with the caller's own bearer. */
function loopbackApiBase(): string {
    return `http://127.0.0.1:${process.env.PORT ?? 4000}`;
}

/** Public origin of this api-server — used to derive the browsable web base for deep-link stamping. */
function publicApiBase(): string {
    return (process.env.MCP_OAUTH_ISSUER ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
}

/** The protected-resource metadata URL advertised in WWW-Authenticate on 401 (MCP discovery). */
function resourceMetadataUrl(): string {
    return `${publicApiBase()}/.well-known/oauth-protected-resource/mcp`;
}

/** Extracts the bearer value if the header is a well-formed `Bearer gtd_…`. */
function bearerValue(authorizationHeader: string | undefined): string | null {
    if (!authorizationHeader) {
        return null;
    }
    const [scheme, value] = authorizationHeader.split(' ');
    if (scheme !== 'Bearer' || !value || !value.startsWith(TOKEN_PREFIX)) {
        return null;
    }
    return value;
}

export const mcpRoutes = new Hono().all('/', async (c) => {
    const token = bearerValue(c.req.header('Authorization'));
    if (!token) {
        c.header('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl()}"`);
        return c.json({ error: 'unauthorized', error_description: 'missing or malformed bearer token' }, 401);
    }
    // Single Mongo read enforcing revocation AND OAuth expiry — no cache (revocation guardrail).
    const row = await apiTokensDAO.findActiveUnexpiredByHash(hashToken(token), dayjs().toISOString());
    if (!row) {
        c.header('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl()}"`);
        return c.json({ error: 'invalid_token', error_description: 'token is unknown, revoked, or expired' }, 401);
    }
    // Best-effort lastUsedTs bump — never blocks the request.
    void apiTokensDAO.touchLastUsed(row._id, dayjs().toISOString()).catch((err) => {
        console.error('[mcp] touchLastUsed failed', { tokenId: row._id, err });
    });

    const authInfo: AuthInfo = {
        token,
        clientId: row.oauthClientId ?? 'personal',
        scopes: row.scopes ?? DEFAULT_API_TOKEN_SCOPES,
        // Conditional spread: exactOptionalPropertyTypes forbids assigning undefined to optional `expiresAt`.
        ...(row.expiresTs ? { expiresAt: Math.floor(dayjs(row.expiresTs).valueOf() / 1000) } : {}),
        extra: { userId: row.user, tokenId: row._id },
    };

    const environment = classifyEnvironment(publicApiBase());
    const api = createRemoteApiClient({
        apiBase: loopbackApiBase(),
        environment,
        webBase: resolveWebBase(environment),
        token,
    });

    // Per-request server + stateless transport (Cloud Run multi-instance, no sticky sessions).
    const server = new McpServer({ name: 'gtd-mcp', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });
    registerAllTools(server, api);
    // Omit sessionIdGenerator entirely → stateless mode (required on multi-instance Cloud Run).
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, { authInfo });
});
