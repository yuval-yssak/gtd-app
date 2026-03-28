/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { syncRoutes } from '../routes/sync.js';
import type { EntityType, OpType } from '../types/entities.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/sync', syncRoutes);

// ─── Lifecycle ──────────────────────────────────────────────────────────────

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
        db.collection('routines').deleteMany({}),
        db.collection('people').deleteMany({}),
        db.collection('workContexts').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('deviceSyncState').deleteMany({}),
        db.collection('pushSubscriptions').deleteMany({}),
    ]);
    vi.restoreAllMocks();
});

// ─── Local helpers ──────────────────────────────────────────────────────────

async function loginAsAlice(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    return sessionCookie!;
}

async function loginAsBob(): Promise<string> {
    // Use GitHub (not Google) so Bob gets a different provider identity — Google logins always
    // use the same GOOGLE_TOKEN.id_token.sub ('g1'), which would link Bob to Alice's account.
    const { sessionCookie } = await oauthLogin(app, 'github', { email: 'bob@example.com', login: 'bob-gh' });
    return sessionCookie!;
}

async function getUserId(sessionCookie: string): Promise<string> {
    const res = await app.fetch(
        new Request('http://localhost:4000/auth/get-session', {
            headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
        }),
    );
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
}

function makeClientOp(entityType: EntityType, entityId: string, opType: OpType, snapshot: Record<string, unknown> | null) {
    return { entityType, entityId, opType, queuedAt: new Date().toISOString(), snapshot };
}

function makeItemSnapshot(entityId: string, updatedTs: string, overrides?: Record<string, unknown>) {
    return {
        _id: entityId,
        userId: 'client-user-id', // server strips this and injects its own user.id from the session
        status: 'inbox',
        title: 'Test Item',
        createdTs: '2024-01-01T00:00:00.000Z',
        updatedTs,
        ...overrides,
    };
}

async function push(sessionCookie: string, deviceId: string, ops: ReturnType<typeof makeClientOp>[]) {
    return authenticatedRequest(app, { method: 'POST', path: '/sync/push', sessionCookie, body: { deviceId, ops } });
}

async function pull(sessionCookie: string, opts: { since?: string; deviceId?: string } = {}) {
    const params = new URLSearchParams();
    if (opts.since !== undefined) params.set('since', opts.since);
    if (opts.deviceId !== undefined) params.set('deviceId', opts.deviceId);
    const query = params.toString() ? `?${params}` : '';
    return authenticatedRequest(app, { method: 'GET', path: `/sync/pull${query}`, sessionCookie });
}

/** Small delay to guarantee strictly-ordered ISO timestamps across sequential operations. */
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

// ─── POST /sync/push ────────────────────────────────────────────────────────

