/**
 * End-to-end tests for the remote `/mcp` resource endpoint. Issues an OAuth access token directly,
 * then drives the MCP Streamable HTTP transport (initialize → tools/list → tools/call gtd_me) and
 * the 401 discovery path. The tools call back into `/v1/*` over loopback HTTP; the test routes that
 * loopback into the in-process app via a `fetch` stub so no real listener is needed.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueOAuthAccessToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { mcpRoutes } from '../routes/mcp.js';
import { v1MeRoutes } from '../routes/v1/me.js';
import type { ApiTokenScope } from '../types/entities.js';

const ORIGIN = 'http://localhost:4000';

// The app under test serves both /mcp (the resource) and /v1 (what the tools call over loopback).
const app = new Hono().route('/mcp', mcpRoutes).route('/v1', v1MeRoutes);

const SCOPES: ApiTokenScope[] = ['items.read', 'items.write'];

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('user').deleteMany({}), db.collection('apiTokens').deleteMany({})]);
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

/**
 * Routes the tools' loopback `http://127.0.0.1:PORT/v1/*` calls into the in-process app, leaving any
 * other fetch (none expected) to throw. Mirrors the helpers' OAuth-mock style.
 */
function stubLoopbackFetch() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/v1/')) {
            const rewritten = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ORIGIN);
            return app.fetch(new Request(rewritten, init as RequestInit));
        }
        throw new Error(`Unexpected fetch to ${url}`);
    });
}

async function seedUserAndToken(): Promise<{ userId: string; token: string }> {
    const userId = 'user-mcp-test';
    await db.collection('user').insertOne({ _id: userId as never, email: 'mcp@example.com', name: 'MCP Tester' });
    const { plaintext } = await issueOAuthAccessToken(userId, 'client-abc', SCOPES, 3600);
    return { userId, token: plaintext };
}

/** Sends one JSON-RPC message to /mcp and returns the parsed JSON body (enableJsonResponse mode). */
async function callMcp(token: string | null, message: unknown): Promise<{ status: number; body: unknown; wwwAuth: string | null }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }
    const res = await app.fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers, body: JSON.stringify(message) }));
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, wwwAuth: res.headers.get('www-authenticate') };
}

const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

describe('/mcp authentication', () => {
    it('401s with a WWW-Authenticate pointing at protected-resource metadata when no token is sent', async () => {
        const { status, wwwAuth } = await callMcp(null, INITIALIZE);
        expect(status).toBe(401);
        expect(wwwAuth).toContain('resource_metadata=');
        expect(wwwAuth).toContain('/.well-known/oauth-protected-resource/mcp');
    });

    it('401s for an unknown/garbage bearer token', async () => {
        const { status } = await callMcp('gtd_not-a-real-token', INITIALIZE);
        expect(status).toBe(401);
    });
});

describe('/mcp protocol', () => {
    it('handshakes, lists tools, and calls gtd_me through the loopback /v1 path', async () => {
        const { userId, token } = await seedUserAndToken();
        stubLoopbackFetch();

        const init = await callMcp(token, INITIALIZE);
        expect(init.status).toBe(200);
        expect((init.body as { result?: { serverInfo?: { name?: string } } }).result?.serverInfo?.name).toBe('gtd-mcp');

        const list = await callMcp(token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const toolNames = (list.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
        expect(toolNames).toContain('gtd_me');
        expect(toolNames).toContain('gtd_capture');

        const call = await callMcp(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gtd_me', arguments: {} } });
        expect(call.status).toBe(200);
        const content = (call.body as { result: { content: { type: string; text: string }[]; isError?: boolean } }).result;
        expect(content.isError).toBeFalsy();
        const payload = JSON.parse(content.content[0]?.text ?? '{}') as { userId: string; email: string };
        expect(payload.userId).toBe(userId);
        expect(payload.email).toBe('mcp@example.com');
    });

    it('fails gtd_reassign explicitly (multi-account is unsupported on the single-token remote)', async () => {
        const { token } = await seedUserAndToken();
        stubLoopbackFetch();
        await callMcp(token, INITIALIZE);

        const call = await callMcp(token, {
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name: 'gtd_reassign', arguments: { entityType: 'item', entityId: 'x', toAccount: 'work' } },
        });
        const result = (call.body as { result: { content: { text: string }[]; isError?: boolean } }).result;
        expect(result.isError).toBe(true);
        // The single-token client throws rather than silently resolving toAccount to the caller.
        expect(result.content[0]?.text ?? '').toContain('multi_account_unsupported');
    });
});
