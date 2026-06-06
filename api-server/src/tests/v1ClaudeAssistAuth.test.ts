/** Lane A dual-auth — `authenticateBearerOrSession` on /v1/claude/* (issue #21, client bridge).
 *
 * The assist routes are otherwise bearer-only, but the first-party client authenticates with a
 * Better Auth COOKIE SESSION. These tests prove the dual-auth middleware:
 *   - the bearer path is unchanged (scope still enforced → 403 without `claude.assist`),
 *   - a cookie session (no Authorization header) reaches the handler with its userId set,
 *   - no auth at all → 401,
 *   - a session-driven apply writes an op whose deviceId is `api:session:<sessionId>` (so it fans
 *     out to all of the user's devices including the originator).
 *
 * The Anthropic SDK is mocked at the `anthropicClient` seam (no network, scripted responses).
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ClaudeRoutes } from '../routes/v1/claude.js';
import { v1Routes } from '../routes/v1/index.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const messagesCreate = vi.fn();
vi.mock('../lib/claude/anthropicClient.js', () => ({
    getAnthropicClient: () => ({ messages: { create: messagesCreate } }),
    CLAUDE_ASSIST_MODEL: 'claude-sonnet-4-6',
}));

// Mount exactly as index.ts does: the assist routes are mounted SEPARATELY and BEFORE the rest of
// /v1, so a sibling bearer-only sub-router's catch-all middleware can't pre-empt a session request
// to /v1/claude/* before `authenticateBearerOrSession` runs (see routes/v1/index.ts comment).
const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/v1', v1ClaudeRoutes)
    .route('/v1', v1Routes);

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
        db.collection('operations').deleteMany({}),
        db.collection('apiTokens').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    messagesCreate.mockReset();
});

/** Logs in via OAuth and returns both the session cookie and the resolved userId. */
async function login(profileOverrides: Record<string, unknown> = {}) {
    const { sessionCookie } = await oauthLogin(app, 'google', profileOverrides);
    if (!sessionCookie) throw new Error('expected a session cookie from oauthLogin');
    const sessionRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    return { sessionCookie, userId: user.id };
}

/** POST /v1/claude/assist using the COOKIE session (no Authorization header). */
function assistWithSession(sessionCookie: string, body: unknown) {
    return app.fetch(
        new Request('http://localhost:4000/v1/claude/assist', {
            method: 'POST',
            headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

function scriptProposal(proposal: unknown) {
    messagesCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(proposal) }],
        usage: { input_tokens: 80, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
}

describe('authenticateBearerOrSession — bearer path (unchanged)', () => {
    it('a bearer token carrying claude.assist still reaches the handler', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'claude.assist']);
        // Missing itemId reaches the handler's validation → 400 invalid_request (proves auth passed).
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

    it('a bearer token WITHOUT claude.assist is still rejected (403 forbidden_scope)', async () => {
        const { userId } = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/claude/assist', {
                method: 'POST',
                headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ itemId: 'whatever' }),
            }),
        );
        expect(res.status).toBe(403);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'forbidden_scope' });
    });
});

