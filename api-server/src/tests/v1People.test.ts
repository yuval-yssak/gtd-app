/** Public-API CRUD for /v1/people (Phase 2 step 3). Asserts: scope gating, body validation
 * (incl. forbidden_field detection on PATCH), apply-pipeline integration, and idempotent delete.
 * Read-side pagination + tenant isolation lives in `v1References.test.ts`. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1PeopleRoutes } from '../routes/v1/people.js';
import type { ApiTokenScope } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/v1', v1PeopleRoutes);

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
        db.collection('people').deleteMany({}),
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

interface PublicPerson {
    _id: string;
    name: string;
    email?: string;
    phone?: string;
    notes?: string;
}

describe('POST /v1/people', () => {
    it('creates a person with optional fields and writes a create op', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['people.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/people', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Alice', email: 'alice@example.com', notes: 'team lead' }),
            }),
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as PublicPerson;
        expect(body.name).toBe('Alice');
        expect(body.email).toBe('alice@example.com');
        expect(body.notes).toBe('team lead');
        const stored = await peopleDAO.findByOwnerAndId(body._id, userId);
        expect(stored?.name).toBe('Alice');
        const ops = await operationsDAO.findArray({ entityId: body._id });
        expect(ops).toHaveLength(1);
        expect(ops[0]?.opType).toBe('create');
    });

    it('rejects missing name', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['people.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/people', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'a@b.com' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_name');
    });

    it('returns 403 for read-only token', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['people.read']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/people', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'A' }),
            }),
        );
        expect(res.status).toBe(403);
    });
});

describe('GET /v1/people/:id', () => {
    it('returns the row', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['people.read']);
        await peopleDAO.insertOne({ _id: 'p-1', user: userId, name: 'Bob', createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z' });
        const res = await app.fetch(new Request('http://localhost:4000/v1/people/p-1', { headers: { Authorization: `Bearer ${token}` } }));
        expect(res.status).toBe(200);
        expect(((await res.json()) as PublicPerson).name).toBe('Bob');
    });

    it('returns 404 when missing', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['people.read']);
        const res = await app.fetch(new Request('http://localhost:4000/v1/people/nope', { headers: { Authorization: `Bearer ${token}` } }));
        expect(res.status).toBe(404);
    });
});

describe('PATCH /v1/people/:id', () => {
    it('updates allowlisted fields and preserves the rest', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['people.write']);
        await peopleDAO.insertOne({
            _id: 'p-1',
            user: userId,
            name: 'Alice',
            email: 'old@x.com',
            phone: '555-1234',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/people/p-1', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'new@x.com' }),
            }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as PublicPerson;
        expect(body.email).toBe('new@x.com');
        expect(body.name).toBe('Alice'); // untouched
        expect(body.phone).toBe('555-1234'); // untouched
    });

    it('rejects forbidden_field on caller-supplied user', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['people.write']);
        await peopleDAO.insertOne({ _id: 'p-1', user: userId, name: 'A', createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z' });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/people/p-1', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: 'someone-else' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('forbidden_field');
    });

    it('rejects empty body', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['people.write']);
        await peopleDAO.insertOne({ _id: 'p-1', user: userId, name: 'A', createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z' });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/people/p-1', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('empty_body');
    });
});

describe('DELETE /v1/people/:id', () => {
    it('deletes and is idempotent', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['people.write']);
        await peopleDAO.insertOne({ _id: 'p-1', user: userId, name: 'A', createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z' });
        const r1 = await app.fetch(new Request('http://localhost:4000/v1/people/p-1', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }));
        expect(r1.status).toBe(200);
        const r2 = await app.fetch(new Request('http://localhost:4000/v1/people/p-1', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }));
        expect(r2.status).toBe(200);
        const body = (await r2.json()) as { alreadyDeleted: boolean };
        expect(body.alreadyDeleted).toBe(true);
    });
});

// Validation regression: optional string fields each get their own invalid_<field> code so that
// e.g. an integration with a mistyped phone field gets a helpful error rather than a generic 400.
describe('POST /v1/people validation', () => {
    it('rejects non-string email', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['people.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/people', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'A', email: 42 }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_email');
    });

    it('rejects empty externalCalendarId (string but blank)', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['people.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/people', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'A', externalCalendarId: '   ' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_externalCalendarId');
    });

    it('rejects forbidden_field on POST (caller-supplied user)', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['people.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/people', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'A', user: 'attacker' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('forbidden_field');
    });
});

// Tenant-isolation regression — see workContexts test for why these are pinned.
describe('tenant isolation', () => {
    it("PATCH targeting another user's row returns 404 and does not modify it", async () => {
        const aliceId = await login();
        const aliceToken = await tokenWith(aliceId, ['people.write']);
        await peopleDAO.insertOne({
            _id: 'p-bob',
            user: 'bob-user-id',
            name: 'Bob',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/people/p-bob', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'pwned' }),
            }),
        );
        expect(res.status).toBe(404);
        const stored = await peopleDAO.findByOwnerAndId('p-bob', 'bob-user-id');
        expect(stored?.name).toBe('Bob');
        const ops = await operationsDAO.findArray({ entityId: 'p-bob' });
        expect(ops).toHaveLength(0);
    });

    it("DELETE targeting another user's row returns 200 alreadyDeleted (the row remains)", async () => {
        const aliceId = await login();
        const aliceToken = await tokenWith(aliceId, ['people.write']);
        await peopleDAO.insertOne({
            _id: 'p-bob',
            user: 'bob-user-id',
            name: 'Bob',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/people/p-bob', { method: 'DELETE', headers: { Authorization: `Bearer ${aliceToken}` } }),
        );
        expect(res.status).toBe(200);
        const stored = await peopleDAO.findByOwnerAndId('p-bob', 'bob-user-id');
        expect(stored?.name).toBe('Bob');
        // Critically: no delete op should be logged for Bob's tenant either.
        const ops = await operationsDAO.findArray({ entityId: 'p-bob' });
        expect(ops).toHaveLength(0);
    });
});
