/** Public-API CRUD for /v1/routines (Phase 2 step 3). The routines surface relies on
 * `RoutineSnapshotSchema` (via the apply pipeline's strict mode) for field-level validation, so
 * the tests here cover the route-layer concerns: scope gating, the writable-fields allowlist,
 * Zod failures surfacing as structured 400s, list/read, and idempotent delete. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1RoutinesRoutes } from '../routes/v1/routines.js';
import type { ApiTokenScope, RoutineInterface } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/v1', v1RoutinesRoutes);

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
        db.collection('routines').deleteMany({}),
        db.collection('items').deleteMany({}),
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

interface PublicRoutine {
    _id: string;
    title: string;
    routineType: 'nextAction' | 'calendar';
    rrule: string;
    template: { notes?: string };
    active: boolean;
    createdTs: string;
    updatedTs: string;
}

const validBody = {
    title: 'Daily review',
    routineType: 'nextAction' as const,
    rrule: 'FREQ=DAILY',
    template: { notes: 'Review inbox and next-actions' },
    active: true,
};

describe('POST /v1/routines', () => {
    it('creates a routine, persists the snapshot, and writes a create op', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(validBody),
            }),
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as PublicRoutine;
        expect(body.title).toBe('Daily review');
        expect(body.routineType).toBe('nextAction');
        const stored = await routinesDAO.findByOwnerAndId(body._id, userId);
        expect(stored?.title).toBe('Daily review');
        const ops = await operationsDAO.findArray({ entityId: body._id });
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('create');
    });

    it('rejects caller-supplied _id with forbidden_field', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...validBody, _id: 'spoofed' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('forbidden_field');
    });

    it('rejects an invalid rrule via Zod (invalid_operation)', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...validBody, rrule: '' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_operation');
    });

    it('returns 403 for routines.read-only token', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.read']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(validBody),
            }),
        );
        expect(res.status).toBe(403);
    });
});

describe('GET /v1/routines', () => {
    it('lists the caller routines, paginates with cursor', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.read']);
        for (let i = 0; i < 3; i++) {
            await routinesDAO.insertOne({
                _id: `r-${i}`,
                user: userId,
                title: `R${i}`,
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
                createdTs: `2026-01-0${i + 1}T00:00:00.000Z`,
                updatedTs: `2026-01-0${i + 1}T00:00:00.000Z`,
            });
        }
        const first = await app.fetch(new Request('http://localhost:4000/v1/routines?limit=2', { headers: { Authorization: `Bearer ${token}` } }));
        const firstBody = (await first.json()) as { routines: Array<{ _id: string }>; nextCursor?: string };
        expect(firstBody.routines).toHaveLength(2);
        expect(firstBody.nextCursor).toBeTruthy();
        const second = await app.fetch(
            new Request(`http://localhost:4000/v1/routines?limit=2&cursor=${firstBody.nextCursor!}`, { headers: { Authorization: `Bearer ${token}` } }),
        );
        const secondBody = (await second.json()) as { routines: Array<{ _id: string }> };
        expect(secondBody.routines).toHaveLength(1);
    });

    it("does not leak other users' routines", async () => {
        const aliceId = await login();
        const aliceToken = await tokenWith(aliceId, ['routines.read']);
        await routinesDAO.insertOne({
            _id: 'r-alice',
            user: aliceId,
            title: 'A',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        await routinesDAO.insertOne({
            _id: 'r-bob',
            user: 'bob-user-id',
            title: 'B',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(new Request('http://localhost:4000/v1/routines', { headers: { Authorization: `Bearer ${aliceToken}` } }));
        const body = (await res.json()) as { routines: Array<{ _id: string }> };
        expect(body.routines.map((r) => r._id)).toEqual(['r-alice']);
    });
});

describe('PATCH /v1/routines/:id', () => {
    it('updates allowlisted fields and re-validates the merged snapshot', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        await routinesDAO.insertOne({
            _id: 'r-1',
            user: userId,
            title: 'old',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/r-1', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'new', active: false }),
            }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as PublicRoutine;
        expect(body.title).toBe('new');
        expect(body.active).toBe(false);
        const stored = await routinesDAO.findByOwnerAndId('r-1', userId);
        expect(stored?.title).toBe('new');
        expect(stored?.active).toBe(false);
    });

    it('Zod validation: rejects PATCH that produces an invalid rrule', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        await routinesDAO.insertOne({
            _id: 'r-1',
            user: userId,
            title: 't',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/r-1', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ rrule: '' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_operation');
    });

    it('rejects forbidden_field for caller-supplied user', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        await routinesDAO.insertOne({
            _id: 'r-1',
            user: userId,
            title: 't',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/r-1', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: 'attacker' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('forbidden_field');
    });

    it('returns 404 for missing id', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/nope', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'x' }),
            }),
        );
        expect(res.status).toBe(404);
    });
});

// GET /v1/routines/:id is straightforward but worth pinning so a future router refactor can't
// drop it without a test failure.
describe('GET /v1/routines/:id', () => {
    it('returns the row', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.read']);
        await routinesDAO.insertOne({
            _id: 'r-1',
            user: userId,
            title: 'rd',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(new Request('http://localhost:4000/v1/routines/r-1', { headers: { Authorization: `Bearer ${token}` } }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as PublicRoutine & { user?: string };
        expect(body.title).toBe('rd');
        // Public projection must not leak `user` (matches presentPerson / presentWorkContext).
        expect(body.user).toBeUndefined();
    });

    it('returns 404 when missing', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.read']);
        const res = await app.fetch(new Request('http://localhost:4000/v1/routines/nope', { headers: { Authorization: `Bearer ${token}` } }));
        expect(res.status).toBe(404);
    });
});

// Locks in the writable-fields allowlist: server-managed routine state (sync anchors, exception
// list, split-history backref) and deprecated fields must surface as `forbidden_field` rather
// than silently flowing through to Zod (which is structural and would accept them) or worse,
// being persisted. If `WRITABLE_FIELDS` ever drifts to include any of these, this test fails.
describe('writable-fields allowlist', () => {
    it.each([
        ['splitFromRoutineId', 'r-other'],
        ['lastGeneratedDate', '2026-04-01'],
        ['lastPushedToGCalTs', '2026-04-01T00:00:00.000Z'],
        ['lastSyncedNotes', 'tampered'],
        ['triggerMode', 'fixedSchedule'],
        ['afterCompletionDelayDays', 3],
        ['routineExceptions', [{ date: '2026-04-01', type: 'skipped' }]],
    ])('PATCH rejects server-managed/deprecated field "%s" with forbidden_field', async (field, value) => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        await routinesDAO.insertOne({
            _id: 'r-1',
            user: userId,
            title: 't',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/r-1', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field]: value }),
            }),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe('forbidden_field');
        expect(body.error).toContain(field);
    });
});

// Tenant-isolation regression — see workContexts test for why these are pinned.
describe('routines tenant isolation', () => {
    it("PATCH targeting another user's row returns 404 and does not modify it", async () => {
        const aliceId = await login();
        const aliceToken = await tokenWith(aliceId, ['routines.write']);
        await routinesDAO.insertOne({
            _id: 'r-bob',
            user: 'bob-user-id',
            title: 'B',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/r-bob', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'pwned' }),
            }),
        );
        expect(res.status).toBe(404);
        const stored = await routinesDAO.findByOwnerAndId('r-bob', 'bob-user-id');
        expect(stored?.title).toBe('B');
        const ops = await operationsDAO.findArray({ entityId: 'r-bob' });
        expect(ops).toHaveLength(0);
    });

    it("DELETE targeting another user's row returns 200 alreadyDeleted (the row remains)", async () => {
        const aliceId = await login();
        const aliceToken = await tokenWith(aliceId, ['routines.write']);
        await routinesDAO.insertOne({
            _id: 'r-bob',
            user: 'bob-user-id',
            title: 'B',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/r-bob', { method: 'DELETE', headers: { Authorization: `Bearer ${aliceToken}` } }),
        );
        expect(res.status).toBe(200);
        const stored = await routinesDAO.findByOwnerAndId('r-bob', 'bob-user-id');
        expect(stored?.title).toBe('B');
        // Critically: no delete op should be logged for Bob's tenant either.
        const ops = await operationsDAO.findArray({ entityId: 'r-bob' });
        expect(ops).toHaveLength(0);
    });
});

describe('DELETE /v1/routines/:id', () => {
    it('deletes and is idempotent; the apply pipeline hydrates the pre-delete snapshot', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const seed: RoutineInterface = {
            _id: 'r-1',
            user: userId,
            title: 'gone',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        };
        await routinesDAO.insertOne(seed);
        const r1 = await app.fetch(new Request('http://localhost:4000/v1/routines/r-1', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }));
        expect(r1.status).toBe(200);
        const stored = await routinesDAO.findByOwnerAndId('r-1', userId);
        expect(stored).toBeNull();
        const ops = await operationsDAO.findArray({ entityId: 'r-1', opType: 'delete' });
        expect(ops).toHaveLength(1);
        // Hydration: the op log carries the pre-delete snapshot so other devices can apply the
        // delete without an extra GET. (Routine deletes ship with snapshot=null from clients.)
        const op = ops[0];
        if (!op) {
            throw new Error('expected one delete op');
        }
        expect(op.snapshot).toMatchObject({ _id: 'r-1', title: 'gone' });

        // Second DELETE returns 200 with alreadyDeleted=true.
        const r2 = await app.fetch(new Request('http://localhost:4000/v1/routines/r-1', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }));
        expect(r2.status).toBe(200);
        const body = (await r2.json()) as { alreadyDeleted: boolean };
        expect(body.alreadyDeleted).toBe(true);
    });
});