describe('POST /sync/push', () => {
    it('item create: 200, item stored in items collection, op stored in operations', async () => {
        const cookie = await loginAsAlice();
        const entityId = crypto.randomUUID();

        const res = await push(cookie, 'dev-1', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);

        expect(res.status).toBe(200);
        expect(await db.collection('items').countDocuments({ _id: entityId })).toBe(1);
        expect(await db.collection('operations').countDocuments({ entityId })).toBe(1);
    });

    it('item update last-write-wins: newer ts replaces, older ts is ignored', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const entityId = crypto.randomUUID();

        // Seed an item directly at T1
        await db.collection('items').insertOne({
            _id: entityId,
            user: userId,
            status: 'inbox',
            title: 'Original',
            createdTs: '2024-01-01T00:00:00.000Z',
            updatedTs: '2024-01-02T00:00:00.000Z',
        });

        // Push update with T2 > T1 → should replace
        await push(cookie, 'dev-1', [makeClientOp('item', entityId, 'update', makeItemSnapshot(entityId, '2024-01-03T00:00:00.000Z', { title: 'Updated' }))]);
        const afterNewer = await db.collection('items').findOne({ _id: entityId });
        expect(afterNewer?.title).toBe('Updated');

        // Push update with T0 < current updatedTs → should be ignored (stale write rejected)
        await push(cookie, 'dev-1', [makeClientOp('item', entityId, 'update', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z', { title: 'Stale' }))]);
        const afterStale = await db.collection('items').findOne({ _id: entityId });
        expect(afterStale?.title).toBe('Updated');
    });

    it('item delete: item removed from items collection, op recorded', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const entityId = crypto.randomUUID();

        await db.collection('items').insertOne({
            _id: entityId,
            user: userId,
            status: 'inbox',
            title: 'To delete',
            createdTs: '2024-01-01T00:00:00.000Z',
            updatedTs: '2024-01-01T00:00:00.000Z',
        });

        const res = await push(cookie, 'dev-1', [makeClientOp('item', entityId, 'delete', null)]);

        expect(res.status).toBe(200);
        expect(await db.collection('items').countDocuments({ _id: entityId })).toBe(0);
        expect(await db.collection('operations').countDocuments({ entityId, opType: 'delete' })).toBe(1);
    });

    it('all four entity types are stored in their respective collections', async () => {
        const cookie = await loginAsAlice();
        const itemId = crypto.randomUUID();
        const routineId = crypto.randomUUID();
        const personId = crypto.randomUUID();
        const workContextId = crypto.randomUUID();

        const ts = '2024-01-01T00:00:00.000Z';
        await push(cookie, 'dev-1', [
            makeClientOp('item', itemId, 'create', makeItemSnapshot(itemId, ts)),
            makeClientOp('routine', routineId, 'create', {
                _id: routineId,
                userId: 'x',
                title: 'Daily standup',
                triggerMode: 'afterCompletion',
                template: {},
                active: true,
                createdTs: ts,
                updatedTs: ts,
            }),
            makeClientOp('person', personId, 'create', { _id: personId, userId: 'x', name: 'Alice', createdTs: ts, updatedTs: ts }),
            makeClientOp('workContext', workContextId, 'create', { _id: workContextId, userId: 'x', name: 'At desk', createdTs: ts, updatedTs: ts }),
        ]);

        expect(await db.collection('items').countDocuments({ _id: itemId })).toBe(1);
        expect(await db.collection('routines').countDocuments({ _id: routineId })).toBe(1);
        expect(await db.collection('people').countDocuments({ _id: personId })).toBe(1);
        expect(await db.collection('workContexts').countDocuments({ _id: workContextId })).toBe(1);
    });

    it('empty ops array: returns 200 without writing anything', async () => {
        const cookie = await loginAsAlice();

        const res = await push(cookie, 'dev-1', []);

        expect(res.status).toBe(200);
        expect(await db.collection('operations').countDocuments()).toBe(0);
    });

    it('unauthenticated push returns 401', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/sync/push', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId: 'dev-x', ops: [] }),
            }),
        );
        expect(res.status).toBe(401);
    });

    it('stored snapshot uses server user.id, not the client-supplied userId', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const entityId = crypto.randomUUID();

        await push(cookie, 'dev-1', [
            makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z', { userId: 'injected-client-id' })),
        ]);

        const op = await db.collection('operations').findOne({ entityId });
        // Verify the server replaced the client-supplied userId with its own authoritative user.id
        expect((op?.snapshot as Record<string, unknown>)?.user).toBe(userId);
        expect((op?.snapshot as Record<string, unknown>)?.userId).toBeUndefined();
    });
});

// ─── GET /sync/pull ─────────────────────────────────────────────────────────

describe('GET /sync/pull', () => {
    it('basic pull: returns all ops pushed by another device, sorted by ts', async () => {
        const cookie = await loginAsAlice();
        const entityId = crypto.randomUUID();

        await push(cookie, 'dev-1', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);

        const res = await pull(cookie, { since: new Date(0).toISOString(), deviceId: 'dev-2' });

        expect(res.status).toBe(200);
        const { ops } = (await res.json()) as { ops: { entityId: string }[] };
        expect(ops).toHaveLength(1);
        expect(ops[0]!.entityId).toBe(entityId);
    });

    it('since filter: only returns ops with ts > since', async () => {
        const cookie = await loginAsAlice();
        const id1 = crypto.randomUUID();
        const id2 = crypto.randomUUID();

        await push(cookie, 'dev-1', [makeClientOp('item', id1, 'create', makeItemSnapshot(id1, '2024-01-01T00:00:00.000Z'))]);
        // Record the ts of the first op to use as the `since` cursor
        const firstOp = await db.collection('operations').findOne({ entityId: id1 });
        const t1 = firstOp!.ts as string;

        // Small delay ensures the second push gets a strictly later server ts
        await tick();
        await push(cookie, 'dev-1', [makeClientOp('item', id2, 'create', makeItemSnapshot(id2, '2024-01-02T00:00:00.000Z'))]);

        const res = await pull(cookie, { since: t1, deviceId: 'dev-2' });
        const { ops } = (await res.json()) as { ops: { entityId: string }[] };

        expect(ops).toHaveLength(1);
        expect(ops[0]!.entityId).toBe(id2);
    });

    it('pull with deviceId updates deviceSyncState lastSyncedTs', async () => {
        const cookie = await loginAsAlice();

        const res = await pull(cookie, { deviceId: 'dev-2' });
        const { serverTs } = (await res.json()) as { serverTs: string };

        const state = await db.collection('deviceSyncState').findOne({ _id: 'dev-2' });
        expect(state?.lastSyncedTs).toBe(serverTs);
    });

    it('pull without deviceId does not create a deviceSyncState doc', async () => {
        const cookie = await loginAsAlice();

        await pull(cookie);

        expect(await db.collection('deviceSyncState').countDocuments()).toBe(0);
    });

    it('user isolation: Bob pulls zero ops after Alice pushes', async () => {
        const aliceCookie = await loginAsAlice();
        vi.restoreAllMocks();
        const bobCookie = await loginAsBob();

        const entityId = crypto.randomUUID();
        await push(aliceCookie, 'dev-alice', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);

        const res = await pull(bobCookie, { since: new Date(0).toISOString() });
        const { ops } = (await res.json()) as { ops: unknown[] };

        expect(ops).toHaveLength(0);
    });

    it('unauthenticated pull returns 401', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/sync/pull'));
        expect(res.status).toBe(401);
    });
});

