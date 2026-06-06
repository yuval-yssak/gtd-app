/** Lane A — POST /v1/claude/assist (issue #21, step b: read-only clarify).
 *
 * The Anthropic SDK is mocked at the `anthropicClient` seam so no real API call happens and the
 * tool-use loop is driven by scripted responses. Covers the clarify happy-path (one tool call then
 * a structured proposal), the multi-account ownership guard (404), and the scope guard (403). */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ClaudeRoutes } from '../routes/v1/claude.js';
import { v1ItemsRoutes } from '../routes/v1/items.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

// Mock the client seam. `vi.mock` is hoisted above the imports by Vitest, so the agent loop picks
// up this stub instead of the real Anthropic client — no network call, scripted tool-use loop.
const messagesCreate = vi.fn();
vi.mock('../lib/claude/anthropicClient.js', () => ({
    getAnthropicClient: () => ({ messages: { create: messagesCreate } }),
    CLAUDE_ASSIST_MODEL: 'claude-sonnet-4-6',
}));

// Stub the calendar provider so getCalendarEvents returns canned events (no Google call).
const listEvents = vi.fn();
vi.mock('../lib/buildCalendarProvider.js', () => ({
    buildCalendarProvider: () => ({ listEvents }),
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
        db.collection('calendarIntegrations').deleteMany({}),
        db.collection('calendarSyncConfigs').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    messagesCreate.mockReset();
    listEvents.mockReset();
});

/** Seeds an active integration + its default enabled sync config for the user. */
async function seedCalendar(userId: string) {
    const now = dayjs().toISOString();
    const integration: CalendarIntegrationInterface = {
        _id: 'int-1',
        user: userId,
        provider: 'google',
        accessToken: 'at',
        refreshToken: 'rt',
        tokenExpiry: now,
        createdTs: now,
        updatedTs: now,
    };
    await calendarIntegrationsDAO.insertEncrypted(integration);
    const config: CalendarSyncConfigInterface = {
        _id: 'sync-1',
        integrationId: 'int-1',
        user: userId,
        calendarId: 'primary',
        isDefault: true,
        enabled: true,
        createdTs: now,
        updatedTs: now,
    };
    await calendarSyncConfigsDAO.insertOne(config);
}

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

/** A single-turn final proposal (no tool call). */
function scriptProposal(proposal: unknown) {
    messagesCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(proposal) }],
        usage: { input_tokens: 80, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
}

function apply(plaintext: string, executeToken: string, patch?: unknown) {
    return app.fetch(
        new Request('http://localhost:4000/v1/claude/assist/apply', {
            method: 'POST',
            headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ executeToken, ...(patch !== undefined ? { patch } : {}) }),
        }),
    );
}

