/** POST /v1/items/:id/brief/generate — dual auth, scope gate, ownership, outcomes, per-user cap,
 * and the credentialed CORS wiring that mirrors index.ts. The Anthropic client is mocked. */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { assistCors, publicCors } from '../auth/corsProfiles.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import itemBriefsDAO from '../dataAccess/itemBriefsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { generationBucket } from '../lib/brief/briefCap.js';
import { briefSourceHash } from '../lib/briefSource.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1Routes } from '../routes/v1/index.js';
import { parseForce, v1BriefGenerateRoutes } from '../routes/v1/itemBriefGenerate.js';
import type { PublicItem } from '../routes/v1/projections/item.js';
import type { ApiTokenScope, BriefOrigin, ItemBriefInterface, ItemInterface, OperationInterface } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const messagesCreate = vi.fn();
vi.mock('../lib/claude/anthropicClient.js', () => ({
    getAnthropicClient: () => {
        if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
        return { messages: { create: messagesCreate } };
    },
}));

// Mirrors index.ts: the generate router is mounted BEFORE the bearer-only v1 routers, under the
// credentialed profile on its exact path, while everything else under /v1 keeps publicCors.
const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .use('/v1/items/:id/brief/generate', assistCors())
    .route('/v1', v1BriefGenerateRoutes)
    .use('/v1/*', publicCors())
    .route('/v1', v1Routes);

beforeAll(async () => {
    await loadDataAccess('gtd_test_v1_brief_generate');
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
        db.collection('itemBriefs').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('apiTokens').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    messagesCreate.mockReset();
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('BRIEF_FAKE_MODEL', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

interface Session {
    userId: string;
    sessionCookie: string;
}

async function login(provider: 'google' | 'github' = 'google', overrides: Record<string, unknown> = {}): Promise<Session> {
    const { sessionCookie } = await oauthLogin(app, provider, overrides);
    if (!sessionCookie) throw new Error('login produced no session cookie');
    const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await res.json()) as { user: { id: string } };
    return { userId: user.id, sessionCookie };
}

async function bearer(userId: string, scopes: ApiTokenScope[] = ['items.write']): Promise<{ token: string; tokenId: string }> {
    const { plaintext, record } = await issueApiToken(userId, 'agent', scopes);
    return { token: plaintext, tokenId: record._id };
}

// Comfortably over the 160-char skip threshold so the model path is exercised.
const LONG_NOTES =
    'Expires in March; need photos and the old passport. The consulate only takes appointments on weekday mornings, ' +
    'and the earliest slot is usually three weeks out, so the photos have to be done before booking.';

async function seedItem(userId: string, overrides: Partial<ItemInterface> = {}): Promise<string> {
    const now = dayjs().toISOString();
    const id = `item-${Math.random().toString(36).slice(2)}`;
    await itemsDAO.insertOne({
        _id: id,
        user: userId,
        status: 'nextAction',
        title: 'Renew passport',
        notes: LONG_NOTES,
        createdTs: now,
        updatedTs: now,
        ...overrides,
    });
    return id;
}

async function seedBrief(userId: string, itemId: string, origin: BriefOrigin): Promise<void> {
    const item = await itemsDAO.findByOwnerAndId(itemId, userId);
    if (!item) throw new Error('seed item first');
    const now = dayjs().toISOString();
    const row: ItemBriefInterface = {
        _id: itemId,
        user: userId,
        itemId,
        text: `${origin} brief`,
        origin,
        sourceHash: briefSourceHash(item.title, item.notes),
        generatedTs: now,
        createdTs: now,
        updatedTs: now,
    };
    await itemBriefsDAO.insertOne(row);
}

type Auth = { token: string } | { sessionCookie: string };

function generate(itemId: string, who: Auth, body?: unknown, origin?: string): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if ('token' in who) headers.Authorization = `Bearer ${who.token}`;
    else headers.Cookie = `${SESSION_COOKIE}=${who.sessionCookie}`;
    if (origin) headers.Origin = origin;
    return app.fetch(new Request(`http://localhost:4000/v1/items/${itemId}/brief/generate`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }));
}

function modelSays(brief: string | null) {
    messagesCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ brief }) }] });
}

interface GenerateResponse {
    outcome: string;
    item: PublicItem;
    brief: ItemBriefInterface | null;
}

async function briefOps(userId: string): Promise<OperationInterface[]> {
    return db
        .collection('operations')
        .find<OperationInterface>({ user: userId, entityType: 'itemBrief' } as never)
        .toArray();
}

