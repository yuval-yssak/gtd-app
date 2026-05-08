/** GET /v1/people and GET /v1/work-contexts (issue #19 step 9). */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1PeopleRoutes } from '../routes/v1/people.js';
import { v1WorkContextsRoutes } from '../routes/v1/workContexts.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/v1', v1PeopleRoutes)
    .route('/v1', v1WorkContextsRoutes);

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
        db.collection('workContexts').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

async function userWithToken(provider: 'google' | 'github' = 'google', overrides: Record<string, unknown> = {}): Promise<{ userId: string; token: string }> {
    const { sessionCookie } = await oauthLogin(app, provider, overrides);
    const sessionRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    const { plaintext } = await issueApiToken(user.id, 'refs', ['people.read', 'contexts.read']);
    return { userId: user.id, token: plaintext };
}

async function get(path: string, token: string): Promise<Response> {
    return app.fetch(new Request(`http://localhost:4000${path}`, { headers: { Authorization: `Bearer ${token}` } }));
}

describe('GET /v1/people', () => {
    it("returns the caller's people, sorted by updatedTs DESC", async () => {
        const { userId, token } = await userWithToken();
        await peopleDAO.insertOne({
            _id: 'p1',
            user: userId,
            name: 'Alice',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        await peopleDAO.insertOne({
            _id: 'p2',
            user: userId,
            name: 'Bob',
            email: 'bob@example.com',
            createdTs: '2026-02-01T00:00:00.000Z',
            updatedTs: '2026-03-01T00:00:00.000Z',
        });
        const res = await get('/v1/people', token);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { people: Array<{ _id: string; name: string; email?: string }> };
        expect(body.people.map((p) => p._id)).toEqual(['p2', 'p1']);
        expect(body.people[0]!.email).toBe('bob@example.com');
    });

    it("does not leak other users' people", async () => {
        const { userId: aliceId, token: aliceToken } = await userWithToken('google');
        await peopleDAO.insertOne({
            _id: 'p-alice',
            user: aliceId,
            name: 'Alice',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const { userId: bobId } = await userWithToken('github', { email: 'bob@example.com', login: 'bob-gh' });
        await peopleDAO.insertOne({
            _id: 'p-bob',
            user: bobId,
            name: 'Bob',
            createdTs: '2026-02-01T00:00:00.000Z',
            updatedTs: '2026-02-01T00:00:00.000Z',
        });
        const res = await get('/v1/people', aliceToken);
        const body = (await res.json()) as { people: Array<{ _id: string }> };
        expect(body.people.map((p) => p._id)).toEqual(['p-alice']);
    });

    it('paginates: returns nextCursor while more rows remain', async () => {
        const { userId, token } = await userWithToken();
        for (let i = 0; i < 5; i++) {
            await peopleDAO.insertOne({
                _id: `p${i}`,
                user: userId,
                name: `Person ${i}`,
                createdTs: `2026-01-0${i + 1}T00:00:00.000Z`,
                updatedTs: `2026-01-0${i + 1}T00:00:00.000Z`,
            });
        }
        const first = await get('/v1/people?limit=2', token);
        const firstBody = (await first.json()) as { people: Array<{ _id: string }>; nextCursor?: string };
        expect(firstBody.people).toHaveLength(2);
        expect(firstBody.nextCursor).toBeTruthy();
        const second = await get(`/v1/people?limit=2&cursor=${firstBody.nextCursor!}`, token);
        const secondBody = (await second.json()) as { people: Array<{ _id: string }>; nextCursor?: string };
        expect(secondBody.people).toHaveLength(2);
        expect(firstBody.people[0]!._id).not.toBe(secondBody.people[0]!._id);
    });

    it('rejects invalid limits with 400', async () => {
        const { token } = await userWithToken();
        const res = await get('/v1/people?limit=10000', token);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_limit');
    });

    it('returns 403 when token lacks people.read scope', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const sessionRes = await app.fetch(
            new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }),
        );
        const { user } = (await sessionRes.json()) as { user: { id: string } };
        const { plaintext } = await issueApiToken(user.id, 'capture-only', ['items.capture']);
        const res = await get('/v1/people', plaintext);
        expect(res.status).toBe(403);
    });
});

describe('GET /v1/work-contexts', () => {
    it("returns the caller's work contexts", async () => {
        const { userId, token } = await userWithToken();
        await workContextsDAO.insertOne({
            _id: 'wc1',
            user: userId,
            name: 'near a phone',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        await workContextsDAO.insertOne({
            _id: 'wc2',
            user: userId,
            name: 'at the laptop',
            createdTs: '2026-02-01T00:00:00.000Z',
            updatedTs: '2026-02-01T00:00:00.000Z',
        });
        const res = await get('/v1/work-contexts', token);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { workContexts: Array<{ _id: string; name: string }> };
        expect(body.workContexts.map((wc) => wc.name).sort()).toEqual(['at the laptop', 'near a phone']);
    });

    it('does not leak the user field', async () => {
        const { userId, token } = await userWithToken();
        await workContextsDAO.insertOne({
            _id: 'wc1',
            user: userId,
            name: 'shy',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await get('/v1/work-contexts', token);
        const body = (await res.json()) as { workContexts: Array<Record<string, unknown>> };
        expect(body.workContexts[0]).not.toHaveProperty('user');
    });
});
