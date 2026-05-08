/** Cross-surface parity (Phase 2 step 8): the same op shape submitted via /sync/push and via
 * /v1/operations/batch must produce identical persisted state and identical fan-out (operations
 * log shape, webhook payload). Pins the "no contract drift between the two surfaces" property
 * — the load-bearing goal of the Phase 1 + 2 overhaul. */
/** biome-ignore-all lint/style/noNonNullAssertion: tests assert preconditions before using ! */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { syncRoutes } from '../routes/sync.js';
import { v1OperationsRoutes } from '../routes/v1/operations.js';
import type { ApiTokenScope } from '../types/entities.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/sync', syncRoutes)
    .route('/v1', v1OperationsRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test_cross_surface');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('user').deleteMany({}),
        db.collection('session').deleteMany({}),
        db.collection('account').deleteMany({}),
        db.collection('apiTokens').deleteMany({}),
        db.collection('items').deleteMany({}),
        db.collection('people').deleteMany({}),
        db.collection('workContexts').deleteMany({}),
        db.collection('routines').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('webhookSubscriptions').deleteMany({}),
        db.collection('webhookDeliveries').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

async function loginAndUserId(): Promise<{ userId: string; sessionCookie: string }> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    if (!sessionCookie) throw new Error('expected session cookie');
    const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await res.json()) as { user: { id: string } };
    return { userId: user.id, sessionCookie };
}

async function tokenWith(userId: string, scopes: ApiTokenScope[]): Promise<string> {
    const { plaintext } = await issueApiToken(userId, 't', scopes);
    return plaintext;
}

function workContextSnapshot(userId: string, _id: string, ts: string) {
    return { _id, user: userId, name: 'shared shape', createdTs: ts, updatedTs: ts };
}