describe('POST /v1/items/:id/brief/generate — auth', () => {
    it('accepts the first-party session cookie and stamps the op server:brief-ondemand', async () => {
        const session = await login();
        const itemId = await seedItem(session.userId);
        modelSays('Passport renewal still blocked on photos.');
        const res = await generate(itemId, session);
        expect(res.status).toBe(200);
        const body = (await res.json()) as GenerateResponse;
        expect(body.outcome).toBe('written');
        expect(body.item.brief).toEqual({
            text: 'Passport renewal still blocked on photos.',
            origin: 'model',
            state: 'fresh',
            generatedTs: expect.any(String),
        });
        expect(body.brief).toMatchObject({
            _id: itemId,
            itemId,
            user: session.userId,
            origin: 'model',
            model: 'claude-haiku-4-5',
            text: 'Passport renewal still blocked on photos.',
        });
        const [op] = await briefOps(session.userId);
        expect(op).toMatchObject({ opType: 'create', deviceId: 'server:brief-ondemand' });
    });

    it('accepts a bearer token with items.write and stamps api:<tokenId>', async () => {
        const session = await login();
        const { token, tokenId } = await bearer(session.userId);
        const itemId = await seedItem(session.userId);
        modelSays('x');
        const res = await generate(itemId, { token });
        expect(res.status).toBe(200);
        const [op] = await briefOps(session.userId);
        expect(op?.deviceId).toBe(`api:${tokenId}`);
    });

    it('rejects a bearer token without items.write (403 forbidden_scope) and an anonymous call (401)', async () => {
        const session = await login();
        const { token } = await bearer(session.userId, ['items.read', 'claude.assist']);
        const itemId = await seedItem(session.userId);
        const forbidden = await generate(itemId, { token });
        expect(forbidden.status).toBe(403);
        expect((await forbidden.json()) as unknown).toMatchObject({ code: 'forbidden_scope' });
        const anonymous = await app.fetch(new Request(`http://localhost:4000/v1/items/${itemId}/brief/generate`, { method: 'POST' }));
        expect(anonymous.status).toBe(401);
        expect(messagesCreate).not.toHaveBeenCalled();
    });

    it("returns 404 for another user's item and for a missing item", async () => {
        const alice = await login();
        const bob = await login('github', { email: 'bob@example.com', login: 'bob-gh' });
        const bobsItem = await seedItem(bob.userId);
        expect((await generate(bobsItem, alice)).status).toBe(404);
        expect((await generate('nope', alice)).status).toBe(404);
        expect(messagesCreate).not.toHaveBeenCalled();
    });

    it('does not open the bearer-only /v1/items surface to session cookies', async () => {
        const session = await login();
        const res = await app.fetch(new Request('http://localhost:4000/v1/items', { headers: { Cookie: `${SESSION_COOKIE}=${session.sessionCookie}` } }));
        expect(res.status).toBe(401);
    });
});