/** Runs assist, returns the itemPatch side-effect's executeToken + the proposed patch. */
async function assistAndGetToken(plaintext: string, itemId: string, patch: Record<string, unknown>) {
    scriptProposal({ summary: 'clarified', proposedItemPatch: patch, proposedSideEffects: [] });
    const res = await assist(plaintext, itemId);
    expect(res.status).toBe(200);
    const proposal = (await res.json()) as { proposedSideEffects: Array<{ kind: string; executeToken?: string }> };
    const side = proposal.proposedSideEffects.find((s) => s.kind === 'itemPatch');
    if (!side?.executeToken) throw new Error('expected an itemPatch side-effect with an executeToken');
    return side.executeToken;
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
        const returned = (await res.json()) as {
            summary: string;
            proposedItemPatch: unknown;
            proposedSideEffects: Array<{ kind: string; executeToken?: string }>;
        };
        expect(returned.summary).toBe(proposal.summary);
        expect(returned.proposedItemPatch).toEqual(proposal.proposedItemPatch);
        // The handler mints an executeToken side-effect for the proposed patch (step c).
        expect(returned.proposedSideEffects[0]).toMatchObject({ kind: 'itemPatch' });
        expect(typeof returned.proposedSideEffects[0]?.executeToken).toBe('string');
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

describe('POST /v1/claude/assist/apply (redeem executeToken)', () => {
    it('applies an edited patch with the same target and writes through the op-log', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'raw inbox text', 'ext-apply');

        const token = await assistAndGetToken(plaintext, id, { title: 'Model title', status: 'nextAction' });

        // Edit the payload VALUES (same target fields) — should be accepted on the same token.
        const res = await apply(plaintext, token, { title: 'My edited title', status: 'nextAction' });
        expect(res.status).toBe(200);
        expect((await res.json()) as { applied: boolean }).toMatchObject({ applied: true });

        // The write landed on the item AND went through the op-log (so sync/undo work).
        const updated = await db.collection('items').findOne({ _id: id });
        expect(updated).toMatchObject({ title: 'My edited title', status: 'nextAction' });
        const op = await db.collection('operations').findOne({ entityId: id, opType: 'update', deviceId: { $regex: '^api:' } });
        expect(op).not.toBeNull();
    });

    it('rejects a patch that changes the target (a field outside the authorized set)', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'raw', 'ext-target');

        // Token authorizes only { title }. Submitting `energy` widens the target → reject.
        const token = await assistAndGetToken(plaintext, id, { title: 'Just the title' });
        const res = await apply(plaintext, token, { title: 'ok', energy: 'high' });
        expect(res.status).toBe(400);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'execute_token_target_mismatch' });
    });

    it('rejects non-proposable fields (calendarEventId, _id) — never writable via apply', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'raw', 'ext-nonproposable');

        const token = await assistAndGetToken(plaintext, id, { title: 'ok' });
        // GCal-owned / identity fields are outside PROPOSABLE_ITEM_FIELDS — never writable via apply.
        const res = await apply(plaintext, token, { calendarEventId: 'evil', _id: 'hijack' });
        expect(res.status).toBe(400);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'execute_token_target_mismatch' });
    });

    it('rejects an empty patch (a no-op write is not allowed)', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'raw', 'ext-empty');

        const token = await assistAndGetToken(plaintext, id, { title: 'ok' });
        const res = await apply(plaintext, token, {});
        expect(res.status).toBe(400);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'invalid_request' });
    });

    it('rejects a tampered token', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'raw', 'ext-tamper');

        const token = await assistAndGetToken(plaintext, id, { title: 'x' });
        const tampered = `${token}x`;
        const res = await apply(plaintext, tampered, { title: 'x' });
        expect(res.status).toBe(400);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'invalid_execute_token' });
    });

    it('rejects an expired token', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);

        // Mint a token directly with an issue time far in the past so it is already expired.
        const { signExecuteToken, hashPayload } = await import('../lib/claude/executeToken.js');
        const past = Date.now() - 60 * 60 * 1000;
        const expired = signExecuteToken(
            { kind: 'itemPatch', user: userId, target: { itemId: 'whatever', fields: ['title'] }, payloadHash: hashPayload({ title: 'x' }) },
            past,
        );

        const res = await apply(plaintext, expired, { title: 'x' });
        expect(res.status).toBe(410);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'execute_token_expired' });
    });

    it('rejects a token whose owner is a different account', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);

        const { signExecuteToken, hashPayload } = await import('../lib/claude/executeToken.js');
        const foreign = signExecuteToken({
            kind: 'itemPatch',
            user: 'a-different-user',
            target: { itemId: 'x', fields: ['title'] },
            payloadHash: hashPayload({ title: 'x' }),
        });

        const res = await apply(plaintext, foreign, { title: 'x' });
        expect(res.status).toBe(403);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'forbidden' });
    });

    it('returns 400 when executeToken is missing', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/claude/assist/apply', {
                method: 'POST',
                headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ patch: { title: 'x' } }),
            }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'invalid_request' });
    });
});

