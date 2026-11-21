import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import claudeAsksDAO from '../dataAccess/claudeAsksDAO.js';
import { recordClaudeAsk } from '../lib/claudeAsks.js';
import { reassignEntity } from '../lib/reassignEntity.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { syncRoutes } from '../routes/sync.js';
import { v1ClaudeAsksRoutes } from '../routes/v1/claudeAsks.js';
import type { ApiTokenScope, ClaudeAskInterface, OperationInterface } from '../types/entities.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/sync', syncRoutes)
    .route('/v1', v1ClaudeAsksRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test_claude_ask_sync');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all(
        ['user', 'session', 'account', 'verification', 'items', 'operations', 'claudeAsks', 'deviceSyncState', 'entityMoves', 'apiTokens'].map((name) =>
            db.collection(name).deleteMany({}),
        ),
    );
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

interface Actor {
    cookie: string;
    userId: string;
}

async function login(provider: 'google' | 'github' = 'google', overrides: Record<string, unknown> = {}): Promise<Actor> {
    const { sessionCookie } = await oauthLogin(app, provider, overrides);
    if (!sessionCookie) throw new Error('expected a session cookie');
    const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await res.json()) as { user: { id: string } };
    return { cookie: sessionCookie, userId: user.id };
}

const loginBob = () => login('github', { email: 'bob@example.com', login: 'bob-gh' });

function clientOp(entityType: string, entityId: string, opType: string, snapshot: Record<string, unknown> | null) {
    return { entityType, entityId, opType, queuedAt: dayjs().toISOString(), snapshot };
}

function push(actor: Actor, ops: ReturnType<typeof clientOp>[]) {
    return authenticatedRequest(app, { method: 'POST', path: '/sync/push', sessionCookie: actor.cookie, body: { deviceId: 'device-a', ops } });
}

async function seedItemWithAsk(actor: Actor, itemId = 'item-1'): Promise<ClaudeAskInterface> {
    const now = dayjs().toISOString();
    const res = await push(actor, [
        clientOp('item', itemId, 'create', { _id: itemId, status: 'inbox', title: 'Renew passport', createdTs: now, updatedTs: now }),
    ]);
    expect(res.status).toBe(200);
    return recordClaudeAsk({
        askId: `ask-${itemId}`,
        userId: actor.userId,
        itemId,
        prompt: 'Go',
        sessionId: 's1',
        sessionUrl: 'https://claude.ai/code/s1',
        now,
    });
}

async function askOps(userId: string) {
    return db.collection<OperationInterface>('operations').find({ entityType: 'claudeAsk', user: userId }).sort({ ts: 1 }).toArray();
}

async function bearer(userId: string, scopes: ApiTokenScope[] = ['items.read', 'items.write']) {
    const { plaintext } = await issueApiToken(userId, 'claude', scopes);
    return plaintext;
}