describe('POST /v1/items/:id/brief/generate — outcomes', () => {
    it('409 brief_pinned on a user/agent brief without force; force replaces it', async () => {
        const session = await login();
        const itemId = await seedItem(session.userId);
        await seedBrief(session.userId, itemId, 'agent');
        modelSays('regenerated');
        const pinned = await generate(itemId, session);
        expect(pinned.status).toBe(409);
        expect((await pinned.json()) as unknown).toMatchObject({ code: 'brief_pinned' });
        expect(messagesCreate).not.toHaveBeenCalled();

        const forced = await generate(itemId, session, { force: true });
        expect(forced.status).toBe(200);
        const body = (await forced.json()) as GenerateResponse;
        expect(body.outcome).toBe('written');
        expect(body.item.brief).toMatchObject({ origin: 'model', text: 'regenerated', state: 'fresh' });
        expect(messagesCreate).toHaveBeenCalledTimes(1);
    });

    it.each(['done', 'trash'] as const)('409 brief_not_applicable for a %s item, with no model call', async (status) => {
        const session = await login();
        const itemId = await seedItem(session.userId, { status });
        modelSays('should never be generated');
        const res = await generate(itemId, session);
        expect(res.status).toBe(409);
        expect((await res.json()) as unknown).toMatchObject({ code: 'brief_not_applicable' });
        expect(messagesCreate).not.toHaveBeenCalled();
        expect(await itemBriefsDAO.countDocuments({ _id: itemId })).toBe(0);
    });

    it('force does NOT override brief_not_applicable — a closed item is out of scope, not protected', async () => {
        const session = await login();
        const itemId = await seedItem(session.userId, { status: 'done' });
        const res = await generate(itemId, session, { force: true });
        expect(res.status).toBe(409);
        expect((await res.json()) as unknown).toMatchObject({ code: 'brief_not_applicable' });
        expect(messagesCreate).not.toHaveBeenCalled();
    });

    it('keeps a brief already written for an item that is later closed, and refuses to regenerate it', async () => {
        const session = await login();
        const itemId = await seedItem(session.userId);
        await seedBrief(session.userId, itemId, 'model');
        await itemsDAO.updateOne({ _id: itemId }, { $set: { status: 'done' } });
        expect((await generate(itemId, session)).status).toBe(409);
        // The paid-for row survives: a revive from done must find its brief intact.
        expect(await itemBriefsDAO.countDocuments({ _id: itemId })).toBe(1);
    });

    it('generates again once the item is revived to a live status', async () => {
        const session = await login();
        const itemId = await seedItem(session.userId, { status: 'trash' });
        expect((await generate(itemId, session)).status).toBe(409);
        await itemsDAO.updateOne({ _id: itemId }, { $set: { status: 'nextAction' } });
        modelSays('Passport renewal still blocked on photos.');
        expect((await generate(itemId, session)).status).toBe(200);
    });

    it('skip rule: short notes write a skipped row without any model call', async () => {
        const session = await login();
        const itemId = await seedItem(session.userId, { notes: 'too short' });
        const res = await generate(itemId, session);
        expect(res.status).toBe(200);
        const body = (await res.json()) as GenerateResponse;
        expect(body.outcome).toBe('skipped');
        expect(body.brief).toMatchObject({ origin: 'skipped', text: null });
        // `declined`, not `none`: the row records a decision about exactly this text, and the app
        // renders that as an explicit "no brief — the title already says it" rather than a blank.
        expect(body.item.brief).toMatchObject({ origin: 'skipped', text: null, state: 'declined' });
        expect(messagesCreate).not.toHaveBeenCalled();
        // A second call finds the row current and still reports skipped, writing nothing new.
        expect(((await (await generate(itemId, session)).json()) as GenerateResponse).outcome).toBe('skipped');
        expect(await briefOps(session.userId)).toHaveLength(1);
    });

    it('discarded_stale when the item changes while the model runs: nothing written, brief null', async () => {
        const session = await login();
        const itemId = await seedItem(session.userId);
        messagesCreate.mockImplementation(async () => {
            await itemsDAO.updateOne({ _id: itemId }, { $set: { notes: `${LONG_NOTES} (edited mid-flight)` } });
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ brief: 'late' }) }] };
        });
        const res = await generate(itemId, session);
        expect(res.status).toBe(200);
        const body = (await res.json()) as GenerateResponse;
        expect(body.outcome).toBe('discarded_stale');
        expect(body.brief).toBeNull();
        expect(body.item.brief).toBeNull();
        expect(await briefOps(session.userId)).toHaveLength(0);
    });

    it('stores a null-text model brief when the model says the title says it all', async () => {
        const session = await login();
        const itemId = await seedItem(session.userId);
        modelSays(null);
        const body = (await (await generate(itemId, session)).json()) as GenerateResponse;
        expect(body.outcome).toBe('written');
        expect(body.brief).toMatchObject({ origin: 'model', text: null });
        // The decision is visible, not silent: the projection reports `declined`, which the app
        // renders as "no brief — nothing in the notes to summarise" instead of an empty field.
        expect(body.item.brief).toMatchObject({ origin: 'model', text: null, state: 'declined' });
    });

    it('maps model failures: refusal → 502 brief_generation_failed, no key → 503 agent_unavailable', async () => {
        const session = await login();
        const itemId = await seedItem(session.userId);
        messagesCreate.mockResolvedValue({ stop_reason: 'refusal', content: [] });
        const refused = await generate(itemId, session);
        expect(refused.status).toBe(502);
        expect((await refused.json()) as unknown).toMatchObject({ code: 'brief_generation_failed' });

        vi.stubEnv('ANTHROPIC_API_KEY', '');
        const down = await generate(itemId, session);
        expect(down.status).toBe(503);
        expect((await down.json()) as unknown).toMatchObject({ code: 'agent_unavailable' });
        expect(await briefOps(session.userId)).toHaveLength(0);
    });

    it('uses the fake seam when BRIEF_FAKE_MODEL=1', async () => {
        vi.stubEnv('BRIEF_FAKE_MODEL', '1');
        const session = await login();
        const itemId = await seedItem(session.userId);
        const body = (await (await generate(itemId, session)).json()) as GenerateResponse;
        expect(body.brief).toMatchObject({ model: 'fake', text: '[fake] Expires in March; need photos and the old passport' });
        expect(messagesCreate).not.toHaveBeenCalled();
    });
});