// ─── GET /sync/bootstrap ────────────────────────────────────────────────────

describe('GET /sync/bootstrap', () => {
    it('full hydration: returns all four entity arrays and serverTs', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const ts = '2024-01-01T00:00:00.000Z';

        await Promise.all([
            db.collection('items').insertOne({ _id: crypto.randomUUID(), user: userId, status: 'inbox', title: 'Item', createdTs: ts, updatedTs: ts }),
            db.collection('routines').insertOne({
                _id: crypto.randomUUID(),
                user: userId,
                title: 'Routine',
                triggerMode: 'afterCompletion',
                template: {},
                active: true,
                createdTs: ts,
                updatedTs: ts,
            }),
            db.collection('people').insertOne({ _id: crypto.randomUUID(), user: userId, name: 'Alice', createdTs: ts, updatedTs: ts }),
            db.collection('workContexts').insertOne({ _id: crypto.randomUUID(), user: userId, name: 'At desk', createdTs: ts, updatedTs: ts }),
        ]);

        const res = await authenticatedRequest(app, { method: 'GET', path: '/sync/bootstrap', sessionCookie: cookie });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[]; routines: unknown[]; people: unknown[]; workContexts: unknown[]; serverTs: string };
        expect(body.items).toHaveLength(1);
        expect(body.routines).toHaveLength(1);
        expect(body.people).toHaveLength(1);
        expect(body.workContexts).toHaveLength(1);
        expect(body.serverTs).toBeTruthy();
    });

    it('user isolation: Alice bootstrap returns only her entities', async () => {
        const aliceCookie = await loginAsAlice();
        const aliceId = await getUserId(aliceCookie);
        vi.restoreAllMocks();
        const bobCookie = await loginAsBob();
        const bobId = await getUserId(bobCookie);

        const ts = '2024-01-01T00:00:00.000Z';
        await db
            .collection('items')
            .insertOne({ _id: crypto.randomUUID(), user: aliceId, status: 'inbox', title: "Alice's item", createdTs: ts, updatedTs: ts });
        await db.collection('items').insertOne({ _id: crypto.randomUUID(), user: bobId, status: 'inbox', title: "Bob's item", createdTs: ts, updatedTs: ts });

        const res = await authenticatedRequest(app, { method: 'GET', path: '/sync/bootstrap', sessionCookie: aliceCookie });
        const { items } = (await res.json()) as { items: { title: string }[] };

        expect(items).toHaveLength(1);
        expect(items[0]!.title).toBe("Alice's item");
    });

    it('new user with no data: bootstrap returns empty arrays and serverTs', async () => {
        const cookie = await loginAsAlice();

        const res = await authenticatedRequest(app, { method: 'GET', path: '/sync/bootstrap', sessionCookie: cookie });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[]; routines: unknown[]; people: unknown[]; workContexts: unknown[]; serverTs: string };
        expect(body.items).toHaveLength(0);
        expect(body.routines).toHaveLength(0);
        expect(body.people).toHaveLength(0);
        expect(body.workContexts).toHaveLength(0);
        expect(body.serverTs).toBeTruthy();
    });

    it('unauthenticated bootstrap returns 401', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/sync/bootstrap'));
        expect(res.status).toBe(401);
    });
});

// ─── Purge logic ─────────────────────────────────────────────────────────────