describe('cross-surface parity: /sync/push vs /v1/operations/batch', () => {
    it('the same workContext.create snapshot persists identically and logs equivalent operation rows', async () => {
        const { userId, sessionCookie } = await loginAndUserId();
        const token = await tokenWith(userId, ['contexts.write']);
        const ts = dayjs().toISOString();

        // 1. Submit via /sync/push (the cookie-authed first-party surface).
        const syncId = '11111111-1111-1111-1111-111111111111';
        const syncRes = await authenticatedRequest(app, {
            method: 'POST',
            path: '/sync/push',
            sessionCookie,
            body: {
                deviceId: 'dev-sync',
                ops: [{ entityType: 'workContext', entityId: syncId, opType: 'create', queuedAt: ts, snapshot: workContextSnapshot(userId, syncId, ts) }],
            },
        });
        expect(syncRes.status).toBe(200);

        // 2. Submit the equivalent op via /v1/operations/batch.
        const v1Id = '22222222-2222-2222-2222-222222222222';
        const v1Res = await app.fetch(
            new Request('http://localhost:4000/v1/operations/batch', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ops: [{ entityType: 'workContext', entityId: v1Id, opType: 'create', snapshot: workContextSnapshot(userId, v1Id, ts) }],
                }),
            }),
        );
        expect(v1Res.status).toBe(200);

        // 3. Persisted-state parity: both rows exist and carry the same shape modulo _id.
        const syncRow = await workContextsDAO.findByOwnerAndId(syncId, userId);
        const v1Row = await workContextsDAO.findByOwnerAndId(v1Id, userId);
        expect(syncRow).not.toBeNull();
        expect(v1Row).not.toBeNull();
        // Strip _id to compare the structural shape.
        const { _id: _s1, ...syncFields } = syncRow!;
        const { _id: _s2, ...v1Fields } = v1Row!;
        expect(syncFields).toEqual(v1Fields);

        // 4. Operations-log parity: both ops have the same entityType/opType, the v1 op's
        //    deviceId is `api:<tokenId>` while the sync op's is `dev-sync`. Snapshot shape is
        //    otherwise identical modulo the _id and (optional) device-id-derived fields.
        const syncOps = await operationsDAO.findArray({ entityId: syncId });
        const v1Ops = await operationsDAO.findArray({ entityId: v1Id });
        expect(syncOps).toHaveLength(1);
        expect(v1Ops).toHaveLength(1);
        const [syncOp] = syncOps;
        const [v1Op] = v1Ops;
        if (!syncOp || !v1Op) throw new Error('expected one op per surface');
        expect(syncOp.entityType).toBe(v1Op.entityType);
        expect(syncOp.opType).toBe(v1Op.opType);
        expect(syncOp.user).toBe(v1Op.user);
        expect(syncOp.deviceId).toBe('dev-sync');
        expect(v1Op.deviceId.startsWith('api:')).toBe(true);
        // Snapshot parity (modulo _id) — same shared apply pipeline ⇒ same ambient stamping.
        const ssyncSnap = (syncOp.snapshot ?? {}) as Record<string, unknown>;
        const sv1Snap = (v1Op.snapshot ?? {}) as Record<string, unknown>;
        const { _id: _ss, ...ssRest } = ssyncSnap as Record<string, unknown> & { _id?: string };
        const { _id: _vs, ...vsRest } = sv1Snap as Record<string, unknown> & { _id?: string };
        expect(ssRest).toEqual(vsRest);
    });

    it('the same item.create snapshot persists identically across surfaces', async () => {
        const { userId, sessionCookie } = await loginAndUserId();
        const token = await tokenWith(userId, ['items.capture']);
        const ts = dayjs().toISOString();
        const baseItem = (id: string) => ({ _id: id, user: userId, status: 'inbox' as const, title: 'shared', createdTs: ts, updatedTs: ts });

        const syncId = '33333333-3333-3333-3333-333333333333';
        await authenticatedRequest(app, {
            method: 'POST',
            path: '/sync/push',
            sessionCookie,
            body: { deviceId: 'dev-sync', ops: [{ entityType: 'item', entityId: syncId, opType: 'create', queuedAt: ts, snapshot: baseItem(syncId) }] },
        }).then((r) => expect(r.status).toBe(200));

        const v1Id = '44444444-4444-4444-4444-444444444444';
        await app
            .fetch(
                new Request('http://localhost:4000/v1/operations/batch', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ops: [{ entityType: 'item', entityId: v1Id, opType: 'create', snapshot: baseItem(v1Id) }] }),
                }),
            )
            .then((r) => expect(r.status).toBe(200));

        const syncRow = await db.collection('items').findOne({ _id: syncId } as never);
        const v1Row = await db.collection('items').findOne({ _id: v1Id } as never);
        expect(syncRow).not.toBeNull();
        expect(v1Row).not.toBeNull();
        const { _id: _s, ...sSync } = syncRow as Record<string, unknown> & { _id: string };
        const { _id: _v, ...sV1 } = v1Row as Record<string, unknown> & { _id: string };
        expect(sSync).toEqual(sV1);
    });

    it('the same routine.create snapshot persists identically across surfaces', async () => {
        const { userId, sessionCookie } = await loginAndUserId();
        const token = await tokenWith(userId, ['routines.write']);
        const ts = dayjs().toISOString();
        const baseRoutine = (id: string) => ({
            _id: id,
            user: userId,
            title: 'shared routine',
            routineType: 'nextAction' as const,
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: ts,
            updatedTs: ts,
        });

        const syncId = '55555555-5555-5555-5555-555555555555';
        await authenticatedRequest(app, {
            method: 'POST',
            path: '/sync/push',
            sessionCookie,
            body: { deviceId: 'dev-sync', ops: [{ entityType: 'routine', entityId: syncId, opType: 'create', queuedAt: ts, snapshot: baseRoutine(syncId) }] },
        }).then((r) => expect(r.status).toBe(200));

        const v1Id = '66666666-6666-6666-6666-666666666666';
        await app
            .fetch(
                new Request('http://localhost:4000/v1/operations/batch', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ops: [{ entityType: 'routine', entityId: v1Id, opType: 'create', snapshot: baseRoutine(v1Id) }] }),
                }),
            )
            .then((r) => expect(r.status).toBe(200));

        const syncRow = await db.collection('routines').findOne({ _id: syncId } as never);
        const v1Row = await db.collection('routines').findOne({ _id: v1Id } as never);
        expect(syncRow).not.toBeNull();
        expect(v1Row).not.toBeNull();
        const { _id: _s, ...sSync } = syncRow as Record<string, unknown> & { _id: string };
        const { _id: _v, ...sV1 } = v1Row as Record<string, unknown> & { _id: string };
        expect(sSync).toEqual(sV1);
    });

    it('an invalid op (Zod-failing snapshot) is rejected by both surfaces with structurally similar errors', async () => {
        const { userId, sessionCookie } = await loginAndUserId();
        const token = await tokenWith(userId, ['contexts.write']);
        const ts = dayjs().toISOString();

        // Missing `name` — workContext is invalid under WorkContextSnapshotSchema.
        const invalid = { _id: 'wc-bad', user: userId, createdTs: ts, updatedTs: ts };

        // /sync/push → 400 with structured error.
        const syncRes = await authenticatedRequest(app, {
            method: 'POST',
            path: '/sync/push',
            sessionCookie,
            body: { deviceId: 'dev-sync', ops: [{ entityType: 'workContext', entityId: 'wc-bad', opType: 'create', queuedAt: ts, snapshot: invalid }] },
        });
        expect(syncRes.status).toBe(400);

        // /v1/operations/batch → 400 with the same code.
        const v1Res = await app.fetch(
            new Request('http://localhost:4000/v1/operations/batch', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ops: [{ entityType: 'workContext', entityId: 'wc-bad', opType: 'create', snapshot: invalid }] }),
            }),
        );
        expect(v1Res.status).toBe(400);
        const syncBody = (await syncRes.json()) as { code: string };
        const v1Body = (await v1Res.json()) as { code: string };
        expect(syncBody.code).toBe(v1Body.code);

        // No persisted row from either surface.
        expect(await workContextsDAO.findByOwnerAndId('wc-bad', userId)).toBeNull();
    });
});