describe('getCalendarEvents tool (gated on a connected calendar)', () => {
    it('omits the getCalendarEvents tool when the owner has no calendar', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'no calendar', 'ext-nocal');

        scriptProposal({ summary: 'ok', proposedSideEffects: [] });
        await assist(plaintext, id);

        const [firstCallParams] = messagesCreate.mock.calls[0] as [{ tools: Array<{ name: string }> }];
        const toolNames = firstCallParams.tools.map((t) => t.name);
        expect(toolNames).not.toContain('getCalendarEvents');
    });

    it('includes getCalendarEvents and serves owner-scoped events when a calendar is connected', async () => {
        const { userId } = await login();
        await seedCalendar(userId);
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'prep for the standup', 'ext-cal');

        listEvents.mockResolvedValueOnce([
            {
                id: 'evt-1',
                title: 'Daily Standup',
                timeStart: '2026-06-08T09:00:00Z',
                timeEnd: '2026-06-08T09:30:00Z',
                updated: '2026-06-01T00:00:00Z',
                status: 'confirmed',
            },
        ]);
        scriptToolThenProposal(
            'getCalendarEvents',
            { since: '2026-06-08T00:00:00Z', until: '2026-06-09T00:00:00Z' },
            { summary: 'Found your standup.', proposedSideEffects: [] },
        );

        const res = await assist(plaintext, id);
        expect(res.status).toBe(200);

        // The tool was offered...
        const [firstCallParams] = messagesCreate.mock.calls[0] as [{ tools: Array<{ name: string }> }];
        expect(firstCallParams.tools.map((t) => t.name)).toContain('getCalendarEvents');
        // ...the provider was called with the resolved calendarId + window...
        expect(listEvents).toHaveBeenCalledWith('primary', '2026-06-08T00:00:00Z', '2026-06-09T00:00:00Z');
        // ...and the event summary was fed back to the model (not credentials).
        const [secondCallParams] = messagesCreate.mock.calls[1] as [{ messages: Array<{ role: string; content: unknown }> }];
        const serialized = JSON.stringify(secondCallParams.messages);
        expect(serialized).toContain('Daily Standup');
        expect(serialized).not.toContain('refreshToken');
    });

    it('applies a calendar side-effect expressed as item calendar fields, through the op-log', async () => {
        const { userId } = await login();
        await seedCalendar(userId);
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'lunch with sam thursday noon', 'ext-calapply');

        // The model proposes turning the item into a calendar entry (status + timeStart/timeEnd).
        const patch = { status: 'calendar', timeStart: '2026-06-11T12:00:00Z', timeEnd: '2026-06-11T13:00:00Z' };
        const token = await assistAndGetToken(plaintext, id, patch);
        const res = await apply(plaintext, token, patch);
        expect(res.status).toBe(200);

        const updated = await db.collection('items').findOne({ _id: id });
        expect(updated).toMatchObject({ status: 'calendar', timeStart: '2026-06-11T12:00:00Z', timeEnd: '2026-06-11T13:00:00Z' });
        const op = await db.collection('operations').findOne({ entityId: id, opType: 'update', deviceId: { $regex: '^api:' } });
        expect(op).not.toBeNull();
    });

    it('degrades to no-calendar when an integration row is corrupt/undecryptable (does not fail clarify)', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'corrupt cal', 'ext-corrupt');

        // Insert a row with non-encrypted (undecryptable) tokens directly, bypassing insertEncrypted —
        // simulates a row encrypted under a rotated key. findByUserDecrypted will throw on decrypt.
        const now = dayjs().toISOString();
        await db.collection('calendarIntegrations').insertOne({
            _id: 'int-bad',
            user: userId,
            provider: 'google',
            accessToken: 'not-encrypted',
            refreshToken: 'not-encrypted',
            tokenExpiry: now,
            createdTs: now,
            updatedTs: now,
        });

        scriptProposal({ summary: 'ok', proposedSideEffects: [] });
        const res = await assist(plaintext, id);
        expect(res.status).toBe(200);
        // Calendar resolution failed → the tool is simply omitted, clarify still works.
        const [firstCallParams] = messagesCreate.mock.calls[0] as [{ tools: Array<{ name: string }> }];
        expect(firstCallParams.tools.map((t) => t.name)).not.toContain('getCalendarEvents');
    });

    it('omits getCalendarEvents when the integration is revoked', async () => {
        const { userId } = await login();
        await seedCalendar(userId);
        await calendarIntegrationsDAO.updateOne({ _id: 'int-1' }, { $set: { status: 'revoked' } });
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'revoked cal', 'ext-revoked');

        scriptProposal({ summary: 'ok', proposedSideEffects: [] });
        await assist(plaintext, id);
        const [firstCallParams] = messagesCreate.mock.calls[0] as [{ tools: Array<{ name: string }> }];
        expect(firstCallParams.tools.map((t) => t.name)).not.toContain('getCalendarEvents');
    });

    it('omits getCalendarEvents when there is no enabled sync config', async () => {
        const { userId } = await login();
        await seedCalendar(userId);
        await calendarSyncConfigsDAO.updateOne({ _id: 'sync-1' }, { $set: { enabled: false } });
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        const id = await captureInboxItem(plaintext, 'disabled cal', 'ext-disabled');

        scriptProposal({ summary: 'ok', proposedSideEffects: [] });
        await assist(plaintext, id);
        const [firstCallParams] = messagesCreate.mock.calls[0] as [{ tools: Array<{ name: string }> }];
        expect(firstCallParams.tools.map((t) => t.name)).not.toContain('getCalendarEvents');
    });
});