describe('authenticateBearerOrSession — cookie-session path', () => {
    it('a cookie session (no Authorization) reaches the handler — 400 on missing itemId', async () => {
        const { sessionCookie } = await login();
        const res = await assistWithSession(sessionCookie, {});
        expect(res.status).toBe(400);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'invalid_request' });
    });

    it('the session sets apiAuth.userId — 404 for an item owned by another user', async () => {
        const { sessionCookie } = await login();
        const now = new Date().toISOString();
        await itemsDAO.insertOne({ _id: 'foreign-1', user: 'some-other-user', status: 'inbox', title: 'not yours', createdTs: now, updatedTs: now });
        const res = await assistWithSession(sessionCookie, { itemId: 'foreign-1' });
        expect(res.status).toBe(404);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'not_found' });
        expect(messagesCreate).not.toHaveBeenCalled();
    });

    it('the session is NOT rejected by requireScope (claude.assist is synthesised)', async () => {
        const { sessionCookie, userId } = await login();
        const now = new Date().toISOString();
        await itemsDAO.insertOne({ _id: 'own-1', user: userId, status: 'inbox', title: 'clarify me', createdTs: now, updatedTs: now });
        scriptProposal({ summary: 'ok', proposedSideEffects: [] });
        const res = await assistWithSession(sessionCookie, { itemId: 'own-1' });
        expect(res.status).toBe(200);
        // A forbidden_scope would have been a 403 before any model call.
        expect(messagesCreate).toHaveBeenCalledTimes(1);
    });

    it('bearer takes precedence over a co-present session cookie', async () => {
        // Both a bearer header AND a session cookie are present. The bearer path runs first, so its
        // scopes govern: a bearer token LACKING claude.assist is rejected (403) even though a session
        // would have synthesised the scope and passed. Proves the bearer identity wins, not the session.
        const { sessionCookie, userId } = await login();
        const { plaintext } = await issueApiToken(userId, 'no-scope', ['items.capture', 'items.read']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/claude/assist', {
                method: 'POST',
                headers: { Authorization: `Bearer ${plaintext}`, Cookie: `${SESSION_COOKIE}=${sessionCookie}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ itemId: 'x' }),
            }),
        );
        expect(res.status).toBe(403);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'forbidden_scope' });
    });

    it('a REVOKED bearer token falls through to the session cookie', async () => {
        // resolveBearerApiAuth returns null for a revoked token, so the middleware falls through to
        // the session — which synthesises claude.assist and reaches the handler (400 on missing itemId).
        const { sessionCookie, userId } = await login();
        const { plaintext, record } = await issueApiToken(userId, 'to-revoke', ['items.capture', 'items.read', 'claude.assist']);
        await apiTokensDAO.revokeById(record._id, userId, new Date().toISOString());
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/claude/assist', {
                method: 'POST',
                headers: { Authorization: `Bearer ${plaintext}`, Cookie: `${SESSION_COOKIE}=${sessionCookie}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'invalid_request' });
    });

    it('no auth at all → 401 unauthorized', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/claude/assist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ itemId: 'x' }),
            }),
        );
        expect(res.status).toBe(401);
        expect((await res.json()) as { code: string }).toMatchObject({ code: 'unauthorized' });
    });
});

describe('authenticateBearerOrSession — session apply uses an api:session: deviceId', () => {
    it('writes an op whose deviceId is api:session:<sessionId>', async () => {
        const { sessionCookie, userId } = await login();
        const now = new Date().toISOString();
        await itemsDAO.insertOne({ _id: 'apply-1', user: userId, status: 'inbox', title: 'raw', createdTs: now, updatedTs: now });

        // Clarify to get a token, then apply — both via the cookie session.
        scriptProposal({ summary: 'clarified', proposedItemPatch: { title: 'Clarified', status: 'nextAction' }, proposedSideEffects: [] });
        const clarifyRes = await assistWithSession(sessionCookie, { itemId: 'apply-1' });
        expect(clarifyRes.status).toBe(200);
        const proposal = (await clarifyRes.json()) as { proposedSideEffects: Array<{ kind: string; executeToken?: string }> };
        const side = proposal.proposedSideEffects.find((s) => s.kind === 'itemPatch');
        if (!side?.executeToken) throw new Error('expected an itemPatch side-effect with an executeToken');

        const applyRes = await app.fetch(
            new Request('http://localhost:4000/v1/claude/assist/apply', {
                method: 'POST',
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ executeToken: side.executeToken, patch: { title: 'Clarified', status: 'nextAction' } }),
            }),
        );
        expect(applyRes.status).toBe(200);
        expect((await applyRes.json()) as { applied: boolean }).toMatchObject({ applied: true });

        const op = await db.collection('operations').findOne({ entityId: 'apply-1', opType: 'update' });
        expect(op).not.toBeNull();
        expect((op as { deviceId: string }).deviceId).toMatch(/^api:session:/);
    });
});
