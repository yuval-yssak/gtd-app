/** biome-ignore-all lint/style/noNonNullAssertion: tests assert preconditions before using ! */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { syncRoutes } from '../routes/sync.js';
import type { EntityType, OpType } from '../types/entities.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

// /sync/push enforces "ops in this batch belong to the active session" via a 400 mismatch guard.
// This file isolates that contract — the broader sync.test.ts file covers the happy path.
const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/sync', syncRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test_push_mismatch');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('user').deleteMany({}),
        db.collection('session').deleteMany({}),
        db.collection('account').deleteMany({}),
        db.collection('items').deleteMany({}),
        db.collection('routines').deleteMany({}),
        db.collection('operations').deleteMany({}),
    ]);
    vi.restoreAllMocks();
});

function makeClientOp(entityType: EntityType, entityId: string, opType: OpType, snapshot: Record<string, unknown> | null) {
    return { entityType, entityId, opType, queuedAt: dayjs().toISOString(), snapshot };
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

async function push(sessionCookie: string, deviceId: string, ops: ReturnType<typeof makeClientOp>[]) {
    return authenticatedRequest(app, { method: 'POST', path: '/sync/push', sessionCookie, body: { deviceId, ops } });
}

describe('POST /sync/push — userId mismatch guard', () => {
    it('200 when snapshot.userId matches the session user.id', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const userId = await getUserId(sessionCookie!);
        const entityId = crypto.randomUUID();

        const res = await push(sessionCookie!, 'dev-1', [
            makeClientOp('item', entityId, 'create', {
                _id: entityId,
                userId,
                status: 'inbox',
                title: 'ok',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            }),
        ]);
        expect(res.status).toBe(200);
    });

    it('400 when snapshot.userId is set and does NOT match the session user.id', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const entityId = crypto.randomUUID();

        const res = await push(sessionCookie!, 'dev-1', [
            makeClientOp('item', entityId, 'create', {
                _id: entityId,
                userId: 'someone-else',
                status: 'inbox',
                title: 'forged',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            }),
        ]);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/userId mismatch/);
        // Forged op was rejected outright — nothing landed in the DB.
        expect(await db.collection('items').countDocuments({ _id: entityId })).toBe(0);
        expect(await db.collection('operations').countDocuments({ entityId })).toBe(0);
    });

    it('200 when snapshot has no userId field at all (back-compat — server stamps from session)', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const entityId = crypto.randomUUID();

        const res = await push(sessionCookie!, 'dev-1', [
            makeClientOp('item', entityId, 'create', {
                _id: entityId,
                status: 'inbox',
                title: 'no userId',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            }),
        ]);
        expect(res.status).toBe(200);
    });

    it('400 when ANY op in the batch is mismatched, even if others are fine', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const userId = await getUserId(sessionCookie!);
        const okId = crypto.randomUUID();
        const badId = crypto.randomUUID();

        const res = await push(sessionCookie!, 'dev-1', [
            makeClientOp('item', okId, 'create', {
                _id: okId,
                userId,
                status: 'inbox',
                title: 'ok',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            }),
            makeClientOp('item', badId, 'create', {
                _id: badId,
                userId: 'someone-else',
                status: 'inbox',
                title: 'bad',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            }),
        ]);
        expect(res.status).toBe(400);
        // Whole batch is rejected — the "ok" op must NOT have been applied.
        expect(await db.collection('items').countDocuments({ _id: okId })).toBe(0);
    });

    it('200 when an op has snapshot=null (delete op) — guard short-circuits on the optional chain', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const userId = await getUserId(sessionCookie!);
        const entityId = crypto.randomUUID();

        // Seed the item so the delete op has something to remove.
        await db.collection('items').insertOne({
            _id: entityId,
            user: userId,
            status: 'inbox',
            title: 'to delete',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        const res = await push(sessionCookie!, 'dev-1', [makeClientOp('item', entityId, 'delete', null)]);
        expect(res.status).toBe(200);
        expect(await db.collection('items').countDocuments({ _id: entityId })).toBe(0);
    });

    it('400 on a forged routine op — guard is type-agnostic across entity types', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const routineId = crypto.randomUUID();

        const res = await push(sessionCookie!, 'dev-1', [
            makeClientOp('routine', routineId, 'create', {
                _id: routineId,
                userId: 'someone-else',
                title: 'forged routine',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            }),
        ]);
        expect(res.status).toBe(400);
        expect(await db.collection('routines').countDocuments({ _id: routineId })).toBe(0);
    });
});
