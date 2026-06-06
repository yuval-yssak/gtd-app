/** Lane A — POST /v1/claude/assist (issue #21, step b: read-only clarify).
 *
 * The Anthropic SDK is mocked at the `anthropicClient` seam so no real API call happens and the
 * tool-use loop is driven by scripted responses. Covers the clarify happy-path (one tool call then
 * a structured proposal), the multi-account ownership guard (404), and the scope guard (403). */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ClaudeRoutes } from '../routes/v1/claude.js';
import { v1ItemsRoutes } from '../routes/v1/items.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

// Mock the client seam. `vi.mock` is hoisted above the imports by Vitest, so the agent loop picks
// up this stub instead of the real Anthropic client — no network call, scripted tool-use loop.
const messagesCreate = vi.fn();
vi.mock('../lib/claude/anthropicClient.js', () => ({
    getAnthropicClient: () => ({ messages: { create: messagesCreate } }),
    CLAUDE_ASSIST_MODEL: 'claude-sonnet-4-6',
}));

const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/v1', v1ItemsRoutes)
    .route('/v1', v1ClaudeRoutes);

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
        db.collection('items').deleteMany({}),
        db.collection('people').deleteMany({}),
        db.collection('workContexts').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('apiTokens').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    messagesCreate.mockReset();
});

async function login(profileOverrides: Record<string, unknown> = {}) {
    const { sessionCookie } = await oauthLogin(app, 'google', profileOverrides);
    const sessionRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    return { userId: user.id };
}

async function captureInboxItem(plaintext: string, title: string, externalId: string): Promise<string> {
    const res = await app.fetch(
        new Request('http://localhost:4000/v1/items', {
            method: 'POST',
            headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, externalId }),
        }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { _id: string })._id;
}

function assist(plaintext: string, itemId: string, instruction?: string) {
    return app.fetch(
        new Request('http://localhost:4000/v1/claude/assist', {
            method: 'POST',
            headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId, ...(instruction ? { instruction } : {}) }),
        }),
    );
}

/** A tool-use turn the loop will answer, then a final structured proposal. */
function scriptToolThenProposal(toolName: string, toolInput: unknown, proposal: unknown) {
    messagesCreate
        .mockResolvedValueOnce({
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_1', name: toolName, input: toolInput }],
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        })
        .mockResolvedValueOnce({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(proposal) }],
            usage: { input_tokens: 150, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        });
}

describe('POST /v1/claude/assist (clarify, read-only)', () => {
    it('runs the tool loop and returns the structured proposal', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'ask dana to send the deck', 'ext-1');

        const proposal = {
            summary: 'Turn this into a next action to follow up with Dana.',
            proposedItemPatch: { title: 'Follow up with Dana on the deck', status: 'nextAction', energy: 'low' },
            proposedSideEffects: [],
        };
        scriptToolThenProposal('searchItems', { query: 'deck' }, proposal);

        const res = await assist(plaintext, id, 'clarify this');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(proposal);
        // The loop made exactly two model calls (one tool turn + final proposal).
        expect(messagesCreate).toHaveBeenCalledTimes(2);
        // Structured-output + tools must actually be wired into the request (guards a refactor
        // silently dropping either).
        const [firstCallParams] = messagesCreate.mock.calls[0] as [{ tools: unknown[]; output_config: { format: { type: string } } }];
        expect(firstCallParams.tools.length).toBeGreaterThan(0);
        expect(firstCallParams.output_config.format.type).toBe('json_schema');
    });

    it('scopes tool reads to the item owner, not other users data', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'plan the trip', 'ext-scope');

        // Owner's people + a decoy person under a different user. listPeople must return only the owner's.
        const now = new Date().toISOString();
        await db.collection('people').insertMany([
            { _id: 'p-own', user: userId, name: 'Owned Person', createdTs: now, updatedTs: now },
            { _id: 'p-other', user: 'someone-else', name: 'Decoy Person', createdTs: now, updatedTs: now },
        ]);

        // Capture what the tool returned by inspecting the tool_result fed back on the 2nd call.
        scriptToolThenProposal('listPeople', {}, { summary: 'ok', proposedSideEffects: [] });
        await assist(plaintext, id);

        const [secondCallParams] = messagesCreate.mock.calls[1] as [{ messages: Array<{ role: string; content: unknown }> }];
        const toolResultMsg = secondCallParams.messages.find((m) => m.role === 'user' && Array.isArray(m.content));
        const serialized = JSON.stringify(toolResultMsg);
        expect(serialized).toContain('Owned Person');
        expect(serialized).not.toContain('Decoy Person');
    });

    it('returns a safe summary-only proposal when the model output is not valid JSON', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'malformed', 'ext-malformed');

        messagesCreate.mockResolvedValueOnce({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'not json {' }],
            usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        });

        const res = await assist(plaintext, id);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ summary: 'Could not produce a structured proposal.', proposedSideEffects: [] });
    });

    it('stops after the tool-call limit and returns the limit summary, never inventing a write', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'loops', 'ext-loops');

        // Always ask for a tool — the loop must cap itself at 6 iterations.
        messagesCreate.mockResolvedValue({
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_n', name: 'listPeople', input: {} }],
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        });

        const res = await assist(plaintext, id);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ summary: 'Reached the tool-call limit before producing a full proposal.', proposedSideEffects: [] });
        expect(messagesCreate).toHaveBeenCalledTimes(6);
    });

    it('feeds an is_error tool_result back to the model on an unknown tool, without failing the request', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'bad tool', 'ext-badtool');

        messagesCreate
            .mockResolvedValueOnce({
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'toolu_x', name: 'noSuchTool', input: {} }],
                usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            })
            .mockResolvedValueOnce({
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: JSON.stringify({ summary: 'recovered', proposedSideEffects: [] }) }],
                usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            });

        const res = await assist(plaintext, id);
        expect(res.status).toBe(200);
        const [secondCallParams] = messagesCreate.mock.calls[1] as [{ messages: Array<{ role: string; content: unknown }> }];
        expect(JSON.stringify(secondCallParams.messages)).toContain('"is_error":true');
    });

    it('returns 404 when the item is owned by a different account (multi-account guard)', async () => {
        // The caller is a real authenticated user; the item is owned by a DIFFERENT user id
        // (seeded directly, so the guard is exercised without depending on the OAuth identity mock).
        const { userId: callerId } = await login();
        const { plaintext: callerToken } = await issueApiToken(callerId, 'caller', ['items.capture', 'items.read', 'claude.assist']);

        const now = new Date().toISOString();
        const foreignItemId = 'foreign-item-1';
        await itemsDAO.insertOne({ _id: foreignItemId, user: 'some-other-user-id', status: 'inbox', title: 'not yours', createdTs: now, updatedTs: now });

        const res = await assist(callerToken, foreignItemId);
        expect(res.status).toBe(404);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'not_found' });
        // No model call should happen for an unauthorized item.
        expect(messagesCreate).not.toHaveBeenCalled();
    });

    it('returns 403 when the token lacks the claude.assist scope', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read']);
        const id = await captureInboxItem(plaintext, 'no scope', 'ext-noscope');

        const res = await assist(plaintext, id);
        expect(res.status).toBe(403);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'forbidden_scope' });
        expect(messagesCreate).not.toHaveBeenCalled();
    });

    it('returns 400 when itemId is missing', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);

        const res = await app.fetch(
            new Request('http://localhost:4000/v1/claude/assist', {
                method: 'POST',
                headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'invalid_request' });
    });
});
