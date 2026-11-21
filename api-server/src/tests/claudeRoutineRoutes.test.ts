import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { CLAUDE_ASK_IN_FLIGHT_SECONDS } from '../lib/claudeAsks.js';
import { decrypt } from '../lib/tokenEncryption.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { claudeRoutineRoutes } from '../routes/claudeRoutine.js';
import { syncRoutes } from '../routes/sync.js';
import {
    type ClaudeAskInterface,
    type ClaudeRoutineConnectionInterface,
    type DeviceSyncStateInterface,
    deviceSyncStateId,
    type ItemInterface,
    type OperationInterface,
} from '../types/entities.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/sync', syncRoutes)
    .route('/account/claude-routine', claudeRoutineRoutes);

const ROUTINE_ID = 'trig_01TestRoutine';
const TOKEN = 'sk-ant-oat01-test-token-abcd1234';
const FIRE_URL = `https://api.anthropic.com/v1/claude_code/routines/${ROUTINE_ID}/fire`;
const SESSION_URL = 'https://claude.ai/code/session_01abc';

beforeAll(async () => {
    await loadDataAccess('gtd_test_claude_routine_routes');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all(
        ['user', 'session', 'account', 'verification', 'items', 'operations', 'claudeAsks', 'claudeRoutineConnections', 'deviceSyncState'].map((name) =>
            db.collection(name).deleteMany({}),
        ),
    );
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

interface Session {
    cookie: string;
    userId: string;
}

async function login(provider: 'google' | 'github' = 'google', overrides: Record<string, unknown> = {}): Promise<Session> {
    const { sessionCookie } = await oauthLogin(app, provider, overrides);
    if (!sessionCookie) throw new Error('expected a session cookie');
    const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await res.json()) as { user: { id: string } };
    return { cookie: sessionCookie, userId: user.id };
}

async function seedItem(userId: string, overrides: Partial<ItemInterface> = {}): Promise<ItemInterface & { _id: string }> {
    const now = dayjs().toISOString();
    const item = {
        _id: `item-${Math.random().toString(36).slice(2)}`,
        user: userId,
        status: 'inbox' as const,
        title: 'Renew passport',
        notes: 'Photos in the drawer',
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
    await itemsDAO.insertOne(item);
    return item;
}

function request(session: Session, method: 'GET' | 'PUT' | 'DELETE' | 'POST', path: string, body?: unknown) {
    return authenticatedRequest(app, { method, path: `/account/claude-routine${path}`, sessionCookie: session.cookie, body });
}

function connect(session: Session) {
    return request(session, 'PUT', '', { claudeRoutineId: ROUTINE_ID, token: TOKEN });
}

interface FireCall {
    url: string;
    init: RequestInit | undefined;
}

/** Answers the Claude routine start endpoint with `respond` and fails the test on any other URL. */
function stubClaudeRoutineFire(respond: () => Response | Promise<Response>): FireCall[] {
    const calls: FireCall[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = input.toString();
        if (url !== FIRE_URL) throw new Error(`Unexpected fetch to ${url}`);
        calls.push({ url, init });
        return respond();
    });
    return calls;
}

const startedSession = () => Response.json({ type: 'routine_fire', claude_code_session_id: 'session_01abc', claude_code_session_url: SESSION_URL });

async function registerDevice(deviceId: string, userId: string) {
    await db.collection<DeviceSyncStateInterface>('deviceSyncState').insertOne({
        _id: deviceSyncStateId(deviceId, userId),
        deviceId,
        user: userId,
        lastSyncedTs: dayjs(0).toISOString(),
        lastSyncedId: '',
        lastSeenTs: dayjs().toISOString(),
    });
}

async function storedConnection(userId: string) {
    return db.collection<ClaudeRoutineConnectionInterface>('claudeRoutineConnections').findOne({ user: userId });
}

async function storedAsks(userId: string) {
    return db.collection<ClaudeAskInterface>('claudeAsks').find({ user: userId }).toArray();
}

describe('Claude routine connection', () => {
    it('reports not connected before anything is saved', async () => {
        const alice = await login();
        const res = await request(alice, 'GET', '');
        expect(await res.json()).toEqual({ connected: false });
    });

    it('stores the token encrypted and only ever returns its last four characters', async () => {
        const alice = await login();
        const saved = await connect(alice);
        expect(saved.status).toBe(200);
        expect(await saved.json()).toMatchObject({ connected: true, claudeRoutineId: ROUTINE_ID, tokenHint: '1234' });

        const row = await storedConnection(alice.userId);
        expect(row?.tokenEncrypted).not.toContain(TOKEN);
        expect(decrypt(row?.tokenEncrypted ?? '')).toBe(TOKEN);

        const read = await (await request(alice, 'GET', '')).text();
        expect(read).not.toContain(TOKEN);
        expect(JSON.parse(read)).toMatchObject({ connected: true, tokenHint: '1234' });
    });

    it('replaces the previous Claude routine instead of adding a second one', async () => {
        const alice = await login();
        await connect(alice);
        await request(alice, 'PUT', '', { claudeRoutineId: 'trig_other', token: 'sk-ant-oat01-another-token-wxyz' });
        const rows = await db.collection('claudeRoutineConnections').find({ user: alice.userId }).toArray();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ claudeRoutineId: 'trig_other', tokenHint: 'wxyz' });
    });

    it('rejects a malformed submission with a stable code', async () => {
        const alice = await login();
        const res = await request(alice, 'PUT', '', { claudeRoutineId: 'not-a-trigger', token: TOKEN });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'invalid_claude_routine_id' });
    });

    it('disconnects idempotently', async () => {
        const alice = await login();
        await connect(alice);
        expect(await (await request(alice, 'DELETE', '')).json()).toEqual({ connected: false });
        expect(await storedConnection(alice.userId)).toBeNull();
        expect((await request(alice, 'DELETE', '')).status).toBe(200);
    });

    it('requires a session', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/account/claude-routine'));
        expect(res.status).toBe(401);
    });
});