describe('POST /v1/items/:id/brief/generate — per-user generation cap', () => {
    it('returns 429 with Retry-After past BRIEF_GENERATE_PER_10MIN, shared across the user tokens, and does not charge skip hits', async () => {
        vi.stubEnv('BRIEF_GENERATE_PER_10MIN', '2');
        const session = await login();
        const { token } = await bearer(session.userId);
        const longItem = await seedItem(session.userId);
        const shortItem = await seedItem(session.userId, { notes: 'short' });
        modelSays('x');

        expect((await generate(shortItem, session)).status).toBe(200);
        expect((await generate(longItem, session)).status).toBe(200);
        expect((await generate(longItem, { token })).status).toBe(200);
        const capped = await generate(longItem, session);
        expect(capped.status).toBe(429);
        expect((await capped.json()) as unknown).toMatchObject({ code: 'rate_limited' });
        expect(Number(capped.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(messagesCreate).toHaveBeenCalledTimes(2);
        // Skip-rule hits stay free even while the cap is exhausted.
        expect((await generate(shortItem, session)).status).toBe(200);
    });

    it('a pinned refusal is free: it neither calls the model nor charges the cap', async () => {
        vi.stubEnv('BRIEF_GENERATE_PER_10MIN', '1');
        const session = await login();
        const itemId = await seedItem(session.userId);
        await seedBrief(session.userId, itemId, 'user');
        modelSays('x');
        expect((await generate(itemId, session)).status).toBe(409);
        expect((await generate(itemId, session)).status).toBe(409);
        expect(messagesCreate).not.toHaveBeenCalled();
        expect((await generate(itemId, session, { force: true })).status).toBe(200);
    });

    it('a failed model call still consumes a generation (the key was spent)', async () => {
        vi.stubEnv('BRIEF_GENERATE_PER_10MIN', '1');
        const session = await login();
        const itemId = await seedItem(session.userId);
        messagesCreate.mockResolvedValue({ stop_reason: 'refusal', content: [] });
        expect((await generate(itemId, session)).status).toBe(502);
        expect((await generate(itemId, session)).status).toBe(429);
    });
});

describe('request parsing and cap configuration', () => {
    it('parseForce is strict: only the boolean true forces', () => {
        expect(parseForce({ force: true })).toBe(true);
        expect(parseForce({ force: 'true' })).toBe(false);
        expect(parseForce({ force: 1 })).toBe(false);
        expect(parseForce({})).toBe(false);
        expect(parseForce(null)).toBe(false);
        expect(parseForce('force')).toBe(false);
    });

    it('generationBucket falls back to 30 per 10 minutes on a missing or invalid BRIEF_GENERATE_PER_10MIN', () => {
        for (const raw of ['', '0', '-5', 'abc', '2.5']) {
            vi.stubEnv('BRIEF_GENERATE_PER_10MIN', raw);
            expect(generationBucket()).toEqual({ capacity: 30, refillPerSec: 30 / 600 });
        }
        vi.stubEnv('BRIEF_GENERATE_PER_10MIN', '12');
        expect(generationBucket()).toEqual({ capacity: 12, refillPerSec: 12 / 600 });
    });

    it('throttles an unauthenticated flood with the per-IP anon bucket (30/min → 429)', async () => {
        const hit = () =>
            app.fetch(new Request('http://localhost:4000/v1/items/x/brief/generate', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' } }));
        for (let i = 0; i < 30; i++) {
            expect((await hit()).status).toBe(401);
        }
        const throttled = await hit();
        expect(throttled.status).toBe(429);
        expect(throttled.headers.get('Retry-After')).not.toBeNull();
    });
});

describe('CORS wiring (mirrors index.ts)', () => {
    it('answers a browser preflight to the generate path with the credentialed profile', async () => {
        const res = await app.request('/v1/items/abc/brief/generate', {
            method: 'OPTIONS',
            headers: { Origin: 'http://localhost:4173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4173');
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('keeps the relaxed public profile on the sibling bearer-only item routes', async () => {
        for (const path of ['/v1/items/abc', '/v1/items/abc/brief', '/v1/items']) {
            const res = await app.request(path, { method: 'OPTIONS', headers: { Origin: 'http://localhost:4173', 'Access-Control-Request-Method': 'POST' } });
            expect(res.headers.get('access-control-allow-origin')).toBe('*');
            expect(res.headers.get('access-control-allow-credentials')).toBeNull();
        }
    });

    it('echoes the origin with credentials on the actual cookie-authed POST (publicCors never overrides it)', async () => {
        const session = await login();
        const itemId = await seedItem(session.userId, { notes: 'short' });
        const res = await generate(itemId, session, {}, 'http://localhost:4173');
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4173');
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });
});