function reportResult(token: string, askId: string, body: unknown) {
    return app.fetch(
        new Request(`http://localhost:4000/v1/claude-asks/${askId}/result`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

describe('claudeAsk is server-written only', () => {
    it('drops a device-pushed claudeAsk op instead of failing the batch, and still applies the rest', async () => {
        const alice = await login();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const now = dayjs().toISOString();
        const forged = { _id: 'forged', itemId: 'item-1', prompt: 'x', sessionId: 's', sessionUrl: 'https://claude.ai/code/s', createdTs: now, updatedTs: now };
        const res = await push(alice, [
            clientOp('claudeAsk', 'forged', 'create', forged),
            clientOp('item', 'item-1', 'create', { _id: 'item-1', status: 'inbox', title: 'Kept', createdTs: now, updatedTs: now }),
        ]);
        expect(res.status).toBe(200);
        expect(await db.collection('claudeAsks').countDocuments({})).toBe(0);
        expect(await db.collection('items').countDocuments({ _id: 'item-1' } as never)).toBe(1);
    });
});

describe('claudeAsk push of server-written ops only', () => {
    it('answers 200 and records no op when a batch holds nothing but claudeAsk ops', async () => {
        const alice = await login();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const now = dayjs().toISOString();
        const res = await push(alice, [
            clientOp('claudeAsk', 'forged', 'create', {
                _id: 'forged',
                itemId: 'i',
                prompt: 'x',
                sessionId: 's',
                sessionUrl: 'https://claude.ai/code/s',
                createdTs: now,
                updatedTs: now,
            }),
        ]);
        expect(res.status).toBe(200);
        expect(await db.collection('operations').countDocuments({})).toBe(0);
    });
});

describe('claudeAsk lifecycle follows its item', () => {
    it('hard-deleting the item removes its asks and records a delete op per ask', async () => {
        const alice = await login();
        const ask = await seedItemWithAsk(alice);
        await push(alice, [clientOp('item', 'item-1', 'delete', null)]);
        expect(await db.collection('claudeAsks').countDocuments({})).toBe(0);
        expect((await askOps(alice.userId)).map((op) => [op.opType, op.entityId])).toEqual([
            ['create', ask._id],
            ['delete', ask._id],
        ]);
    });

    it('trashing the item keeps its asks', async () => {
        const alice = await login();
        await seedItemWithAsk(alice);
        const now = dayjs().add(1, 'second').toISOString();
        await push(alice, [clientOp('item', 'item-1', 'update', { _id: 'item-1', status: 'trash', title: 'Renew passport', createdTs: now, updatedTs: now })]);
        expect(await db.collection('claudeAsks').countDocuments({})).toBe(1);
    });

    it('reassigning the item to another account drops the source asks (and heals on retry)', async () => {
        const alice = await login();
        const bob = await loginBob();
        await seedItemWithAsk(alice);
        const params = { entityType: 'item' as const, entityId: 'item-1', fromUserId: alice.userId, toUserId: bob.userId };
        expect(await reassignEntity(params)).toEqual({ ok: true });
        expect(await db.collection('claudeAsks').countDocuments({})).toBe(0);

        // Crash window: the flip landed but the cascade did not — the already-moved retry heals it.
        const now = dayjs().toISOString();
        await recordClaudeAsk({
            askId: 'stranded',
            userId: alice.userId,
            itemId: 'item-1',
            prompt: 'Go',
            sessionId: 's',
            sessionUrl: 'https://claude.ai/code/s',
            now,
        });
        expect(await reassignEntity(params)).toEqual({ ok: true, alreadyMoved: true });
        expect(await db.collection('claudeAsks').countDocuments({})).toBe(0);
    });

    it('refuses to reassign an ask on its own', async () => {
        const alice = await login();
        const bob = await loginBob();
        const ask = await seedItemWithAsk(alice);
        expect(await reassignEntity({ entityType: 'claudeAsk', entityId: ask._id ?? '', fromUserId: alice.userId, toUserId: bob.userId })).toMatchObject({
            ok: false,
            status: 400,
        });
    });
});

describe('PUT /v1/claude-asks/:id/result', () => {
    it('writes the summary onto the ask and records an update op', async () => {
        const alice = await login();
        const ask = await seedItemWithAsk(alice);
        const res = await reportResult(await bearer(alice.userId), ask._id ?? '', { summary: 'Renamed the item' });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ _id: ask._id, result: { summary: 'Renamed the item', outcome: 'completed' } });
        const stored = await db.collection<ClaudeAskInterface>('claudeAsks').findOne({ _id: ask._id } as never);
        expect(stored?.result).toMatchObject({ summary: 'Renamed the item', outcome: 'completed' });
        expect((await askOps(alice.userId)).map((op) => op.opType)).toEqual(['create', 'update']);
    });

    it('replaces an earlier report (needsInput, then completed)', async () => {
        const alice = await login();
        const ask = await seedItemWithAsk(alice);
        const token = await bearer(alice.userId);
        await reportResult(token, ask._id ?? '', { summary: 'Which ticket?', outcome: 'needsInput' });
        await reportResult(token, ask._id ?? '', { summary: 'Done after all' });
        const stored = await db.collection<ClaudeAskInterface>('claudeAsks').findOne({ _id: ask._id } as never);
        expect(stored?.result).toMatchObject({ summary: 'Done after all', outcome: 'completed' });
    });

    it('returns 404 when the ask is deleted between the read and the write', async () => {
        const alice = await login();
        const ask = await seedItemWithAsk(alice);
        const realFind = claudeAsksDAO.findByOwnerAndId.bind(claudeAsksDAO);
        vi.spyOn(claudeAsksDAO, 'findByOwnerAndId').mockImplementation(async (id, userId) => {
            const found = await realFind(id, userId);
            await db.collection('claudeAsks').deleteOne({ _id: id } as never);
            return found;
        });
        const res = await reportResult(await bearer(alice.userId), ask._id ?? '', { summary: 'Too late' });
        expect(res.status).toBe(404);
    });

    it("returns 404 for another user's ask", async () => {
        const alice = await login();
        const bob = await loginBob();
        const ask = await seedItemWithAsk(alice);
        const res = await reportResult(await bearer(bob.userId), ask._id ?? '', { summary: 'Hijack' });
        expect(res.status).toBe(404);
    });

    it('rejects an invalid body and a token without items.write', async () => {
        const alice = await login();
        const ask = await seedItemWithAsk(alice);
        expect((await reportResult(await bearer(alice.userId), ask._id ?? '', { summary: '' })).status).toBe(400);
        expect((await reportResult(await bearer(alice.userId, ['items.read']), ask._id ?? '', { summary: 'ok' })).status).toBe(403);
    });
});
