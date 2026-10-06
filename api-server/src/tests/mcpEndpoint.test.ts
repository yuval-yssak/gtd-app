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
import { v1Routes } from '../routes/v1/index.js';
import type { ApiTokenScope } from '../types/entities.js';

const ORIGIN = 'http://localhost:4000';

// The app under test serves both /mcp (the resource) and /v1 (what the tools call over loopback).
// The full /v1 router is mounted so item writes (gtd_capture → gtd_update_item) run the real
// apply pipeline — the field-guidance test below inspects what the server actually stored.
const app = new Hono().route('/mcp', mcpRoutes).route('/v1', v1Routes);

const SCOPES: ApiTokenScope[] = ['items.capture', 'items.read', 'items.write', 'contexts.write'];

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    // Every test reuses the same userId, so the rows item writes leave behind (items, their ops,
    // work contexts) must go too or a later list-style assertion would see earlier tests' rows.
    await Promise.all([
        db.collection('user').deleteMany({}),
        db.collection('apiTokens').deleteMany({}),
        db.collection('items').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('workContexts').deleteMany({}),
    ]);
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
        expect(toolNames).toContain('gtd_set_brief');
        expect(toolNames).toContain('gtd_generate_brief');

        const call = await callMcp(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gtd_me', arguments: {} } });
        expect(call.status).toBe(200);
        const content = (call.body as { result: { content: { type: string; text: string }[]; isError?: boolean } }).result;
        expect(content.isError).toBeFalsy();
        const payload = JSON.parse(content.content[0]?.text ?? '{}') as { userId: string; email: string };
        expect(payload.userId).toBe(userId);
        expect(payload.email).toBe('mcp@example.com');
    });

    /** The slice of an item tool response these tests inspect. */
    interface ItemToolPayload {
        _id?: string;
        status?: string;
        workContextIds?: string[];
        location?: string;
        fieldGuidance?: { missing: string[]; hint: string };
    }

    interface ToolCallResult {
        content: { text: string }[];
        isError?: boolean;
    }

    async function callToolViaMcp(token: string, id: number, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
        const call = await callMcp(token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
        return (call.body as { result: ToolCallResult }).result;
    }

    /** Calls one item tool through /mcp and returns its parsed JSON payload (asserting it did not error). */
    async function callItemToolViaMcp(token: string, id: number, name: string, args: Record<string, unknown>): Promise<ItemToolPayload> {
        const result = await callToolViaMcp(token, id, name, args);
        const [block] = result.content;
        if (!block) throw new Error(`tool ${name} returned no content`);
        expect(result.isError, `tool ${name} errored: ${block.text}`).toBeFalsy();
        return JSON.parse(block.text) as ItemToolPayload;
    }

    /** Captures an inbox item through /mcp and returns its id. */
    async function captureViaMcp(token: string, id: number, title: string): Promise<string> {
        const captured = await callItemToolViaMcp(token, id, 'gtd_capture', { title });
        // Inbox has no required metadata, so a capture never carries guidance.
        expect(captured).not.toHaveProperty('fieldGuidance');
        if (typeof captured._id !== 'string') throw new Error('expected the captured item to carry an _id');
        return captured._id;
    }

    it('stamps fieldGuidance on an incomplete nextAction written through gtd_update_item, and drops it once complete', async () => {
        const { token } = await seedUserAndToken();
        stubLoopbackFetch();
        await callMcp(token, INITIALIZE);
        const id = await captureViaMcp(token, 10, 'Renew passport');

        const bare = await callItemToolViaMcp(token, 11, 'gtd_update_item', { id, status: 'nextAction' });
        expect(bare.status).toBe('nextAction');
        expect(bare.fieldGuidance).toMatchObject({ missing: ['energy', 'time', 'workContextIds'] });

        const partial = await callItemToolViaMcp(token, 12, 'gtd_update_item', { id, energy: 'low', time: 20 });
        expect(partial.fieldGuidance).toMatchObject({ missing: ['workContextIds'] });

        const office = await callItemToolViaMcp(token, 13, 'gtd_create_work_context', { name: 'Office' });
        if (typeof office._id !== 'string') throw new Error('expected the work context to carry an _id');
        const complete = await callItemToolViaMcp(token, 14, 'gtd_update_item', { id, workContextIds: [office._id] });
        expect(complete).not.toHaveProperty('fieldGuidance');
        expect(complete.workContextIds).toEqual([office._id]);
    });

    it('asks for location only on a Google-linked calendar item, and reads the stored location back through the projection', async () => {
        const { userId, token } = await seedUserAndToken();
        stubLoopbackFetch();
        await callMcp(token, INITIALIZE);
        const id = await captureViaMcp(token, 30, 'Dentist');

        // No Google Calendar is connected, so scheduling leaves the item unlinked: nothing to set a location on.
        const unlinked = await callItemToolViaMcp(token, 31, 'gtd_update_item', { id, status: 'calendar', timeStart: '2099-04-01T10:00:00' });
        expect(unlinked.status).toBe('calendar');
        expect(unlinked).not.toHaveProperty('fieldGuidance');

        // The sync stamps the link (and later the Google location) server-side; seed both directly.
        await db.collection('items').updateOne({ _id: id, user: userId } as never, { $set: { calendarEventId: 'gcal-evt-dentist' } });
        const linked = await callItemToolViaMcp(token, 32, 'gtd_update_item', { id, title: 'Dentist (cleaning)' });
        expect(linked.fieldGuidance).toMatchObject({ missing: ['location'] });
        expect(linked.fieldGuidance?.hint).toContain('calendarEventId gcal-evt-dentist');

        await db.collection('items').updateOne({ _id: id, user: userId } as never, { $set: { location: 'Room 4B' } });
        const located = await callItemToolViaMcp(token, 33, 'gtd_update_item', { id, notes: 'Bring insurance card' });
        expect(located.location).toBe('Room 4B');
        expect(located).not.toHaveProperty('fieldGuidance');
    });

    it('returns a plain isError payload, with no fieldGuidance, when the update itself is rejected', async () => {
        const { token } = await seedUserAndToken();
        stubLoopbackFetch();
        await callMcp(token, INITIALIZE);
        const id = await captureViaMcp(token, 40, 'Taxes');

        // `energy` is not allowed on an inbox item → 400 status_field_violation from the apply pipeline.
        const result = await callToolViaMcp(token, 41, 'gtd_update_item', { id, energy: 'high' });
        const [block] = result.content;
        if (!block) throw new Error('expected an error content block');
        expect(result.isError).toBe(true);
        expect(block.text).toContain('status_field_violation');
        expect(block.text).not.toContain('fieldGuidance');
    });

    it('asks for expectedBy on a waitingFor item written through gtd_update_item', async () => {
        const { token } = await seedUserAndToken();
        stubLoopbackFetch();
        await callMcp(token, INITIALIZE);

        const id = await captureViaMcp(token, 20, 'Quote from the roofer');

        const waiting = await callItemToolViaMcp(token, 21, 'gtd_update_item', { id, status: 'waitingFor' });
        expect(waiting.fieldGuidance).toMatchObject({ missing: ['expectedBy'] });

        const dated = await callItemToolViaMcp(token, 22, 'gtd_update_item', { id, expectedBy: '2026-10-20' });
        expect(dated).not.toHaveProperty('fieldGuidance');
    });

    it('advertises the completeness rule in the server instructions and the gtd_update_item description', async () => {
        const { token } = await seedUserAndToken();
        stubLoopbackFetch();

        const init = await callMcp(token, INITIALIZE);
        expect((init.body as { result?: { instructions?: string } }).result?.instructions).toContain('fieldGuidance');

        const list = await callMcp(token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const tools = (list.body as { result: { tools: { name: string; description?: string }[] } }).result.tools;
        expect(tools.find((tool) => tool.name === 'gtd_update_item')?.description).toContain('Completeness:');
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
