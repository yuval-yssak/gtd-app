/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { briefSourceHash } from '../lib/briefSource.js';
import { reassignEntity } from '../lib/reassignEntity.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { syncRoutes } from '../routes/sync.js';
import { deviceSyncStateId, type EntityType, type ItemBriefInterface, type OperationInterface, type OpType } from '../types/entities.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/sync', syncRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test_item_briefs');
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
        db.collection('deviceSyncState').deleteMany({}),
        db.collection('entityMoves').deleteMany({}),
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

const ITEM_TITLE = 'Renew passport';
const ITEM_NOTES = 'Expires in March; need photos and the old passport.';

function makeItemSnapshot(entityId: string, updatedTs: string) {
    return { _id: entityId, status: 'inbox', title: ITEM_TITLE, notes: ITEM_NOTES, createdTs: '2024-01-01T00:00:00.000Z', updatedTs };
}

function makeBriefSnapshot(itemId: string, updatedTs: string, overrides?: Record<string, unknown>) {
    return {
        _id: itemId,
        itemId,
        text: 'Passport renewal still blocked on photos',
        origin: 'user',
        sourceHash: briefSourceHash(ITEM_TITLE, ITEM_NOTES),
        generatedTs: updatedTs,
        createdTs: '2024-01-01T00:00:00.000Z',
        updatedTs,
        ...overrides,
    };
}

async function push(sessionCookie: string, deviceId: string, ops: ReturnType<typeof makeClientOp>[]) {
    return authenticatedRequest(app, { method: 'POST', path: '/sync/push', sessionCookie, body: { deviceId, ops } });
}

async function pullOps(sessionCookie: string, deviceId: string) {
    const params = new URLSearchParams({ since: dayjs(0).toISOString(), deviceId });
    const res = await authenticatedRequest(app, { method: 'GET', path: `/sync/pull?${params}`, sessionCookie });
    expect(res.status).toBe(200);
    const { ops } = (await res.json()) as { ops: Array<{ entityType: string; entityId: string; opType: string }> };
    return ops;
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
    const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
}

async function storedBrief(itemId: string) {
    return db.collection('itemBriefs').findOne<ItemBriefInterface>({ _id: itemId } as never);
}

/** Seeds Alice with a registered device, an item and a user-authored brief for it. */
async function seedAliceWithBriefedItem(itemId = 'item-1') {
    const cookie = await loginAsAlice();
    const userId = await getUserId(cookie);
    await registerDevice('device-a', userId);
    const now = dayjs().toISOString();
    const res = await push(cookie, 'device-a', [
        makeClientOp('item', itemId, 'create', makeItemSnapshot(itemId, now)),
        makeClientOp('itemBrief', itemId, 'create', makeBriefSnapshot(itemId, now)),
    ]);
    expect(res.status).toBe(200);
    return { cookie, userId, itemId };
}

