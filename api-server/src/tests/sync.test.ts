/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
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
        db.collection('deviceUsers').deleteMany({}),
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
    return { entityType, entityId, opType, queuedAt: dayjs().toISOString(), snapshot };
}

// Snapshots in tests omit the `userId` field — the server strips it from inbound ops anyway, and
// the /sync/push mismatch guard rejects ops whose snapshot.userId disagrees with the session.
// Real clients always set `userId === session.user.id` (validated separately in sync.push.mismatch).
function makeItemSnapshot(entityId: string, updatedTs: string, overrides?: Record<string, unknown>) {
    return {
        _id: entityId,
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

/**
 * Polls a predicate against MongoDB until it returns true or the timeout elapses, then runs
 * one final attempt so the eventual `expect(...)` reports a meaningful diff instead of "false".
 * Use this for assertions that depend on the fire-and-forget purge in /sync/pull — a fixed
 * `tick()` after pull is racy under CPU load (purge is multiple awaits), but polling lets the
 * test pass as fast as the purge actually completes while staying flake-free under load.
 */
async function waitForPurge(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await new Promise<void>((r) => setTimeout(r, 10));
    }
}

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

    it('routine delete: succeeds when routine is already gone (concurrent delete from another device)', async () => {
        const cookie = await loginAsAlice();
        const routineId = crypto.randomUUID();
        // Routine intentionally NOT inserted: models the case where another device's delete arrived first.
        const res = await push(cookie, 'dev-1', [makeClientOp('routine', routineId, 'delete', null)]);
        expect(res.status).toBe(200);
        const op = await db.collection('operations').findOne({ entityId: routineId, opType: 'delete' });
        expect(op?.snapshot).toBeNull();
    });

    it('routine delete: pre-delete snapshot is captured on the recorded op', async () => {
        // The client sends `snapshot: null` for delete ops. The server hydrates the snapshot
        // from the current routine doc so the calendar push-back cascade can read calendarEventId.
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const routineId = crypto.randomUUID();

        await db.collection('routines').insertOne({
            _id: routineId,
            user: userId,
            title: 'Weekly standup',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            template: {},
            active: true,
            calendarEventId: 'gcal-evt-xyz',
            calendarIntegrationId: 'int-xyz',
            createdTs: '2024-01-01T00:00:00.000Z',
            updatedTs: '2024-01-01T00:00:00.000Z',
        });

        await push(cookie, 'dev-1', [makeClientOp('routine', routineId, 'delete', null)]);

        expect(await db.collection('routines').countDocuments({ _id: routineId })).toBe(0);
        const op = await db.collection('operations').findOne({ entityId: routineId, opType: 'delete' });
        expect(op?.snapshot).toMatchObject({ _id: routineId, calendarEventId: 'gcal-evt-xyz', calendarIntegrationId: 'int-xyz' });
    });

    it('all four entity types are stored in their respective collections', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const itemId = crypto.randomUUID();
        const routineId = crypto.randomUUID();
        const personId = crypto.randomUUID();
        const workContextId = crypto.randomUUID();

        const ts = '2024-01-01T00:00:00.000Z';
        await push(cookie, 'dev-1', [
            makeClientOp('item', itemId, 'create', makeItemSnapshot(itemId, ts)),
            makeClientOp('routine', routineId, 'create', {
                _id: routineId,
                userId,
                title: 'Daily standup',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
                createdTs: ts,
                updatedTs: ts,
            }),
            makeClientOp('person', personId, 'create', { _id: personId, userId, name: 'Alice', createdTs: ts, updatedTs: ts }),
            makeClientOp('workContext', workContextId, 'create', { _id: workContextId, userId, name: 'At desk', createdTs: ts, updatedTs: ts }),
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

        // Real clients tag the snapshot with their session userId; the server still strips and
        // re-injects from the session. We pass userId=session.user.id so the mismatch guard
        // (which rejects forged userIds) doesn't fire on the legitimate-but-tagged path.
        await push(cookie, 'dev-1', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z', { userId }))]);

        const op = await db.collection('operations').findOne({ entityId });
        // The snapshot stored on the op should expose `user`, not `userId` — the server's strip+remap.
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

        const res = await pull(cookie, { since: dayjs(0).toISOString(), deviceId: 'dev-2' });

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

    it('pull with deviceId updates deviceSyncState lastSyncedTs (composite per-user _id)', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);

        const res = await pull(cookie, { deviceId: 'dev-2' });
        const { serverTs } = (await res.json()) as { serverTs: string };

        const state = await db.collection('deviceSyncState').findOne({ _id: `dev-2::${userId}` });
        expect(state?.lastSyncedTs).toBe(serverTs);
        expect(state?.deviceId).toBe('dev-2');
        expect(state?.user).toBe(userId);
    });

    it('pull without deviceId does not create a deviceSyncState doc', async () => {
        const cookie = await loginAsAlice();

        await pull(cookie);

        expect(await db.collection('deviceSyncState').countDocuments()).toBe(0);
    });

    it('per-user cursor: explicit since=T does not exclude another user’s op also at ts=T (strict-$gt regression)', async () => {
        // Drives the failure mode at the API level: even when a client explicitly passes since=T
        // (which is what doPull does after a stale shared cursor), per-user cursors mean user B's
        // pull is independent of user A's cursor. The bug was that a second user's pull at the
        // same timestamp boundary returned 0 ops because the cursor was already advanced.
        // Here we simulate by inserting two ops with the same artificial ts directly into the
        // operations collection — bypassing dayjs() differences in the push handler.
        const aliceCookie = await loginAsAlice();
        const aliceId = await getUserId(aliceCookie);
        vi.restoreAllMocks();
        const bobCookie = await loginAsBob();
        const bobId = await getUserId(bobCookie);

        const sharedTs = '2025-04-30T19:38:54.754Z';
        const aliceItemId = crypto.randomUUID();
        const bobItemId = crypto.randomUUID();
        await db.collection('operations').insertMany([
            {
                _id: crypto.randomUUID(),
                user: aliceId,
                deviceId: 'shared-dev',
                ts: sharedTs,
                entityType: 'item',
                entityId: aliceItemId,
                opType: 'create',
                snapshot: { _id: aliceItemId, user: aliceId, status: 'inbox', title: 'A', createdTs: sharedTs, updatedTs: sharedTs },
            },
            {
                _id: crypto.randomUUID(),
                user: bobId,
                deviceId: 'shared-dev',
                ts: sharedTs,
                entityType: 'item',
                entityId: bobItemId,
                opType: 'create',
                snapshot: { _id: bobItemId, user: bobId, status: 'inbox', title: 'B', createdTs: sharedTs, updatedTs: sharedTs },
            },
        ]);

        // Alice pulls — gets her op, advances her own cursor to sharedTs.
        const aliceRes = await pull(aliceCookie, { deviceId: 'shared-dev' });
        const { ops: aliceOps } = (await aliceRes.json()) as { ops: { entityId: string }[] };
        expect(aliceOps.map((o) => o.entityId)).toEqual([aliceItemId]);

        // Bob pulls. Under the old shared-cursor model his pull would be { since: sharedTs },
        // strict-$gt would exclude his own op at sharedTs, and bobOps would be empty.
        // With per-user cursors his cursor is independent (still epoch), so he gets his op.
        const bobRes = await pull(bobCookie, { deviceId: 'shared-dev' });
        const { ops: bobOps } = (await bobRes.json()) as { ops: { entityId: string }[] };
        expect(bobOps.map((o) => o.entityId)).toEqual([bobItemId]);
    });

    it('per-user cursor: two users on the same device each track their own pull cursor (boundary-op regression)', async () => {
        // Repro of the cross-account-move bug: when two users share a device, a strict ts > since
        // filter combined with a single device-shared cursor lets one user's pull advance past
        // the other user's boundary op. Per-(device, user) cursors fix it.
        const aliceCookie = await loginAsAlice();
        const aliceId = await getUserId(aliceCookie);
        vi.restoreAllMocks();
        const bobCookie = await loginAsBob();
        const bobId = await getUserId(bobCookie);

        const aliceItemId = crypto.randomUUID();
        const bobItemId = crypto.randomUUID();

        // Alice and Bob both push from the same deviceId. We capture the operations' actual ts
        // values rather than asserting they share one — the test is meaningful even if they differ.
        await push(aliceCookie, 'shared-dev', [makeClientOp('item', aliceItemId, 'create', makeItemSnapshot(aliceItemId, '2024-01-01T00:00:00.000Z'))]);
        await push(bobCookie, 'shared-dev', [makeClientOp('item', bobItemId, 'create', makeItemSnapshot(bobItemId, '2024-01-01T00:00:00.000Z'))]);

        // Alice pulls first — under per-user cursors, this should not affect Bob's pull cursor.
        const aliceRes = await pull(aliceCookie, { deviceId: 'shared-dev' });
        const { ops: aliceOps } = (await aliceRes.json()) as { ops: { entityId: string }[] };
        expect(aliceOps.map((o) => o.entityId)).toEqual([aliceItemId]);

        // Bob pulls from the same device — under the old shared cursor, Bob's cursor would already
        // be at Alice's serverTs and Bob would miss his own boundary op. Under per-user cursors, Bob
        // still gets his create op.
        const bobRes = await pull(bobCookie, { deviceId: 'shared-dev' });
        const { ops: bobOps } = (await bobRes.json()) as { ops: { entityId: string }[] };
        expect(bobOps.map((o) => o.entityId)).toEqual([bobItemId]);

        // Both per-(device, user) cursor rows exist independently.
        const aliceState = await db.collection('deviceSyncState').findOne({ _id: `shared-dev::${aliceId}` });
        const bobState = await db.collection('deviceSyncState').findOne({ _id: `shared-dev::${bobId}` });
        expect(aliceState).not.toBeNull();
        expect(bobState).not.toBeNull();
        expect(aliceState?.user).toBe(aliceId);
        expect(bobState?.user).toBe(bobId);
        expect(aliceState?.deviceId).toBe('shared-dev');
        expect(bobState?.deviceId).toBe('shared-dev');
    });

    it('user isolation: Bob pulls zero ops after Alice pushes', async () => {
        const aliceCookie = await loginAsAlice();
        vi.restoreAllMocks();
        const bobCookie = await loginAsBob();

        const entityId = crypto.randomUUID();
        await push(aliceCookie, 'dev-alice', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);

        const res = await pull(bobCookie, { since: dayjs(0).toISOString() });
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
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
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

    it('round-trips routine.startDate through push + bootstrap', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const routineId = crypto.randomUUID();
        const ts = dayjs().toISOString();
        const snapshot = {
            _id: routineId,
            userId,
            title: 'Daily',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: ts,
            updatedTs: ts,
            startDate: '2026-06-15',
        };
        const res = await push(cookie, 'device-1', [makeClientOp('routine', routineId, 'create', snapshot)]);
        expect(res.status).toBe(200);

        const bootstrap = await authenticatedRequest(app, { method: 'GET', path: '/sync/bootstrap', sessionCookie: cookie });
        const body = (await bootstrap.json()) as { routines: Array<{ startDate?: string }> };
        expect(body.routines[0]!.startDate).toBe('2026-06-15');
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

        // Purge is fire-and-forget — poll until it converges instead of guessing a fixed delay.
        await waitForPurge(async () => (await db.collection('operations').countDocuments()) === 0);
        expect(await db.collection('operations').countDocuments()).toBe(0);
    });

    it('single device: push then pull deletes all older ops', async () => {
        const cookie = await loginAsAlice();
        const entityId = crypto.randomUUID();

        await push(cookie, 'dev-1', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);
        await tick();
        await pull(cookie, { deviceId: 'dev-1' });

        await waitForPurge(async () => (await db.collection('operations').countDocuments()) === 0);
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

// ─── Stale device cleanup ──────────────────────────────────────────────────

describe('Stale device cleanup', () => {
    it('devices inactive for >90 days are pruned from deviceSyncState and pushSubscriptions on pull', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const staleTs = dayjs().subtract(91, 'day').toISOString();

        // Per-(device, user) row for the stale device. The push subscription is still keyed by
        // raw deviceId (subscriptions are device-scoped, not user-scoped).
        await db
            .collection('deviceSyncState')
            .insertOne({ _id: `dev-stale::${userId}`, deviceId: 'dev-stale', user: userId, lastSeenTs: staleTs, lastSyncedTs: staleTs });
        await db
            .collection('pushSubscriptions')
            .insertOne({ _id: 'dev-stale', user: userId, endpoint: 'https://push.example.com/stale', keys: { p256dh: 'k1', auth: 'k2' }, updatedTs: staleTs });

        // Active device pushes and pulls — pull triggers purge
        const entityId = crypto.randomUUID();
        await push(cookie, 'dev-active', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);
        await tick();
        await pull(cookie, { deviceId: 'dev-active' });

        await waitForPurge(async () => (await db.collection('deviceSyncState').countDocuments({ deviceId: 'dev-stale' })) === 0);
        expect(await db.collection('deviceSyncState').countDocuments({ deviceId: 'dev-stale' })).toBe(0);
        expect(await db.collection('pushSubscriptions').countDocuments({ _id: 'dev-stale' })).toBe(0);
        // Active device still exists
        expect(await db.collection('deviceSyncState').countDocuments({ deviceId: 'dev-active' })).toBe(1);
    });

    it('devices active within 90 days are not pruned', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const recentTs = dayjs().subtract(30, 'day').toISOString();

        await db
            .collection('deviceSyncState')
            .insertOne({ _id: `dev-recent::${userId}`, deviceId: 'dev-recent', user: userId, lastSeenTs: recentTs, lastSyncedTs: recentTs });

        const entityId = crypto.randomUUID();
        await push(cookie, 'dev-active', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);
        await tick();
        await pull(cookie, { deviceId: 'dev-active' });
        await tick();

        expect(await db.collection('deviceSyncState').countDocuments({ deviceId: 'dev-recent' })).toBe(1);
    });

    it('stale device removal unblocks operation purging', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const staleTs = dayjs().subtract(91, 'day').toISOString();

        // Abandoned device with epoch lastSyncedTs blocks purge
        await db
            .collection('deviceSyncState')
            .insertOne({ _id: `dev-abandoned::${userId}`, deviceId: 'dev-abandoned', user: userId, lastSeenTs: staleTs, lastSyncedTs: dayjs(0).toISOString() });

        const entityId = crypto.randomUUID();
        await push(cookie, 'dev-active', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);
        await tick();
        await pull(cookie, { deviceId: 'dev-active' });

        // Purge runs in two phases: first the abandoned device row is removed, then the now-
        // unblocked operations purge fires. Wait for the second phase since it's the slower one.
        await waitForPurge(async () => (await db.collection('operations').countDocuments()) === 0);
        // Abandoned (device, user) row pruned, so ops can be purged
        expect(await db.collection('deviceSyncState').countDocuments({ deviceId: 'dev-abandoned' })).toBe(0);
        expect(await db.collection('operations').countDocuments()).toBe(0);
    });

    it('device with stale lastSeenTs but recent lastSyncedTs is not pruned', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const staleTs = dayjs().subtract(91, 'day').toISOString();
        const recentTs = dayjs().subtract(1, 'day').toISOString();

        // lastSeenTs is stale but lastSyncedTs is recent — device still pulls, just doesn't push
        await db
            .collection('deviceSyncState')
            .insertOne({ _id: `dev-pull-only::${userId}`, deviceId: 'dev-pull-only', user: userId, lastSeenTs: staleTs, lastSyncedTs: recentTs });

        const entityId = crypto.randomUUID();
        await push(cookie, 'dev-active', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);
        await tick();
        await pull(cookie, { deviceId: 'dev-active' });
        await tick();

        expect(await db.collection('deviceSyncState').countDocuments({ deviceId: 'dev-pull-only' })).toBe(1);
    });

    it('multi-user device: prunes only the stale (device, user) row and keeps the push subscription alive', async () => {
        // dev-multi has two logged-in users; alice's row is stale, bob's is active. The stale row
        // should be pruned, but the device's push subscription (keyed by raw deviceId) must stay
        // because bob still uses it. The DAO returns deviceIds whose *every* row was wiped, so
        // dev-multi is not returned and the subscription survives.
        const aliceCookie = await loginAsAlice();
        const aliceId = await getUserId(aliceCookie);
        vi.restoreAllMocks();
        const bobCookie = await loginAsBob();
        const bobId = await getUserId(bobCookie);

        const staleTs = dayjs().subtract(91, 'day').toISOString();
        const recentTs = dayjs().subtract(1, 'day').toISOString();

        await db
            .collection('deviceSyncState')
            .insertOne({ _id: `dev-multi::${aliceId}`, deviceId: 'dev-multi', user: aliceId, lastSeenTs: staleTs, lastSyncedTs: staleTs });
        await db
            .collection('deviceSyncState')
            .insertOne({ _id: `dev-multi::${bobId}`, deviceId: 'dev-multi', user: bobId, lastSeenTs: recentTs, lastSyncedTs: recentTs });
        await db.collection('pushSubscriptions').insertOne({
            _id: 'dev-multi',
            user: aliceId,
            endpoint: 'https://push.example.com/multi',
            keys: { p256dh: 'k1', auth: 'k2' },
            updatedTs: recentTs,
        });

        // Alice's pull triggers her purge — only her stale row should go.
        const entityId = crypto.randomUUID();
        await push(aliceCookie, 'dev-alice-active', [makeClientOp('item', entityId, 'create', makeItemSnapshot(entityId, '2024-01-01T00:00:00.000Z'))]);
        await tick();
        await pull(aliceCookie, { deviceId: 'dev-alice-active' });

        await waitForPurge(async () => (await db.collection('deviceSyncState').countDocuments({ _id: `dev-multi::${aliceId}` })) === 0);
        expect(await db.collection('deviceSyncState').countDocuments({ _id: `dev-multi::${aliceId}` })).toBe(0);
        expect(await db.collection('deviceSyncState').countDocuments({ _id: `dev-multi::${bobId}` })).toBe(1);
        // bob still uses dev-multi → push subscription survives
        expect(await db.collection('pushSubscriptions').countDocuments({ _id: 'dev-multi' })).toBe(1);
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
        const pullRes1 = await pull(dev2Cookie, { since: dayjs(0).toISOString(), deviceId: 'dev-2' });
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

        // Both devices have now pulled past all ops → purge fires → operations collection empty
        await waitForPurge(async () => (await db.collection('operations').countDocuments()) === 0);
        expect(await db.collection('operations').countDocuments()).toBe(0);
    });
});

// ─── Auth middleware deviceUsers upsert ─────────────────────────────────────

describe('Auth middleware deviceUsers upsert', () => {
    // Direct fetch carrying both the session cookie and an explicit X-Device-Id header — the
    // existing pull() helper sets only the query param, but the middleware reads the header.
    async function pullWithDeviceHeader(sessionCookie: string, deviceId: string | undefined): Promise<Response> {
        const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${sessionCookie}` };
        if (deviceId !== undefined) {
            headers['X-Device-Id'] = deviceId;
        }
        return app.fetch(new Request('http://localhost:4000/sync/pull', { headers }));
    }

    it('upserts a deviceUsers row when an authenticated request carries X-Device-Id', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);

        // The middleware's upsert is fire-and-forget — poll briefly because the request resolves
        // before the upsert completes.
        const res = await pullWithDeviceHeader(cookie, 'dev-via-header');
        expect(res.status).toBe(200);
        await tick();

        const row = await db.collection('deviceUsers').findOne({ _id: `dev-via-header:${userId}` });
        expect(row).not.toBeNull();
        expect(row?.deviceId).toBe('dev-via-header');
        expect(row?.userId).toBe(userId);
    });

    it('does not upsert a deviceUsers row when X-Device-Id is missing from the request', async () => {
        const cookie = await loginAsAlice();

        const res = await pullWithDeviceHeader(cookie, undefined);
        expect(res.status).toBe(200);
        await tick();

        expect(await db.collection('deviceUsers').countDocuments()).toBe(0);
    });

    it('does not upsert a deviceUsers row for an unauthenticated request even when X-Device-Id is set', async () => {
        // No session cookie — middleware rejects with 401 before reaching the upsert call.
        const res = await app.fetch(
            new Request('http://localhost:4000/sync/pull', {
                headers: { 'X-Device-Id': 'dev-unauth' },
            }),
        );
        expect(res.status).toBe(401);
        await tick();

        expect(await db.collection('deviceUsers').countDocuments()).toBe(0);
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
