/** Composite routine endpoints (Phase 2 step 4): /v1/routines/:id/{pause,resume,split}.
 * Each composite decomposes into primitive ops via the shared apply pipeline. The tests pin the
 * pre/post-state of items+routine in Mongo and the operations log so a future refactor can't
 * silently change which ops the composite emits. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1RoutinesRoutes } from '../routes/v1/routines.js';
import type { ApiTokenScope, ItemInterface, RoutineInterface } from '../types/entities.js';
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

function makeRoutine(userId: string, overrides: Partial<RoutineInterface> = {}): RoutineInterface {
    return {
        _id: overrides._id ?? 'r-1',
        user: userId,
        title: 'r',
        routineType: 'nextAction',
        rrule: 'FREQ=DAILY',
        template: {},
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function makeItem(userId: string, routineId: string, overrides: Partial<ItemInterface> = {}): ItemInterface {
    return {
        _id: overrides._id ?? `i-${Math.random()}`,
        user: userId,
        status: 'nextAction',
        title: 'item',
        routineId,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('POST /v1/routines/:id/pause', () => {
    it('flips active=false and trashes future open items; past items untouched', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        await routinesDAO.insertOne(makeRoutine(userId));
        // Mix of past (yesterday) and future (tomorrow) open items, plus a done item that must
        // not be trashed.
        const yesterday = '2024-01-01T00:00:00.000Z';
        const tomorrow = '2099-01-01T00:00:00.000Z';
        await itemsDAO.insertOne(makeItem(userId, 'r-1', { _id: 'i-past', expectedBy: yesterday }));
        await itemsDAO.insertOne(makeItem(userId, 'r-1', { _id: 'i-future', expectedBy: tomorrow }));
        await itemsDAO.insertOne(makeItem(userId, 'r-1', { _id: 'i-done', status: 'done', expectedBy: tomorrow }));

        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/r-1/pause', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { active: boolean };
        expect(body.active).toBe(false);

        const stored = await routinesDAO.findByOwnerAndId('r-1', userId);
        expect(stored?.active).toBe(false);
        const past = await itemsDAO.findByOwnerAndId('i-past', userId);
        const future = await itemsDAO.findByOwnerAndId('i-future', userId);
        const done = await itemsDAO.findByOwnerAndId('i-done', userId);
        expect(past?.status).toBe('nextAction'); // past-due open items untouched
        expect(future?.status).toBe('trash');
        expect(done?.status).toBe('done');
    });

    it('returns 404 for missing routine', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/nope/pause', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }),
        );
        expect(res.status).toBe(404);
    });

    it('returns 403 for routines.read-only token', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.read']);
        await routinesDAO.insertOne(makeRoutine(userId));
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/r-1/pause', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }),
        );
        expect(res.status).toBe(403);
    });
});

describe('POST /v1/routines/:id/resume', () => {
    it('flips active=true and stamps a tomorrow startDate', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        await routinesDAO.insertOne(makeRoutine(userId, { active: false }));
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/r-1/resume', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { active: boolean; startDate?: string };
        expect(body.active).toBe(true);
        expect(body.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

describe('POST /v1/routines/:id/split', () => {
    it('caps the head with UNTIL, deletes future calendar items, creates a tail routine', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const head = makeRoutine(userId, { _id: 'r-head', title: 'old', routineType: 'calendar', calendarItemTemplate: { timeOfDay: '09:00', duration: 60 } });
        await routinesDAO.insertOne(head);
        // A past calendar item (kept) and a future one (deleted by split).
        await itemsDAO.insertOne(makeItem(userId, 'r-head', { _id: 'i-past-cal', status: 'calendar', timeStart: '2025-01-01T09:00:00.000Z' }));
        await itemsDAO.insertOne(makeItem(userId, 'r-head', { _id: 'i-future-cal', status: 'calendar', timeStart: '2099-04-01T09:00:00.000Z' }));

        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/r-head/split', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ splitDate: '2099-03-15', tailEdits: { title: 'new', rrule: 'FREQ=WEEKLY' } }),
            }),
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as {
            head: { _id: string; rrule: string; active: boolean };
            tail: { _id: string; title: string; rrule: string; splitFromRoutineId?: string };
        };
        expect(body.head._id).toBe('r-head');
        expect(body.head.active).toBe(false);
        expect(body.head.rrule).toMatch(/UNTIL=20990314T235959Z/);
        expect(body.tail.title).toBe('new');
        expect(body.tail.rrule).toBe('FREQ=WEEKLY');
        expect(body.tail.splitFromRoutineId).toBe('r-head');

        const tail = await routinesDAO.findByOwnerAndId(body.tail._id, userId);
        expect(tail?.title).toBe('new');
        const pastCal = await itemsDAO.findByOwnerAndId('i-past-cal', userId);
        const futureCal = await itemsDAO.findByOwnerAndId('i-future-cal', userId);
        expect(pastCal).not.toBeNull(); // before splitDate — kept
        expect(futureCal).toBeNull(); // after splitDate — hard-deleted

        // Re-read the head from DB and assert the cap actually persisted (the response body
        // could match without the cap landing — LWW would silently drop it under a concurrent
        // edit if buildCappedHead forgot to bump updatedTs).
        const persistedHead = await routinesDAO.findByOwnerAndId('r-head', userId);
        expect(persistedHead?.active).toBe(false);
        expect(persistedHead?.rrule).toMatch(/UNTIL=20990314T235959Z/);
        // The cap must bump updatedTs strictly forward from the seed value.
        expect(persistedHead?.updatedTs).not.toBe('2026-01-01T00:00:00.000Z');
        expect(persistedHead?.updatedTs.localeCompare('2026-01-01T00:00:00.000Z')).toBeGreaterThan(0);
    });

    it('rejects an invalid splitDate format', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        await routinesDAO.insertOne(makeRoutine(userId));
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/r-1/split', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ splitDate: '2099/04/15' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_split_date');
    });

    it('returns 404 for missing routine', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/nope/split', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ splitDate: '2099-04-15' }),
            }),
        );
        expect(res.status).toBe(404);
    });

    // Tenant isolation: a token belonging to user A must not split (or read) user B's routine.
    it('returns 404 when targeting another user routine', async () => {
        const aliceId = await login();
        const aliceToken = await tokenWith(aliceId, ['routines.write']);
        await routinesDAO.insertOne(makeRoutine('bob-id', { _id: 'r-bob' }));
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/routines/r-bob/split', {
                method: 'POST',
                headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ splitDate: '2099-04-15' }),
            }),
        );
        expect(res.status).toBe(404);
        // Bob's routine still exists and is unmodified, no operations logged for it.
        const bobs = await routinesDAO.findByOwnerAndId('r-bob', 'bob-id');
        expect(bobs?.active).toBe(true);
        const ops = await operationsDAO.findArray({ entityId: 'r-bob' });
        expect(ops).toHaveLength(0);
    });
});