describe('POST /account/claude-routine/asks', () => {
    it('starts the Claude routine with the item context and records the ask', async () => {
        const alice = await login();
        await connect(alice);
        const item = await seedItem(alice.userId);
        const calls = stubClaudeRoutineFire(startedSession);

        const res = await request(alice, 'POST', '/asks', { itemId: item._id, prompt: '  Book the appointment  ' });

        expect(res.status).toBe(201);
        const { ask } = (await res.json()) as { ask: ClaudeAskInterface };
        expect(ask).toMatchObject({ itemId: item._id, prompt: 'Book the appointment', sessionId: 'session_01abc', sessionUrl: SESSION_URL });
        expect(ask).not.toHaveProperty('result');

        expect(calls).toHaveLength(1);
        const [call] = calls;
        if (!call) throw new Error('expected one start call');
        const headers = new Headers(call.init?.headers);
        expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
        expect(headers.get('anthropic-version')).toBe('2023-06-01');
        const { text } = JSON.parse(String(call.init?.body)) as { text: string };
        expect(text).toContain(`Item id: ${item._id}`);
        expect(text).toContain('Book the appointment');
        expect(text).toContain('Photos in the drawer');
        expect(text).toContain(`askId "${ask._id}"`);

        expect(await storedAsks(alice.userId)).toEqual([expect.objectContaining({ _id: ask._id, sessionUrl: SESSION_URL })]);
        const op = await db.collection<OperationInterface>('operations').findOne({ entityType: 'claudeAsk', entityId: ask._id ?? '' });
        expect(op).toMatchObject({ opType: 'create', deviceId: 'server:claude-ask', user: alice.userId });
    });

    it('replicates the new ask to the user devices through /sync/pull and bootstrap', async () => {
        const alice = await login();
        await connect(alice);
        const item = await seedItem(alice.userId);
        stubClaudeRoutineFire(startedSession);
        const { ask } = (await (await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' })).json()) as { ask: ClaudeAskInterface };

        await registerDevice('device-b', alice.userId);
        const params = new URLSearchParams({ since: dayjs(0).toISOString(), deviceId: 'device-b' });
        const pull = await authenticatedRequest(app, { method: 'GET', path: `/sync/pull?${params}`, sessionCookie: alice.cookie });
        const { ops } = (await pull.json()) as { ops: OperationInterface[] };
        expect(ops.filter((op) => op.entityType === 'claudeAsk').map((op) => op.entityId)).toEqual([ask._id]);

        const bootstrap = await authenticatedRequest(app, { method: 'GET', path: '/sync/bootstrap?deviceId=device-c', sessionCookie: alice.cookie });
        const body = (await bootstrap.json()) as { claudeAsks: ClaudeAskInterface[] };
        expect(body.claudeAsks.map((row) => row._id)).toEqual([ask._id]);
    });

    it('refuses with claude_routine_not_connected before any Claude routine is saved', async () => {
        const alice = await login();
        const item = await seedItem(alice.userId);
        const calls = stubClaudeRoutineFire(startedSession);
        const res = await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'claude_routine_not_connected' });
        expect(calls).toHaveLength(0);
    });

    it("returns 404 for another user's item and for a trashed item", async () => {
        const alice = await login();
        const bob = await login('github', { email: 'bob@example.com', login: 'bob-gh' });
        await connect(alice);
        const bobsItem = await seedItem(bob.userId);
        const trashed = await seedItem(alice.userId, { status: 'trash' });
        stubClaudeRoutineFire(startedSession);
        expect((await request(alice, 'POST', '/asks', { itemId: bobsItem._id, prompt: 'Go' })).status).toBe(404);
        expect((await request(alice, 'POST', '/asks', { itemId: trashed._id, prompt: 'Go' })).status).toBe(404);
    });

    it('rejects an empty prompt', async () => {
        const alice = await login();
        await connect(alice);
        const item = await seedItem(alice.userId);
        const res = await request(alice, 'POST', '/asks', { itemId: item._id, prompt: '   ' });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'invalid_prompt' });
    });

    it('refuses a second start on the same item inside the in-flight window, then allows it after', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const alice = await login();
            await connect(alice);
            const item = await seedItem(alice.userId);
            const calls = stubClaudeRoutineFire(startedSession);

            expect((await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' })).status).toBe(201);
            const second = await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go again' });
            expect(second.status).toBe(409);
            expect(await second.json()).toMatchObject({ code: 'claude_ask_in_flight' });
            expect(calls).toHaveLength(1);

            vi.setSystemTime(
                dayjs()
                    .add(CLAUDE_ASK_IN_FLIGHT_SECONDS + 1, 'second')
                    .toDate(),
            );
            expect((await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go again' })).status).toBe(201);
        } finally {
            vi.useRealTimers();
        }
    });

    it('lets two concurrent clicks start only one session', async () => {
        const alice = await login();
        await connect(alice);
        const item = await seedItem(alice.userId);
        const calls = stubClaudeRoutineFire(startedSession);
        const statuses = await Promise.all([
            request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' }),
            request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' }),
        ]).then((responses) => responses.map((res) => res.status).sort());
        expect(statuses).toEqual([201, 409]);
        expect(calls).toHaveLength(1);
    });

    it.each([
        [401, 422, 'claude_routine_token_rejected'],
        [404, 422, 'claude_routine_not_found'],
        [400, 422, 'claude_routine_unavailable'],
        [500, 503, 'claude_routine_unreachable'],
    ])('maps an upstream %i to %i %s and records nothing', async (upstream, status, code) => {
        const alice = await login();
        await connect(alice);
        const item = await seedItem(alice.userId);
        stubClaudeRoutineFire(() => Response.json({ error: { message: 'nope' } }, { status: upstream }));
        const res = await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' });
        expect(res.status).toBe(status);
        expect(await res.json()).toMatchObject({ code });
        expect(await storedAsks(alice.userId)).toEqual([]);
    });

    it('passes a 429 through with Retry-After', async () => {
        const alice = await login();
        await connect(alice);
        const item = await seedItem(alice.userId);
        stubClaudeRoutineFire(() => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }));
        const res = await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' });
        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('30');
        expect(await res.json()).toMatchObject({ code: 'claude_routine_rate_limited' });
    });

    it('maps a network failure or timeout to 503', async () => {
        const alice = await login();
        await connect(alice);
        const item = await seedItem(alice.userId);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        stubClaudeRoutineFire(() => {
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        });
        const res = await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' });
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ code: 'claude_routine_unreachable' });
    });

    it('keeps a timed-out start in flight so an immediate retry cannot open a second session', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const alice = await login();
            await connect(alice);
            const item = await seedItem(alice.userId);
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            const calls = stubClaudeRoutineFire(() => {
                throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
            });

            expect((await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' })).status).toBe(503);
            const retry = await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' });
            expect(retry.status).toBe(409);
            expect(await retry.json()).toMatchObject({ code: 'claude_ask_in_flight' });
            expect(Number(retry.headers.get('retry-after'))).toBeGreaterThan(0);
            expect(calls).toHaveLength(1);

            vi.setSystemTime(
                dayjs()
                    .add(CLAUDE_ASK_IN_FLIGHT_SECONDS + 1, 'second')
                    .toDate(),
            );
            await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' });
            expect(calls).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('lets a retry through right away after a definite refusal (nothing was started)', async () => {
        const alice = await login();
        await connect(alice);
        const item = await seedItem(alice.userId);
        const calls = stubClaudeRoutineFire(() => Response.json({}, { status: 401 }));
        expect((await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' })).status).toBe(422);
        expect((await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' })).status).toBe(422);
        expect(calls).toHaveLength(2);
    });

    it('records nothing when the item is deleted while the Claude routine starts', async () => {
        const alice = await login();
        await connect(alice);
        const item = await seedItem(alice.userId);
        stubClaudeRoutineFire(async () => {
            await itemsDAO.deleteByOwner(item._id, alice.userId);
            return startedSession();
        });
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        expect((await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' })).status).toBe(404);
        expect(await storedAsks(alice.userId)).toEqual([]);
    });

    it('treats a stored token that no longer decrypts as not connected', async () => {
        const alice = await login();
        await connect(alice);
        await db.collection('claudeRoutineConnections').updateOne({ user: alice.userId }, { $set: { tokenEncrypted: 'garbage' } });
        const item = await seedItem(alice.userId);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const res = await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'claude_routine_not_connected' });
    });

    it('returns a predictable fake session under CLAUDE_ROUTINE_FAKE=1 without calling Anthropic', async () => {
        vi.stubEnv('CLAUDE_ROUTINE_FAKE', '1');
        const alice = await login();
        await connect(alice);
        const item = await seedItem(alice.userId);
        const calls = stubClaudeRoutineFire(startedSession);
        const { ask } = (await (await request(alice, 'POST', '/asks', { itemId: item._id, prompt: 'Go' })).json()) as { ask: ClaudeAskInterface };
        expect(ask.sessionUrl).toBe(`https://claude.ai/code/session_fake_${ask._id}`);
        expect(calls).toHaveLength(0);
    });
});
