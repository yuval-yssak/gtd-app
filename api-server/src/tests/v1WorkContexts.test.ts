/** Public-API CRUD for /v1/work-contexts (Phase 2 step 3). Asserts: scope gating, request-body
 * validation, the apply-pipeline-strict-mode integration (operations are persisted, the row in
 * `workContexts` matches the snapshot, the operations log records every write), and idempotent
 * delete behaviour. Read-side pagination + tenant isolation lives in `v1References.test.ts`. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1WorkContextsRoutes } from '../routes/v1/workContexts.js';
import type { ApiTokenScope } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/v1', v1WorkContextsRoutes);

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
        db.collection('workContexts').deleteMany({}),
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

interface PublicWorkContext {
    _id: string;
    name: string;
    createdTs: string;
    updatedTs: string;
}

describe('POST /v1/work-contexts', () => {
    it('creates a work context, persists the snapshot, and writes a create op', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['contexts.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/work-contexts', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'near a phone' }),
            }),
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as PublicWorkContext;
        expect(body.name).toBe('near a phone');
        const stored = await workContextsDAO.findByOwnerAndId(body._id, userId);
        expect(stored?.name).toBe('near a phone');
        const ops = await operationsDAO.findArray({ entityId: body._id });
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('create');
    });

    it('rejects missing name with invalid_name', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['contexts.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/work-contexts', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_name');
    });

    it('returns 403 when token lacks contexts.write', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['contexts.read']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/work-contexts', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'x' }),
            }),
        );
        expect(res.status).toBe(403);
    });
});

describe('GET /v1/work-contexts/:id', () => {
    it('returns the row for the caller', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['contexts.read']);
        await workContextsDAO.insertOne({
            _id: 'wc-1',
            user: userId,
            name: 'at home',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(new Request('http://localhost:4000/v1/work-contexts/wc-1', { headers: { Authorization: `Bearer ${token}` } }));
        expect(res.status).toBe(200);
        expect(((await res.json()) as PublicWorkContext).name).toBe('at home');
    });

    it('returns 404 when the row does not exist', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['contexts.read']);
        const res = await app.fetch(new Request('http://localhost:4000/v1/work-contexts/missing', { headers: { Authorization: `Bearer ${token}` } }));
        expect(res.status).toBe(404);
    });
});

describe('PATCH /v1/work-contexts/:id', () => {
    it('updates the name and writes an update op', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['contexts.write']);
        await workContextsDAO.insertOne({
            _id: 'wc-1',
            user: userId,
            name: 'old',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/work-contexts/wc-1', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'new' }),
            }),
        );
        expect(res.status).toBe(200);
        expect(((await res.json()) as PublicWorkContext).name).toBe('new');
        const stored = await workContextsDAO.findByOwnerAndId('wc-1', userId);
        expect(stored?.name).toBe('new');
        const ops = await operationsDAO.findArray({ entityId: 'wc-1', opType: 'update' });
        expect(ops).toHaveLength(1);
    });

    it('rejects an empty body', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['contexts.write']);
        await workContextsDAO.insertOne({ _id: 'wc-1', user: userId, name: 'x', createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z' });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/work-contexts/wc-1', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('empty_body');
    });

    it('returns 404 for missing id', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['contexts.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/work-contexts/missing', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'x' }),
            }),
        );
        expect(res.status).toBe(404);
    });
});

describe('DELETE /v1/work-contexts/:id', () => {
    it('deletes the row and writes a delete op', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['contexts.write']);
        await workContextsDAO.insertOne({ _id: 'wc-1', user: userId, name: 'x', createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z' });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/work-contexts/wc-1', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }),
        );
        expect(res.status).toBe(200);
        const stored = await workContextsDAO.findByOwnerAndId('wc-1', userId);
        expect(stored).toBeNull();
        const ops = await operationsDAO.findArray({ entityId: 'wc-1', opType: 'delete' });
        expect(ops).toHaveLength(1);
    });

    it('is idempotent for a missing id', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['contexts.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/work-contexts/missing', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; alreadyDeleted: boolean };
        expect(body.alreadyDeleted).toBe(true);
    });
});

// Tenant-isolation regression: a token belonging to user A must not be able to read, modify, or
// delete a workContext owned by user B. The route layer's `findByOwnerAndId` is the gate; if a
// future refactor swaps it for a non-owner-scoped finder, these tests catch the regression.
describe('tenant isolation', () => {
    it("PATCH targeting another user's row returns 404 and does not modify it", async () => {
        const aliceId = await login();
        const aliceToken = await tokenWith(aliceId, ['contexts.write']);
        await workContextsDAO.insertOne({
            _id: 'wc-bob',
            user: 'bob-user-id',
            name: 'bob-only',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/work-contexts/wc-bob', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'pwned' }),
            }),
        );
        expect(res.status).toBe(404);
        const stored = await workContextsDAO.findByOwnerAndId('wc-bob', 'bob-user-id');
        expect(stored?.name).toBe('bob-only');
        const ops = await operationsDAO.findArray({ entityId: 'wc-bob' });
        expect(ops).toHaveLength(0);
    });

    it("DELETE targeting another user's row returns 200 alreadyDeleted (the row remains)", async () => {
        const aliceId = await login();
        const aliceToken = await tokenWith(aliceId, ['contexts.write']);
        await workContextsDAO.insertOne({
            _id: 'wc-bob',
            user: 'bob-user-id',
            name: 'bob-only',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/work-contexts/wc-bob', { method: 'DELETE', headers: { Authorization: `Bearer ${aliceToken}` } }),
        );
        expect(res.status).toBe(200);
        // From Alice's tenant the row "doesn't exist", so DELETE returns alreadyDeleted — Bob's row stays.
        const stored = await workContextsDAO.findByOwnerAndId('wc-bob', 'bob-user-id');
        expect(stored?.name).toBe('bob-only');
    });

    it('rejects forbidden_field on POST (caller-supplied user)', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['contexts.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/work-contexts', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'x', user: 'attacker' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('forbidden_field');
    });
});