describe('itemBrief sync', () => {
    it('push create persists the row (owner-stamped) and pull replays the op to another device', async () => {
        const { cookie, userId, itemId } = await seedAliceWithBriefedItem();
        await registerDevice('device-b', userId);

        const stored = await storedBrief(itemId);
        expect(stored).toMatchObject({ _id: itemId, user: userId, itemId, origin: 'user', text: 'Passport renewal still blocked on photos' });

        const ops = await pullOps(cookie, 'device-b');
        const briefOps = ops.filter((op) => op.entityType === 'itemBrief');
        expect(briefOps).toHaveLength(1);
        expect(briefOps[0]).toMatchObject({ entityId: itemId, opType: 'create' });
    });

    it('update applies last-write-wins: a stale snapshot does not overwrite a newer row', async () => {
        const { cookie, itemId } = await seedAliceWithBriefedItem();
        const staleTs = dayjs().subtract(1, 'hour').toISOString();
        const res = await push(cookie, 'device-a', [makeClientOp('itemBrief', itemId, 'update', makeBriefSnapshot(itemId, staleTs, { text: 'Stale' }))]);
        expect(res.status).toBe(200);
        expect((await storedBrief(itemId))?.text).toBe('Passport renewal still blocked on photos');
    });

    it('a newer update replaces the row without touching the item', async () => {
        const { cookie, itemId } = await seedAliceWithBriefedItem();
        // Server time, not a future stamp: the pipeline clamps a future updatedTs to now.
        const newerTs = dayjs().toISOString();
        await push(cookie, 'device-a', [makeClientOp('itemBrief', itemId, 'update', makeBriefSnapshot(itemId, newerTs, { text: 'Newer', origin: 'agent' }))]);
        expect(await storedBrief(itemId)).toMatchObject({ text: 'Newer', origin: 'agent', updatedTs: newerTs });
        const item = await db.collection('items').findOne({ _id: itemId } as never);
        expect(item).toMatchObject({ title: ITEM_TITLE });
    });

    it('hard-deleting the item cascades: the brief row is removed and an itemBrief delete op is recorded', async () => {
        const { cookie, userId, itemId } = await seedAliceWithBriefedItem();
        await registerDevice('device-b', userId);

        const res = await push(cookie, 'device-a', [makeClientOp('item', itemId, 'delete', null)]);
        expect(res.status).toBe(200);

        expect(await storedBrief(itemId)).toBeNull();
        const briefDeleteOp = await db
            .collection('operations')
            .findOne<OperationInterface>({ entityType: 'itemBrief', entityId: itemId, opType: 'delete' } as never);
        expect(briefDeleteOp).toMatchObject({ user: userId, snapshot: null, deviceId: 'server:brief-cascade' });

        // Another device sees the cascade in the op stream, after the item delete it reacts to.
        const ops = await pullOps(cookie, 'device-b');
        const sequence = ops.map((op) => `${op.entityType}:${op.opType}`);
        expect(sequence).toEqual(['item:create', 'itemBrief:create', 'item:delete', 'itemBrief:delete']);
    });

    it('hard-deleting an item that never had a brief records no itemBrief op', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await registerDevice('device-a', userId);
        await push(cookie, 'device-a', [makeClientOp('item', 'bare', 'create', makeItemSnapshot('bare', dayjs().toISOString()))]);
        await push(cookie, 'device-a', [makeClientOp('item', 'bare', 'delete', null)]);
        expect(await db.collection('operations').countDocuments({ entityType: 'itemBrief' } as never)).toBe(0);
    });

    it('explicit itemBrief delete removes the row and replays to other devices', async () => {
        const { cookie, userId, itemId } = await seedAliceWithBriefedItem();
        await registerDevice('device-b', userId);
        const res = await push(cookie, 'device-a', [makeClientOp('itemBrief', itemId, 'delete', null)]);
        expect(res.status).toBe(200);
        expect(await storedBrief(itemId)).toBeNull();
        const ops = await pullOps(cookie, 'device-b');
        expect(ops.filter((op) => op.entityType === 'itemBrief').map((op) => op.opType)).toEqual(['create', 'delete']);
    });

    it('reassigning the item drops the brief on the source user with a recorded delete op, and creates none on the target', async () => {
        const { userId: aliceId, itemId } = await seedAliceWithBriefedItem();
        const bobCookie = await loginAsBob();
        const bobId = await getUserId(bobCookie);

        const result = await reassignEntity({ entityType: 'item', entityId: itemId, fromUserId: aliceId, toUserId: bobId });
        expect(result).toEqual({ ok: true });

        expect(await db.collection('itemBriefs').countDocuments({ _id: itemId } as never)).toBe(0);
        const item = await db.collection('items').findOne({ _id: itemId } as never);
        expect(item).toMatchObject({ user: bobId });
        const briefOps = await db
            .collection('operations')
            .find<OperationInterface>({ entityType: 'itemBrief' } as never)
            .toArray();
        expect(briefOps.map((op) => `${op.user}:${op.opType}`)).toEqual([`${aliceId}:create`, `${aliceId}:delete`]);
    });

    it('a reassign retry (already-moved path) still drops a brief stranded by a crash after the flip', async () => {
        const { userId: aliceId, itemId } = await seedAliceWithBriefedItem();
        const bobCookie = await loginAsBob();
        const bobId = await getUserId(bobCookie);
        const params = { entityType: 'item' as const, entityId: itemId, fromUserId: aliceId, toUserId: bobId };
        expect(await reassignEntity(params)).toEqual({ ok: true });
        // Simulate the crash window: the flip + move receipt landed, but the cascade never ran.
        const now = dayjs().toISOString();
        await db.collection('itemBriefs').insertOne({ ...makeBriefSnapshot(itemId, now), user: aliceId } as never);

        expect(await reassignEntity(params)).toEqual({ ok: true, alreadyMoved: true });

        expect(await db.collection('itemBriefs').countDocuments({ _id: itemId } as never)).toBe(0);
        const briefOps = await db
            .collection('operations')
            .find<OperationInterface>({ entityType: 'itemBrief', user: aliceId } as never)
            .toArray();
        expect(briefOps.map((op) => op.opType)).toEqual(['create', 'delete', 'delete']);
    });

    it('bootstrap returns the user itemBriefs and only theirs', async () => {
        const { cookie: aliceCookie, itemId } = await seedAliceWithBriefedItem('item-alice');

        const bobCookie = await loginAsBob();
        const bobRes = await authenticatedRequest(app, { method: 'GET', path: '/sync/bootstrap?deviceId=device-bob', sessionCookie: bobCookie });
        expect(bobRes.status).toBe(200);
        const bobBody = (await bobRes.json()) as { itemBriefs: ItemBriefInterface[] };
        expect(bobBody.itemBriefs).toEqual([]);

        const aliceRes = await authenticatedRequest(app, { method: 'GET', path: '/sync/bootstrap?deviceId=device-a2', sessionCookie: aliceCookie });
        const aliceBody = (await aliceRes.json()) as { itemBriefs: ItemBriefInterface[] };
        expect(aliceBody.itemBriefs.map((row) => row._id)).toEqual([itemId]);
    });

    it('an update arriving after a delete is quarantined — the row stays gone and the op never replays', async () => {
        const { cookie, userId, itemId } = await seedAliceWithBriefedItem();
        await registerDevice('device-b', userId);
        await push(cookie, 'device-a', [makeClientOp('itemBrief', itemId, 'delete', null)]);
        const lateTs = dayjs().add(1, 'minute').toISOString();
        const res = await push(cookie, 'device-a', [makeClientOp('itemBrief', itemId, 'update', makeBriefSnapshot(itemId, lateTs, { text: 'Zombie' }))]);
        expect(res.status).toBe(200);
        expect(await storedBrief(itemId)).toBeNull();
        const ops = await pullOps(cookie, 'device-b');
        expect(ops.filter((op) => op.entityType === 'itemBrief').map((op) => op.opType)).toEqual(['create', 'delete']);
    });

    describe('strict schema', () => {
        async function pushBrief(snapshot: Record<string, unknown>) {
            const cookie = await loginAsAlice();
            const userId = await getUserId(cookie);
            await registerDevice('device-a', userId);
            const res = await push(cookie, 'device-a', [makeClientOp('itemBrief', 'item-1', 'create', snapshot)]);
            return { res, body: (await res.json()) as { code?: string; path?: string[] } };
        }

        it('400s a snapshot with an unknown field', async () => {
            const { res, body } = await pushBrief(makeBriefSnapshot('item-1', dayjs().toISOString(), { bogusField: true }));
            expect(res.status).toBe(400);
            expect(body.code).toBe('invalid_operation');
            expect(await storedBrief('item-1')).toBeNull();
        });

        it('400s a snapshot missing sourceHash', async () => {
            const { sourceHash: _dropped, ...withoutHash } = makeBriefSnapshot('item-1', dayjs().toISOString());
            const { res, body } = await pushBrief(withoutHash);
            expect(res.status).toBe(400);
            expect(body.code).toBe('invalid_operation');
            expect(body.path).toEqual(['snapshot', 'sourceHash']);
        });

        it('400s a snapshot whose itemId disagrees with _id', async () => {
            const { res, body } = await pushBrief(makeBriefSnapshot('item-1', dayjs().toISOString(), { itemId: 'other' }));
            expect(res.status).toBe(400);
            expect(body.code).toBe('invalid_operation');
            expect(body.path).toEqual(['snapshot', 'itemId']);
        });

        it('accepts the optional model field and a null text on a skipped row (superset of the interface)', async () => {
            const { res } = await pushBrief(makeBriefSnapshot('item-1', dayjs().toISOString(), { text: null, origin: 'skipped', model: 'claude-haiku-4-5' }));
            expect(res.status).toBe(200);
            expect(await storedBrief('item-1')).toMatchObject({ text: null, origin: 'skipped', model: 'claude-haiku-4-5' });
        });
    });
});