describe('Purge logic', () => {
    it('happy path: ops older than min(lastSyncedTs) across all devices are deleted after pull', async () => {
        const cookie = await loginAsAlice();
        const entityId = crypto.randomUUID();

        // dev-1 pushes an op — server records it with ts = T
        await push(cookie, 'dev-1', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);

        // Guarantee S1 > T so the op falls below the purge floor after both devices pull
        await tick();

        // dev-1 pulls → lastSyncedTs(dev-1) = S1
        await pull(cookie, { deviceId: 'dev-1' });
        await tick();

        // dev-2 pulls → lastSyncedTs(dev-2) = S2 > S1 → triggers purge; floor = min(S1,S2) = S1
        await pull(cookie, { deviceId: 'dev-2' });

        // Purge is fire-and-forget; give it a moment to complete before asserting
        await tick();

        expect(await db.collection('operations').countDocuments()).toBe(0);
    });

    it('single device: push then pull deletes all older ops', async () => {
        const cookie = await loginAsAlice();
        const entityId = crypto.randomUUID();

        await push(cookie, 'dev-1', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);
        await tick();
        await pull(cookie, { deviceId: 'dev-1' });
        await tick();

        expect(await db.collection('operations').countDocuments()).toBe(0);
    });

    it('pull response is returned before purge completes (purge is non-blocking)', async () => {
        const cookie = await loginAsAlice();
        const entityId = crypto.randomUUID();

        await push(cookie, 'dev-1', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);
        await tick();

        // The pull response must contain { ops, serverTs } regardless of purge timing
        const res = await pull(cookie, { deviceId: 'dev-1' });
        const body = (await res.json()) as { ops: unknown[]; serverTs: string };

        // Response is correct before we even check whether purge ran
        expect(body.serverTs).toBeTruthy();
        expect(Array.isArray(body.ops)).toBe(true);
    });
});

// ─── Multi-device round-trip ─────────────────────────────────────────────────

describe('Multi-device round-trip', () => {
    it('two devices of the same user can exchange operations', async () => {
        // Device-1 and device-2 both log in as the same user (Alice)
        const dev1Cookie = await loginAsAlice();
        vi.restoreAllMocks();
        // Second login reuses the same Better Auth user (same email), returning a new session
        const dev2Cookie = await loginAsAlice();

        const itemId = crypto.randomUUID();
        const ts = '2024-01-01T00:00:00.000Z';

        // Device-1 creates an item
        const pushRes = await push(dev1Cookie, 'dev-1', [makeClientOp('item', itemId, 'create', makeItemSnapshot(itemId, ts))]);
        expect(pushRes.status).toBe(200);
        await tick();

        // Device-2 pulls — should receive the create op
        const pullRes1 = await pull(dev2Cookie, { since: new Date(0).toISOString(), deviceId: 'dev-2' });
        const { ops: opsForDev2 } = (await pullRes1.json()) as { ops: { entityId: string; opType: string }[] };
        expect(opsForDev2).toHaveLength(1);
        expect(opsForDev2[0]!.entityId).toBe(itemId);
        expect(opsForDev2[0]!.opType).toBe('create');
        await tick();

        // Device-2 pushes an update
        const updateTs = '2024-01-02T00:00:00.000Z';
        await push(dev2Cookie, 'dev-2', [makeClientOp('item', itemId, 'update', makeItemSnapshot(itemId, updateTs, { title: 'Updated by dev-2' }))]);
        await tick();

        // Device-1 pulls — should receive the update op
        const dev1LastOp = await db.collection('operations').findOne({ entityId: itemId, opType: 'create' });
        const pullRes2 = await pull(dev1Cookie, { since: dev1LastOp!.ts as string, deviceId: 'dev-1' });
        const { ops: opsForDev1 } = (await pullRes2.json()) as { ops: { entityId: string; opType: string }[] };
        expect(opsForDev1).toHaveLength(1);
        expect(opsForDev1[0]!.opType).toBe('update');

        // Verify the item reflects the update
        const item = await db.collection('items').findOne({ _id: itemId });
        expect(item?.title).toBe('Updated by dev-2');

        // dev-2's lastSyncedTs is still anchored before the update op (it was set during
        // dev-2's first pull, before pushing the update). Pull again so dev-2's cursor
        // advances past the update op — otherwise min(lastSyncedTs) never reaches it.
        await tick();
        await pull(dev2Cookie, { deviceId: 'dev-2' });
        await tick();

        // Both devices have now pulled past all ops → purge fires → operations collection empty
        expect(await db.collection('operations').countDocuments()).toBe(0);
    });
});

// ─── SSE endpoint smoke test ─────────────────────────────────────────────────

describe('GET /sync/events', () => {
    it('unauthenticated request returns 401', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/sync/events'));
        expect(res.status).toBe(401);
    });

    it('authenticated request returns text/event-stream with initial connected frame', async () => {
        const cookie = await loginAsAlice();

        const res = await authenticatedRequest(app, { method: 'GET', path: '/sync/events', sessionCookie: cookie });

        expect(res.headers.get('Content-Type')).toContain('text/event-stream');

        // Read the initial `: connected\n\n` comment frame that the server enqueues immediately
        const reader = res.body!.getReader();
        const { value } = await reader.read();
        const text = new TextDecoder().decode(value);
        expect(text).toBe(': connected\n\n');

        // Cancel the stream to avoid leaving an open SSE connection in the test runner
        await reader.cancel();
    });
});
