/** Public-API batch endpoint /v1/operations/batch (Phase 2 step 6). The route layer parses the
 * batch shape, computes the union of required scopes (rejecting before any write if any scope
 * is missing), then hands off to applyAndPublishOperations in strict mode for atomic
 * Zod-validation + persistence. Tests pin: scope-union 403 atomicity, Zod 400 atomicity, happy
 * paths across heterogeneous ops, and that the operations log records every op. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1OperationsRoutes } from '../routes/v1/operations.js';
import type { ApiTokenScope } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/v1', v1OperationsRoutes);

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
        db.collection('apiTokens').deleteMany({}),
        db.collection('items').deleteMany({}),
        db.collection('people').deleteMany({}),
        db.collection('workContexts').deleteMany({}),
        db.collection('routines').deleteMany({}),
        db.collection('operations').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

async function login(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    const sessionRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    return user.id;
}

async function tokenWith(userId: string, scopes: ApiTokenScope[]): Promise<string> {
    const { plaintext } = await issueApiToken(userId, 't', scopes);
    return plaintext;
}

const NOW = '2026-04-01T00:00:00.000Z';

function itemSnapshot(userId: string, _id: string, status: 'inbox' | 'nextAction' = 'inbox') {
    return { _id, user: userId, status, title: `t-${_id}`, createdTs: NOW, updatedTs: NOW };
}
function workContextSnapshot(userId: string, _id: string) {
    return { _id, user: userId, name: `wc-${_id}`, createdTs: NOW, updatedTs: NOW };
}
function personSnapshot(userId: string, _id: string) {
    return { _id, user: userId, name: `p-${_id}`, createdTs: NOW, updatedTs: NOW };
}

describe('POST /v1/operations/batch', () => {
    it('applies a heterogeneous batch (workContext + item + person) atomically and logs ops', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['items.capture', 'contexts.write', 'people.write']);
        const ops = [
            { entityType: 'workContext', opType: 'create', entityId: 'wc-1', snapshot: workContextSnapshot(userId, 'wc-1') },
            { entityType: 'item', opType: 'create', entityId: 'it-1', snapshot: itemSnapshot(userId, 'it-1') },
            { entityType: 'person', opType: 'create', entityId: 'p-1', snapshot: personSnapshot(userId, 'p-1') },
        ];
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/operations/batch', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ops }),
            }),
        );
        expect(res.status).toBe(200);
        expect((await res.json()) as { ok: boolean; count: number }).toEqual({ ok: true, count: 3 });

        // Every entity persisted under the calling user.
        expect(await workContextsDAO.findByOwnerAndId('wc-1', userId)).not.toBeNull();
        expect(await itemsDAO.findByOwnerAndId('it-1', userId)).not.toBeNull();
        expect(await peopleDAO.findByOwnerAndId('p-1', userId)).not.toBeNull();

        // Operations log: 3 rows, one per op.
        const logged = await operationsDAO.findArray({ user: userId });
        expect(logged).toHaveLength(3);
    });

    it('rejects the whole batch with 403 when any op needs a scope the token lacks (no partial writes)', async () => {
        const userId = await login();
        // capture + workContexts write — but missing people.write
        const token = await tokenWith(userId, ['items.capture', 'contexts.write']);
        const ops = [
            { entityType: 'workContext', opType: 'create', entityId: 'wc-1', snapshot: workContextSnapshot(userId, 'wc-1') },
            { entityType: 'person', opType: 'create', entityId: 'p-1', snapshot: personSnapshot(userId, 'p-1') },
        ];
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/operations/batch', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ops }),
            }),
        );
        expect(res.status).toBe(403);
        const body = (await res.json()) as { code: string; requiredScope: string };
        expect(body.code).toBe('forbidden_scope');
        expect(body.requiredScope).toBe('people.write');
        // Critically: NEITHER op was applied.
        expect(await workContextsDAO.findByOwnerAndId('wc-1', userId)).toBeNull();
        expect(await peopleDAO.findByOwnerAndId('p-1', userId)).toBeNull();
        expect(await operationsDAO.findArray({ user: userId })).toHaveLength(0);
    });

    it('rejects the whole batch with 400 when any op fails Zod (no partial writes)', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['items.capture', 'contexts.write']);
        // First op valid; second op missing a required field (`name`) for workContext.
        const ops = [
            { entityType: 'item', opType: 'create', entityId: 'it-1', snapshot: itemSnapshot(userId, 'it-1') },
            { entityType: 'workContext', opType: 'create', entityId: 'wc-1', snapshot: { _id: 'wc-1', user: userId, createdTs: NOW, updatedTs: NOW } },
        ];
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/operations/batch', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ops }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_operation');
        // Neither op should have been applied.
        expect(await itemsDAO.findByOwnerAndId('it-1', userId)).toBeNull();
        expect(await workContextsDAO.findByOwnerAndId('wc-1', userId)).toBeNull();
    });

    it('rejects an empty ops array', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['items.capture']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/operations/batch', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ops: [] }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_ops');
    });

    it('rejects a malformed op shape with invalid_op_shape', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['items.capture']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/operations/batch', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ops: [{ entityType: 'item' }] }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_op_shape');
    });

    it('rejects an item hard-delete with invalid_op_shape and leaves the row intact', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['items.capture', 'items.write']);
        await itemsDAO.insertOne(itemSnapshot(userId, 'it-keep'));
        const ops = [{ entityType: 'item', opType: 'delete', entityId: 'it-keep', snapshot: null }];
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/operations/batch', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ops }),
            }),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe('invalid_op_shape');
        // Error message must steer the caller to the recoverable trash endpoint.
        expect(body.error).toContain('/v1/items/:id/trash');
        // The row must NOT have been removed — the rejection happens before any persistence.
        expect(await itemsDAO.findByOwnerAndId('it-keep', userId)).not.toBeNull();
    });

    it('still allows hard-delete for non-item entities (routine/person/workContext)', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['contexts.write']);
        await db.collection('workContexts').insertOne(workContextSnapshot(userId, 'wc-del') as never);
        const ops = [{ entityType: 'workContext', opType: 'delete', entityId: 'wc-del', snapshot: null }];
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/operations/batch', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ops }),
            }),
        );
        expect(res.status).toBe(200);
        expect(await db.collection('workContexts').findOne({ _id: 'wc-del' } as never)).toBeNull();
    });

    it('item.update vs item.create scopes differ: a token with only items.capture cannot send item.update in a batch', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['items.capture']);
        await itemsDAO.insertOne(itemSnapshot(userId, 'it-1'));
        const ops = [{ entityType: 'item', opType: 'update', entityId: 'it-1', snapshot: { ...itemSnapshot(userId, 'it-1'), title: 'patched' } }];
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/operations/batch', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ops }),
            }),
        );
        expect(res.status).toBe(403);
        expect(((await res.json()) as { requiredScope: string }).requiredScope).toBe('items.write');
    });

    // Pre-existing tenant-isolation hole: `replaceById` is keyed by `_id` only, so a `create` op
    // submitted with another user's UUID currently overwrites that row. The pipeline re-stamps
    // `snapshot.user` to the calling user, but the row is already owned by Bob — the result is
    // a tenant-clobber + theft. This test pins TODAY'S behavior (the create succeeds and Bob's
    // row is overwritten) so a Phase 3 fix to `replaceById` (scope by user) can flip the
    // assertion deliberately rather than discovering the regression in production. Per memory
    // `feedback_tenant_isolation_test_gap.md`.
    it('TODO Phase 3: documents the replaceById tenant-isolation hole on /operations/batch', async () => {
        const aliceId = await login();
        const aliceToken = await tokenWith(aliceId, ['items.capture']);
        // Bob owns it-bob; Alice tries to "create" with the same _id.
        await itemsDAO.insertOne({ _id: 'it-bob', user: 'bob-id', status: 'inbox', title: 'bobs', createdTs: NOW, updatedTs: NOW });
        const ops = [{ entityType: 'item', opType: 'create', entityId: 'it-bob', snapshot: itemSnapshot(aliceId, 'it-bob') }];
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/operations/batch', {
                method: 'POST',
                headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ops }),
            }),
        );
        // CURRENT BEHAVIOR — succeeds and clobbers Bob's row.
        expect(res.status).toBe(200);
        const stillBobs = await itemsDAO.findByOwnerAndId('it-bob', 'bob-id');
        const nowAlice = await itemsDAO.findByOwnerAndId('it-bob', aliceId);
        expect(stillBobs).toBeNull();
        expect(nowAlice?.user).toBe(aliceId);
        // PHASE-3 FIX: this test should be updated to expect a 4xx and Bob's row preserved when
        // `replaceById` becomes user-scoped. Until then, the batch endpoint inherits the same
        // hole that exists on /sync/push and the per-entity write routes.
    });
});
