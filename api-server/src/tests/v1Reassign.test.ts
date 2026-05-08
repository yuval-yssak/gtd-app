/** Public-API /v1/reassign (Phase 2 step 5). Wraps lib/reassignEntity.ts; the bearer token's
 * userId becomes `fromUserId`. Existing reassign internals (cross-account move, edit-patch
 * application, GCal create-on-target) are exhaustively unit-tested in `reassign.test.ts` —
 * the tests here focus on the route layer: scope gating, body validation, the same-user guard,
 * and the route-level happy path so a refactor can't sever the route from the orchestrator. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ReassignRoutes } from '../routes/v1/reassign.js';
import type { ApiTokenScope } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/v1', v1ReassignRoutes);

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

describe('POST /v1/reassign', () => {
    it('moves a non-calendar item from the calling token user to toUserId', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        await itemsDAO.insertOne({
            _id: 'it-1',
            user: aliceId,
            status: 'inbox',
            title: 'transfer me',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-1', toUserId: 'bob-id' }),
            }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean };
        expect(body.ok).toBe(true);
        // Item now belongs to Bob.
        const moved = await itemsDAO.findByOwnerAndId('it-1', 'bob-id');
        expect(moved).not.toBeNull();
        const stale = await itemsDAO.findByOwnerAndId('it-1', aliceId);
        expect(stale).toBeNull();
    });

    it('rejects same-user reassign with same_user code', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-1', toUserId: aliceId }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('same_user');
    });

    it('rejects unknown entityType', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'banana', entityId: 'x', toUserId: 'bob' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_entityType');
    });

    it('returns 403 when token lacks reassign scope', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['items.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-1', toUserId: 'bob' }),
            }),
        );
        expect(res.status).toBe(403);
    });

    it('returns 404 when the entity is not owned by the calling token user', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        // Seed Bob's item — Alice cannot reassign it because reassignEntity reads by fromUserId.
        await workContextsDAO.insertOne({
            _id: 'wc-bob',
            user: 'bob-id',
            name: 'bobs',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'workContext', entityId: 'wc-bob', toUserId: 'carol-id' }),
            }),
        );
        expect(res.status).toBe(404);
    });

    // Tenant isolation: Alice cannot reassign Bob's item even via the items path. Pins the
    // route-level guard against a future refactor that swaps `findByOwner` for a non-scoped
    // finder. (We test the items path here because the workContext path is in a separate test.)
    it("returns 404 when targeting another user's item (tenant isolation)", async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        await itemsDAO.insertOne({
            _id: 'it-bob',
            user: 'bob-id',
            status: 'inbox',
            title: 'bobs',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-bob', toUserId: 'carol-id' }),
            }),
        );
        expect(res.status).toBe(404);
        // Bob's item is unmoved.
        const stillBobs = await itemsDAO.findByOwnerAndId('it-bob', 'bob-id');
        expect(stillBobs).not.toBeNull();
        expect(stillBobs?.user).toBe('bob-id');
    });

    it("stamps deviceId='api:<tokenId>' on the recorded delete + create ops", async () => {
        const aliceId = await login();
        const { plaintext, record } = await issueApiToken(aliceId, 'auditable', ['reassign']);
        await itemsDAO.insertOne({
            _id: 'it-audit',
            user: aliceId,
            status: 'inbox',
            title: 'audit',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-audit', toUserId: 'bob-id' }),
            }),
        );
        expect(res.status).toBe(200);
        // Two ops are recorded for a reassign — a delete under fromUserId and a create under toUserId.
        // Both must carry the api:<tokenId> deviceId so audits can attribute the move to this token.
        const ops = await db
            .collection<{ entityId: string; deviceId: string; opType: string; user: string }>('operations')
            .find({ entityId: 'it-audit' })
            .toArray();
        expect(ops).toHaveLength(2);
        for (const op of ops) {
            expect(op.deviceId).toBe(`api:${record._id}`);
        }
    });
});
