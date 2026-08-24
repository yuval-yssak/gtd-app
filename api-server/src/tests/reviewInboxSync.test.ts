/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { syncRoutes } from '../routes/sync.js';
import { deviceSyncStateId, type EntityType, type OpType, type ReviewInboxInterface } from '../types/entities.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/sync', syncRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test_review_inboxes');
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
        db.collection('reviewInboxes').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('deviceSyncState').deleteMany({}),
    ]);
});

async function loginAsAlice(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    return sessionCookie!;
}

async function loginAsBob(): Promise<string> {
    // GitHub (not Google) so Bob gets a distinct provider identity — see sync.test.ts.
    const { sessionCookie } = await oauthLogin(app, 'github', { email: 'bob@example.com', login: 'bob-gh' });
    return sessionCookie!;
}

function makeClientOp(entityType: EntityType, entityId: string, opType: OpType, snapshot: Record<string, unknown> | null) {
    return { entityType, entityId, opType, queuedAt: dayjs().toISOString(), snapshot };
}

function makeReviewInboxSnapshot(entityId: string, updatedTs: string, overrides?: Record<string, unknown>) {
    return {
        _id: entityId,
        name: 'Email',
        order: 0,
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

async function registerDevice(deviceId: string, userId: string) {
    await db.collection('deviceSyncState').insertOne({
        _id: deviceSyncStateId(deviceId, userId),
        deviceId,
        user: userId,
        lastSyncedTs: dayjs(0).toISOString(),
        lastSyncedId: '',
        lastSeenTs: dayjs().toISOString(),
    });
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

describe('reviewInbox sync', () => {
    it('push create persists the row and pull replays the op to another device', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await registerDevice('device-a', userId);
        await registerDevice('device-b', userId);

        const now = dayjs().toISOString();
        const res = await push(cookie, 'device-a', [makeClientOp('reviewInbox', 'ri-1', 'create', makeReviewInboxSnapshot('ri-1', now))]);
        expect(res.status).toBe(200);

        const stored = await db.collection('reviewInboxes').findOne<ReviewInboxInterface>({ _id: 'ri-1' } as never);
        expect(stored).toMatchObject({ _id: 'ri-1', user: userId, name: 'Email', order: 0 });

        const pullRes = await pull(cookie, { since: dayjs(0).toISOString(), deviceId: 'device-b' });
        expect(pullRes.status).toBe(200);
        const { ops } = (await pullRes.json()) as { ops: Array<{ entityType: string; entityId: string; opType: string }> };
        const reviewInboxOps = ops.filter((op) => op.entityType === 'reviewInbox');
        expect(reviewInboxOps).toHaveLength(1);
        expect(reviewInboxOps[0]).toMatchObject({ entityId: 'ri-1', opType: 'create' });
    });

    it('update applies last-write-wins: a stale snapshot does not overwrite a newer row', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await registerDevice('device-a', userId);

        const newerTs = dayjs().toISOString();
        const staleTs = dayjs().subtract(1, 'hour').toISOString();
        await push(cookie, 'device-a', [makeClientOp('reviewInbox', 'ri-1', 'create', makeReviewInboxSnapshot('ri-1', newerTs, { name: 'Newer' }))]);
        const res = await push(cookie, 'device-a', [
            makeClientOp('reviewInbox', 'ri-1', 'update', makeReviewInboxSnapshot('ri-1', staleTs, { name: 'Stale' })),
        ]);
        expect(res.status).toBe(200);

        const stored = await db.collection('reviewInboxes').findOne<ReviewInboxInterface>({ _id: 'ri-1' } as never);
        expect(stored?.name).toBe('Newer');
    });

    it('reorder round-trips: updates to order persist per row', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await registerDevice('device-a', userId);

        const t0 = dayjs().toISOString();
        await push(cookie, 'device-a', [
            makeClientOp('reviewInbox', 'ri-1', 'create', makeReviewInboxSnapshot('ri-1', t0, { name: 'Email', order: 0 })),
            makeClientOp('reviewInbox', 'ri-2', 'create', makeReviewInboxSnapshot('ri-2', t0, { name: 'Tray', order: 1 })),
        ]);
        const t1 = dayjs().add(1, 'second').toISOString();
        const res = await push(cookie, 'device-a', [
            makeClientOp('reviewInbox', 'ri-1', 'update', makeReviewInboxSnapshot('ri-1', t1, { name: 'Email', order: 1 })),
            makeClientOp('reviewInbox', 'ri-2', 'update', makeReviewInboxSnapshot('ri-2', t1, { name: 'Tray', order: 0 })),
        ]);
        expect(res.status).toBe(200);

        const rows = await db
            .collection('reviewInboxes')
            .find<ReviewInboxInterface>({ user: userId } as never)
            .toArray();
        const byId = new Map(rows.map((row) => [row._id, row.order]));
        expect(byId.get('ri-1')).toBe(1);
        expect(byId.get('ri-2')).toBe(0);
    });

    it('delete removes the row and replays to other devices', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await registerDevice('device-a', userId);
        await registerDevice('device-b', userId);

        await push(cookie, 'device-a', [makeClientOp('reviewInbox', 'ri-1', 'create', makeReviewInboxSnapshot('ri-1', dayjs().toISOString()))]);
        const res = await push(cookie, 'device-a', [makeClientOp('reviewInbox', 'ri-1', 'delete', null)]);
        expect(res.status).toBe(200);

        expect(await db.collection('reviewInboxes').findOne({ _id: 'ri-1' } as never)).toBeNull();

        const pullRes = await pull(cookie, { since: dayjs(0).toISOString(), deviceId: 'device-b' });
        const { ops } = (await pullRes.json()) as { ops: Array<{ entityType: string; opType: string }> };
        expect(ops.filter((op) => op.entityType === 'reviewInbox').map((op) => op.opType)).toEqual(['create', 'delete']);
    });

    it('bootstrap returns the user reviewInboxes and only theirs', async () => {
        const aliceCookie = await loginAsAlice();
        const aliceId = await getUserId(aliceCookie);
        await registerDevice('device-a', aliceId);
        await push(aliceCookie, 'device-a', [makeClientOp('reviewInbox', 'ri-alice', 'create', makeReviewInboxSnapshot('ri-alice', dayjs().toISOString()))]);

        const bobCookie = await loginAsBob();
        const bobRes = await authenticatedRequest(app, { method: 'GET', path: '/sync/bootstrap?deviceId=device-bob', sessionCookie: bobCookie });
        expect(bobRes.status).toBe(200);
        const bobBody = (await bobRes.json()) as { reviewInboxes: ReviewInboxInterface[] };
        expect(bobBody.reviewInboxes).toEqual([]);

        const aliceRes = await authenticatedRequest(app, { method: 'GET', path: '/sync/bootstrap?deviceId=device-a2', sessionCookie: aliceCookie });
        const aliceBody = (await aliceRes.json()) as { reviewInboxes: ReviewInboxInterface[] };
        expect(aliceBody.reviewInboxes.map((row) => row._id)).toEqual(['ri-alice']);
    });

    it('equal updatedTs: the later-arriving snapshot wins (<= LWW gate, not <)', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await registerDevice('device-a', userId);

        const ts = dayjs().toISOString();
        await push(cookie, 'device-a', [makeClientOp('reviewInbox', 'ri-1', 'create', makeReviewInboxSnapshot('ri-1', ts, { name: 'First' }))]);
        await push(cookie, 'device-a', [makeClientOp('reviewInbox', 'ri-1', 'update', makeReviewInboxSnapshot('ri-1', ts, { name: 'Second' }))]);

        const stored = await db.collection('reviewInboxes').findOne<ReviewInboxInterface>({ _id: 'ri-1' } as never);
        expect(stored?.name).toBe('Second');
    });

    it('an update arriving after a delete is quarantined — the row stays gone and the op never replays', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await registerDevice('device-a', userId);
        await registerDevice('device-b', userId);

        await push(cookie, 'device-a', [makeClientOp('reviewInbox', 'ri-1', 'create', makeReviewInboxSnapshot('ri-1', dayjs().toISOString()))]);
        await push(cookie, 'device-a', [makeClientOp('reviewInbox', 'ri-1', 'delete', null)]);
        // A newer-updatedTs update from a device that missed the delete must not resurrect the row.
        const lateTs = dayjs().add(1, 'minute').toISOString();
        const res = await push(cookie, 'device-a', [
            makeClientOp('reviewInbox', 'ri-1', 'update', makeReviewInboxSnapshot('ri-1', lateTs, { name: 'Zombie' })),
        ]);
        expect(res.status).toBe(200);

        expect(await db.collection('reviewInboxes').findOne({ _id: 'ri-1' } as never)).toBeNull();

        const pullRes = await pull(cookie, { since: dayjs(0).toISOString(), deviceId: 'device-b' });
        const { ops } = (await pullRes.json()) as { ops: Array<{ entityType: string; opType: string }> };
        // The quarantined (notApplied) update is excluded from pull — only create + delete replay.
        expect(ops.filter((op) => op.entityType === 'reviewInbox').map((op) => op.opType)).toEqual(['create', 'delete']);
    });

    // Pins CURRENT behaviour, not desired behaviour: replaceById upserts by _id alone, so a push
    // from another user claiming an existing entityId flips the row's owner (the same pre-existing
    // gap all entities share). When per-owner write scoping lands, this test should flip to assert
    // the row stays with its original owner.
    it("PARITY PIN: another user's push for an existing entityId currently overwrites the row", async () => {
        const aliceCookie = await loginAsAlice();
        const aliceId = await getUserId(aliceCookie);
        await registerDevice('device-a', aliceId);
        await push(aliceCookie, 'device-a', [makeClientOp('reviewInbox', 'ri-shared', 'create', makeReviewInboxSnapshot('ri-shared', dayjs().toISOString()))]);

        const bobCookie = await loginAsBob();
        const bobId = await getUserId(bobCookie);
        await registerDevice('device-bob', bobId);
        const res = await push(bobCookie, 'device-bob', [
            makeClientOp(
                'reviewInbox',
                'ri-shared',
                'create',
                makeReviewInboxSnapshot('ri-shared', dayjs().add(1, 'second').toISOString(), { name: 'Stolen' }),
            ),
        ]);
        expect(res.status).toBe(200);

        const stored = await db.collection('reviewInboxes').findOne<ReviewInboxInterface>({ _id: 'ri-shared' } as never);
        expect(stored?.user).toBe(bobId);
        expect(stored?.name).toBe('Stolen');
    });

    it('strict validation 400s a snapshot with an unknown field', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await registerDevice('device-a', userId);

        const res = await push(cookie, 'device-a', [
            makeClientOp('reviewInbox', 'ri-1', 'create', makeReviewInboxSnapshot('ri-1', dayjs().toISOString(), { bogusField: true })),
        ]);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('invalid_operation');
        expect(await db.collection('reviewInboxes').findOne({ _id: 'ri-1' } as never)).toBeNull();
    });

    it('strict validation 400s a snapshot missing the required order field', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await registerDevice('device-a', userId);

        const snapshot = makeReviewInboxSnapshot('ri-1', dayjs().toISOString());
        const { order: _dropped, ...withoutOrder } = snapshot;
        const res = await push(cookie, 'device-a', [makeClientOp('reviewInbox', 'ri-1', 'create', withoutOrder)]);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('invalid_operation');
    });
});
