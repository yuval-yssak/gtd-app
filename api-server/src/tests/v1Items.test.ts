/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ItemsRoutes } from '../routes/v1/items.js';
import type { ItemInterface } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/v1', v1ItemsRoutes);

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
        db.collection('items').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('apiTokens').deleteMany({}),
    ]);
    // Drop the in-process rate-limit counters so the limiter doesn't reject calls in tests
    // that share a token across many requests (e.g. cursor pagination).
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

// ─── Local helpers ──────────────────────────────────────────────────────────

// Google OAuth always returns the same `sub: g1` from the test mock, so a second Google login
// links to the same user. To exercise multi-user behaviour we route the second user through
// GitHub with a distinct email — same trick used by sync.test.ts's loginAsBob().
async function loginAlice(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    const res = await app.fetch(
        new Request('http://localhost:4000/auth/get-session', {
            headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
        }),
    );
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
}

async function loginBob(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'github', { email: 'bob@example.com', login: 'bob-gh' });
    const res = await app.fetch(
        new Request('http://localhost:4000/auth/get-session', {
            headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
        }),
    );
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
}

interface IssuedToken {
    plaintext: string;
    userId: string;
    tokenId: string;
}

async function newUserWithToken(who: 'alice' | 'bob' = 'alice', label = 'test'): Promise<IssuedToken> {
    const userId = who === 'alice' ? await loginAlice() : await loginBob();
    // Mint with the full scope set so the existing exhaustive endpoint coverage in this file
    // doesn't have to thread scopes through every callsite. Scope-specific behaviour is exercised
    // in `v1Clarify.test.ts`.
    const { plaintext, record } = await issueApiToken(userId, label, ['items.capture', 'items.read', 'items.clarify']);
    return { plaintext, userId, tokenId: record._id };
}

interface ApiCallOptions {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    token?: string;
    body?: unknown;
}

async function callApi({ method, path, token, body }: ApiCallOptions): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return app.fetch(
        new Request(`http://localhost:4000${path}`, {
            method,
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
    );
}

// ─── Auth ───────────────────────────────────────────────────────────────────

describe('v1 bearer auth', () => {
    it('returns 401 when Authorization header is missing', async () => {
        const res = await callApi({ method: 'GET', path: '/v1/items' });
        expect(res.status).toBe(401);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('unauthorized');
    });

    it('returns 401 for malformed Bearer values', async () => {
        const res = await callApi({ method: 'GET', path: '/v1/items', token: 'not-a-real-token' });
        expect(res.status).toBe(401);
    });

    it('returns 401 for revoked tokens', async () => {
        const { plaintext, tokenId } = await newUserWithToken();
        await db.collection('apiTokens').updateOne({ _id: tokenId }, { $set: { revokedTs: dayjs().toISOString() } } as never);
        const res = await callApi({ method: 'GET', path: '/v1/items', token: plaintext });
        expect(res.status).toBe(401);
    });

    it('rejects tokens that do not start with the gtd_ prefix even when they hash to a stored row', async () => {
        // Defensive: even if someone managed to provision a record with a non-prefixed plaintext,
        // the resolver short-circuits on the prefix check before hashing/lookup.
        const res = await callApi({ method: 'GET', path: '/v1/items', token: 'wrong_prefix_xyz' });
        expect(res.status).toBe(401);
    });

    it('rejects Authorization headers that do not use the Bearer scheme', async () => {
        const { plaintext } = await newUserWithToken();
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/items', {
                method: 'GET',
                headers: { Authorization: `Basic ${plaintext}` },
            }),
        );
        expect(res.status).toBe(401);
    });

    it('bumps lastUsedTs on a successful authenticated call (best-effort)', async () => {
        const { plaintext, tokenId } = await newUserWithToken();
        const before = await db.collection('apiTokens').findOne({ _id: tokenId } as never);
        expect(before?.lastUsedTs).toBeUndefined();
        const res = await callApi({ method: 'GET', path: '/v1/items', token: plaintext });
        expect(res.status).toBe(200);
        // Fire-and-forget; poll briefly to avoid flakes if the update hasn't landed yet.
        for (let i = 0; i < 20; i++) {
            const after = await db.collection('apiTokens').findOne({ _id: tokenId } as never);
            if (after?.lastUsedTs) return;
            await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('lastUsedTs was never bumped');
    });
});

// ─── POST /v1/items ─────────────────────────────────────────────────────────

describe('POST /v1/items', () => {
    it('creates an inbox item with title only', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const res = await callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: 'Buy milk' } });
        expect(res.status).toBe(201);
        const body = (await res.json()) as ItemInterface;
        expect(body.status).toBe('inbox');
        expect(body.title).toBe('Buy milk');
        expect(body.user).toBe(userId);
        // contentHash is internal — must not leak in API responses.
        expect((body as unknown as { contentHash?: string }).contentHash).toBeUndefined();
        expect(await db.collection('items').countDocuments({ user: userId })).toBe(1);
        expect(await db.collection('operations').countDocuments({ user: userId, opType: 'create' })).toBe(1);
    });

    it('trims whitespace from title and stores the trimmed value', async () => {
        const { plaintext } = await newUserWithToken();
        const res = await callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: '   spaced out   ' } });
        const body = (await res.json()) as ItemInterface;
        expect(body.title).toBe('spaced out');
    });

    it('rejects empty/whitespace title with invalid_title', async () => {
        const { plaintext } = await newUserWithToken();
        for (const title of ['', '   ']) {
            const res = await callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title } });
            expect(res.status).toBe(400);
            const body = (await res.json()) as { code: string };
            expect(body.code).toBe('invalid_title');
        }
    });

    it('rejects non-string notes with invalid_notes', async () => {
        const { plaintext } = await newUserWithToken();
        const res = await callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: 'ok', notes: 42 } });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('invalid_notes');
    });

    it('rejects non-object request bodies with invalid_body', async () => {
        const { plaintext } = await newUserWithToken();
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/items', {
                method: 'POST',
                headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
                body: 'not-json-at-all',
            }),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('invalid_body');
    });

    it('externalId dedupe: second call with same externalId returns the original item with X-Idempotent-Replay', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const first = await callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: 'A', externalId: 'ext-1' } });
        expect(first.status).toBe(201);
        const firstBody = (await first.json()) as ItemInterface;

        // Different title, same externalId — externalId wins; the original is returned unchanged.
        const second = await callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: 'B', externalId: 'ext-1' } });
        expect(second.status).toBe(201);
        expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
        const secondBody = (await second.json()) as ItemInterface;
        expect(secondBody._id).toBe(firstBody._id);
        expect(secondBody.title).toBe('A');
        expect(await db.collection('items').countDocuments({ user: userId })).toBe(1);
    });

    it('content-hash dedupe: same title+notes within 24h returns the existing item', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const first = await callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: 'Call dentist', notes: 'morning preferred' } });
        const firstBody = (await first.json()) as ItemInterface;

        const second = await callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: 'Call dentist', notes: 'morning preferred' } });
        expect(second.status).toBe(201);
        expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
        const secondBody = (await second.json()) as ItemInterface;
        expect(secondBody._id).toBe(firstBody._id);
        expect(await db.collection('items').countDocuments({ user: userId })).toBe(1);
    });

    it('content-hash dedupe respects the 24h window: same content older than the cutoff creates a new item', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const first = await callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: 'Take medication' } });
        const firstBody = (await first.json()) as ItemInterface;
        // Backdate the row outside the dedupe window.
        await db.collection('items').updateOne({ _id: firstBody._id } as never, { $set: { createdTs: dayjs().subtract(25, 'hour').toISOString() } });

        const second = await callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: 'Take medication' } });
        expect(second.status).toBe(201);
        expect(second.headers.get('X-Idempotent-Replay')).toBeNull();
        expect(await db.collection('items').countDocuments({ user: userId })).toBe(2);
    });

    it('externalId uniqueness is scoped per user (two users can use the same key)', async () => {
        const a = await newUserWithToken('alice');
        const b = await newUserWithToken('bob');
        const r1 = await callApi({ method: 'POST', path: '/v1/items', token: a.plaintext, body: { title: 'Alice item', externalId: 'shared-key' } });
        const r2 = await callApi({ method: 'POST', path: '/v1/items', token: b.plaintext, body: { title: 'Bob item', externalId: 'shared-key' } });
        expect(r1.status).toBe(201);
        expect(r2.status).toBe(201);
        expect(await db.collection('items').countDocuments({ user: a.userId })).toBe(1);
        expect(await db.collection('items').countDocuments({ user: b.userId })).toBe(1);
    });

    it('records the op with deviceId="api:<tokenId>" so device-scoped sync continues to work', async () => {
        const { plaintext, userId, tokenId } = await newUserWithToken();
        await callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: 'deviceId tag test' } });
        const op = await db.collection<{ deviceId: string }>('operations').findOne({ user: userId } as never);
        expect(op?.deviceId).toBe(`api:${tokenId}`);
    });

    it('records the op snapshot matching the persisted item (round-tripable on other devices)', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const res = await callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: 'snap', notes: 'body' } });
        const created = (await res.json()) as ItemInterface;
        const op = await db.collection<{ snapshot: ItemInterface }>('operations').findOne({ user: userId, entityId: created._id } as never);
        expect(op?.snapshot).toMatchObject({ _id: created._id, status: 'inbox', title: 'snap', notes: 'body' });
    });

    it('externalId is strictly idempotent under concurrent posts (race-loser is recovered, not 500)', async () => {
        const { plaintext, userId } = await newUserWithToken();
        // Fire both posts in parallel — under the previous implementation one would 500 with E11000.
        const [r1, r2] = await Promise.all([
            callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: 'race-A', externalId: 'race-1' } }),
            callApi({ method: 'POST', path: '/v1/items', token: plaintext, body: { title: 'race-B', externalId: 'race-1' } }),
        ]);
        expect(r1.status).toBe(201);
        expect(r2.status).toBe(201);
        const b1 = (await r1.json()) as ItemInterface;
        const b2 = (await r2.json()) as ItemInterface;
        expect(b1._id).toBe(b2._id);
        // Exactly one row, exactly one create op.
        expect(await db.collection('items').countDocuments({ user: userId, externalId: 'race-1' })).toBe(1);
        expect(await db.collection('operations').countDocuments({ user: userId, opType: 'create' })).toBe(1);
    });
});

// ─── GET /v1/items ──────────────────────────────────────────────────────────

interface SeedItemOptions {
    userId: string;
    id?: string;
    title?: string;
    notes?: string;
    status?: ItemInterface['status'];
    updatedTs?: string;
    createdTs?: string;
}

async function seedItem({ userId, id, title = 't', notes, status = 'inbox', updatedTs, createdTs }: SeedItemOptions): Promise<ItemInterface> {
    const _id = id ?? crypto.randomUUID();
    const now = dayjs().toISOString();
    const item: ItemInterface = {
        _id,
        user: userId,
        status,
        title,
        createdTs: createdTs ?? now,
        updatedTs: updatedTs ?? now,
        ...(notes !== undefined ? { notes } : {}),
    };
    await db.collection('items').insertOne(item as never);
    return item;
}

describe('GET /v1/items', () => {
    it('returns items for the authenticated user, sorted by updatedTs DESC', async () => {
        const { plaintext, userId } = await newUserWithToken();
        await seedItem({ userId, title: 'oldest', updatedTs: '2024-01-01T00:00:00.000Z' });
        await seedItem({ userId, title: 'middle', updatedTs: '2024-06-01T00:00:00.000Z' });
        await seedItem({ userId, title: 'newest', updatedTs: '2024-12-01T00:00:00.000Z' });

        const res = await callApi({ method: 'GET', path: '/v1/items', token: plaintext });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: ItemInterface[] };
        expect(body.items.map((i) => i.title)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('does not return items belonging to other users', async () => {
        const a = await newUserWithToken('alice');
        const b = await newUserWithToken('bob');
        await seedItem({ userId: a.userId, title: 'alice item' });
        await seedItem({ userId: b.userId, title: 'bob item' });
        const res = await callApi({ method: 'GET', path: '/v1/items', token: a.plaintext });
        const body = (await res.json()) as { items: ItemInterface[] };
        expect(body.items).toHaveLength(1);
        expect(body.items[0]?.title).toBe('alice item');
    });

    it('excludes trash by default', async () => {
        const { plaintext, userId } = await newUserWithToken();
        await seedItem({ userId, title: 'kept', status: 'inbox' });
        await seedItem({ userId, title: 'gone', status: 'trash' });
        const res = await callApi({ method: 'GET', path: '/v1/items', token: plaintext });
        const body = (await res.json()) as { items: ItemInterface[] };
        expect(body.items.map((i) => i.title)).toEqual(['kept']);
    });

    it('filters by status (single)', async () => {
        const { plaintext, userId } = await newUserWithToken();
        await seedItem({ userId, title: 'a', status: 'inbox' });
        await seedItem({ userId, title: 'b', status: 'nextAction' });
        const res = await callApi({ method: 'GET', path: '/v1/items?status=nextAction', token: plaintext });
        const body = (await res.json()) as { items: ItemInterface[] };
        expect(body.items.map((i) => i.title)).toEqual(['b']);
    });

    it('filters by multiple statuses (comma-separated)', async () => {
        const { plaintext, userId } = await newUserWithToken();
        await seedItem({ userId, title: 'a', status: 'inbox' });
        await seedItem({ userId, title: 'b', status: 'nextAction' });
        await seedItem({ userId, title: 'c', status: 'done' });
        const res = await callApi({ method: 'GET', path: '/v1/items?status=inbox,nextAction', token: plaintext });
        const body = (await res.json()) as { items: ItemInterface[] };
        expect(body.items.map((i) => i.title).sort()).toEqual(['a', 'b']);
    });

    it('rejects unknown status values', async () => {
        const { plaintext } = await newUserWithToken();
        const res = await callApi({ method: 'GET', path: '/v1/items?status=bogus', token: plaintext });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('invalid_status');
    });

    it('searches by q against title and notes (case-insensitive)', async () => {
        const { plaintext, userId } = await newUserWithToken();
        await seedItem({ userId, title: 'Call DENTIST about appt' });
        await seedItem({ userId, title: 'Buy milk', notes: 'whole, not 2%' });
        await seedItem({ userId, title: 'Read book' });
        const res = await callApi({ method: 'GET', path: '/v1/items?q=milk', token: plaintext });
        const body = (await res.json()) as { items: ItemInterface[] };
        expect(body.items.map((i) => i.title)).toEqual(['Buy milk']);

        const res2 = await callApi({ method: 'GET', path: '/v1/items?q=DENTIST', token: plaintext });
        const body2 = (await res2.json()) as { items: ItemInterface[] };
        expect(body2.items.map((i) => i.title)).toEqual(['Call DENTIST about appt']);
    });

    it('treats q as a literal substring (regex metacharacters do not match)', async () => {
        const { plaintext, userId } = await newUserWithToken();
        await seedItem({ userId, title: 'a.b' });
        await seedItem({ userId, title: 'aXb' });
        // If q were unescaped, "a.b" would also match "aXb" via the regex dot.
        const res = await callApi({ method: 'GET', path: '/v1/items?q=a.b', token: plaintext });
        const body = (await res.json()) as { items: ItemInterface[] };
        expect(body.items.map((i) => i.title)).toEqual(['a.b']);
    });

    it('paginates via cursor and returns nextCursor while more pages remain', async () => {
        const { plaintext, userId } = await newUserWithToken();
        // Insert 5 items at distinct timestamps so ordering is deterministic.
        for (let i = 0; i < 5; i++) {
            await seedItem({ userId, title: `t${i}`, updatedTs: dayjs('2024-01-01T00:00:00.000Z').add(i, 'minute').toISOString() });
        }
        const first = await callApi({ method: 'GET', path: '/v1/items?limit=2', token: plaintext });
        const firstBody = (await first.json()) as { items: ItemInterface[]; nextCursor?: string };
        expect(firstBody.items.map((i) => i.title)).toEqual(['t4', 't3']);
        expect(firstBody.nextCursor).toBeDefined();

        const second = await callApi({ method: 'GET', path: `/v1/items?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, token: plaintext });
        const secondBody = (await second.json()) as { items: ItemInterface[]; nextCursor?: string };
        expect(secondBody.items.map((i) => i.title)).toEqual(['t2', 't1']);
        expect(secondBody.nextCursor).toBeDefined();

        const third = await callApi({ method: 'GET', path: `/v1/items?limit=2&cursor=${encodeURIComponent(secondBody.nextCursor!)}`, token: plaintext });
        const thirdBody = (await third.json()) as { items: ItemInterface[]; nextCursor?: string };
        expect(thirdBody.items.map((i) => i.title)).toEqual(['t0']);
        expect(thirdBody.nextCursor).toBeUndefined();
    });

    it('rejects malformed cursors with invalid_cursor', async () => {
        const { plaintext } = await newUserWithToken();
        const res = await callApi({ method: 'GET', path: '/v1/items?cursor=not-base64url', token: plaintext });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('invalid_cursor');
    });

    it('rejects out-of-range limit values', async () => {
        const { plaintext } = await newUserWithToken();
        for (const limit of ['0', '-1', '201', 'abc']) {
            const res = await callApi({ method: 'GET', path: `/v1/items?limit=${limit}`, token: plaintext });
            expect(res.status).toBe(400);
            const body = (await res.json()) as { code: string };
            expect(body.code).toBe('invalid_limit');
        }
    });

    it('respects the since filter (returns only updates strictly after the cutoff)', async () => {
        const { plaintext, userId } = await newUserWithToken();
        await seedItem({ userId, title: 'old', updatedTs: '2024-01-01T00:00:00.000Z' });
        await seedItem({ userId, title: 'new', updatedTs: '2024-12-01T00:00:00.000Z' });
        const res = await callApi({ method: 'GET', path: '/v1/items?since=2024-06-01T00:00:00.000Z', token: plaintext });
        const body = (await res.json()) as { items: ItemInterface[] };
        expect(body.items.map((i) => i.title)).toEqual(['new']);
    });

    it('since uses strict-greater, not greater-or-equal: an item updated exactly at the cutoff is excluded', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const cutoff = '2024-06-01T00:00:00.000Z';
        await seedItem({ userId, title: 'at-cutoff', updatedTs: cutoff });
        await seedItem({ userId, title: 'after', updatedTs: '2024-06-01T00:00:00.001Z' });
        const res = await callApi({ method: 'GET', path: `/v1/items?since=${cutoff}`, token: plaintext });
        const body = (await res.json()) as { items: ItemInterface[] };
        expect(body.items.map((i) => i.title)).toEqual(['after']);
    });

    it('combines q with cursor pagination correctly (search results paginate stably)', async () => {
        const { plaintext, userId } = await newUserWithToken();
        for (let i = 0; i < 4; i++) {
            await seedItem({ userId, title: `dentist appt ${i}`, updatedTs: dayjs('2024-01-01T00:00:00.000Z').add(i, 'minute').toISOString() });
        }
        await seedItem({ userId, title: 'unrelated' });
        const first = await callApi({ method: 'GET', path: '/v1/items?q=dentist&limit=2', token: plaintext });
        const firstBody = (await first.json()) as { items: ItemInterface[]; nextCursor?: string };
        expect(firstBody.items).toHaveLength(2);
        expect(firstBody.items.every((i) => i.title.startsWith('dentist appt'))).toBe(true);
        expect(firstBody.nextCursor).toBeDefined();

        const second = await callApi({
            method: 'GET',
            path: `/v1/items?q=dentist&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
            token: plaintext,
        });
        const secondBody = (await second.json()) as { items: ItemInterface[]; nextCursor?: string };
        expect(secondBody.items).toHaveLength(2);
        expect(secondBody.items.every((i) => i.title.startsWith('dentist appt'))).toBe(true);
        expect(secondBody.nextCursor).toBeUndefined();
    });

    it('strips internal sync-anchor fields (lastPushedToGCalTs / lastSyncedFromGCalTs / lastSyncedNotes / contentHash) from list responses', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const item = await seedItem({ userId, title: 'leak check' });
        // Inject internal fields directly into the row to simulate the sync pipeline writing them.
        await db.collection('items').updateOne({ _id: item._id } as never, {
            $set: {
                contentHash: 'abc123',
                lastPushedToGCalTs: '2026-01-01T00:00:00.000Z',
                lastSyncedFromGCalTs: '2026-01-02T00:00:00.000Z',
                lastSyncedNotes: 'leaked notes',
            },
        });
        const res = await callApi({ method: 'GET', path: '/v1/items', token: plaintext });
        const body = (await res.json()) as { items: Record<string, unknown>[] };
        expect(body.items).toHaveLength(1);
        const presented = body.items[0]!;
        for (const internal of ['contentHash', 'lastPushedToGCalTs', 'lastSyncedFromGCalTs', 'lastSyncedNotes']) {
            expect(presented[internal]).toBeUndefined();
        }
        // Public fields stay.
        expect(presented.title).toBe('leak check');
    });

    it('surfaces documented GTD-specific fields on read (workContextIds, energy, expectedBy, etc.)', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const _id = crypto.randomUUID();
        const now = dayjs().toISOString();
        await db.collection('items').insertOne({
            _id,
            user: userId,
            status: 'nextAction',
            title: 'tagged task',
            createdTs: now,
            updatedTs: now,
            workContextIds: ['ctx-1', 'ctx-2'],
            peopleIds: ['p-1'],
            energy: 'high',
            time: 30,
            focus: true,
            urgent: false,
            expectedBy: '2026-06-01',
            ignoreBefore: '2026-05-15',
        } as never);
        const res = await callApi({ method: 'GET', path: `/v1/items/${_id}`, token: plaintext });
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.workContextIds).toEqual(['ctx-1', 'ctx-2']);
        expect(body.peopleIds).toEqual(['p-1']);
        expect(body.energy).toBe('high');
        expect(body.time).toBe(30);
        expect(body.focus).toBe(true);
        expect(body.urgent).toBe(false);
        expect(body.expectedBy).toBe('2026-06-01');
        expect(body.ignoreBefore).toBe('2026-05-15');
    });
});

// ─── GET /v1/items/:id ─────────────────────────────────────────────────────

describe('GET /v1/items/:id', () => {
    it('returns the item when it belongs to the caller', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const item = await seedItem({ userId, title: 'mine' });
        const res = await callApi({ method: 'GET', path: `/v1/items/${item._id}`, token: plaintext });
        expect(res.status).toBe(200);
        const body = (await res.json()) as ItemInterface;
        expect(body._id).toBe(item._id);
        expect(body.title).toBe('mine');
    });

    it('returns 404 (not 403) for items belonging to another user — does not leak existence', async () => {
        const a = await newUserWithToken('alice');
        const b = await newUserWithToken('bob');
        const bobItem = await seedItem({ userId: b.userId, title: 'bob' });
        const res = await callApi({ method: 'GET', path: `/v1/items/${bobItem._id}`, token: a.plaintext });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('not_found');
    });

    it('returns 404 for a non-existent id', async () => {
        const { plaintext } = await newUserWithToken();
        const res = await callApi({ method: 'GET', path: '/v1/items/00000000-0000-0000-0000-000000000000', token: plaintext });
        expect(res.status).toBe(404);
    });
});

// ─── POST /v1/items/:id/complete ───────────────────────────────────────────

describe('POST /v1/items/:id/complete', () => {
    it('transitions inbox → done and bumps updatedTs', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const item = await seedItem({ userId, title: 'do me', status: 'inbox', updatedTs: '2024-01-01T00:00:00.000Z' });
        const res = await callApi({ method: 'POST', path: `/v1/items/${item._id}/complete`, token: plaintext });
        expect(res.status).toBe(200);
        const body = (await res.json()) as ItemInterface;
        expect(body.status).toBe('done');
        expect(body.updatedTs > item.updatedTs).toBe(true);
        // Op should be recorded so other devices learn about the change on next sync pull.
        const op = await db.collection<{ opType: string; entityId: string }>('operations').findOne({ entityId: item._id } as never);
        expect(op?.opType).toBe('update');
    });

    it('completes nextAction items as well as inbox items', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const item = await seedItem({ userId, title: 'next', status: 'nextAction' });
        const res = await callApi({ method: 'POST', path: `/v1/items/${item._id}/complete`, token: plaintext });
        expect(res.status).toBe(200);
        const body = (await res.json()) as ItemInterface;
        expect(body.status).toBe('done');
    });

    it('is idempotent: completing an already-done item returns the unchanged item with X-Idempotent-Replay', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const item = await seedItem({ userId, title: 'already', status: 'done', updatedTs: '2024-01-01T00:00:00.000Z' });
        const res = await callApi({ method: 'POST', path: `/v1/items/${item._id}/complete`, token: plaintext });
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Idempotent-Replay')).toBe('true');
        const body = (await res.json()) as ItemInterface;
        expect(body.updatedTs).toBe('2024-01-01T00:00:00.000Z');
        // No new op should have been written.
        expect(await db.collection('operations').countDocuments({ entityId: item._id })).toBe(0);
    });

    it('rejects completion of trashed items with not_completable', async () => {
        const { plaintext, userId } = await newUserWithToken();
        const item = await seedItem({ userId, title: 'trashed', status: 'trash' });
        const res = await callApi({ method: 'POST', path: `/v1/items/${item._id}/complete`, token: plaintext });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('not_completable');
    });

    it('returns 404 for items that do not belong to the caller', async () => {
        const a = await newUserWithToken('alice');
        const b = await newUserWithToken('bob');
        const bobItem = await seedItem({ userId: b.userId, title: 'bob' });
        const res = await callApi({ method: 'POST', path: `/v1/items/${bobItem._id}/complete`, token: a.plaintext });
        expect(res.status).toBe(404);
        // bob's item is still inbox — alice's call must have done nothing.
        const after = await db.collection<{ status: string }>('items').findOne({ _id: bobItem._id } as never);
        expect(after?.status).toBe('inbox');
    });
});

// ── Phase 3: broadened PATCH surface ───────────────────────────────────────────────────────
//
// PATCH used to be clarify-only (inbox → nextAction/waitingFor/somedayMaybe with a tiny field
// allowlist). Phase 3 broadens it to the full status×field matrix: any allowed transition,
// any user-settable field. The Zod schemas + matrix in `schemas/operations/item.ts` are the
// single source of truth; the route layer just rejects non-writable keys and 404s on missing.
describe('PATCH /v1/items/:id (Phase 3 full-surface update)', () => {
    it('inbox → calendar with timeStart + timeEnd succeeds', async () => {
        const { userId, plaintext } = await newUserWithToken();
        const item = await seedItem({ userId, title: 'meeting' });
        const res = await callApi({
            method: 'PATCH',
            path: `/v1/items/${item._id}`,
            token: plaintext,
            body: { status: 'calendar', timeStart: '2099-04-01T10:00:00Z', timeEnd: '2099-04-01T11:00:00Z' },
        });
        expect(res.status).toBe(200);
        const stored = await itemsDAO.findByOwnerAndId(item._id ?? '', userId);
        expect(stored?.status).toBe('calendar');
        expect(stored?.timeStart).toBe('2099-04-01T10:00:00Z');
        expect(stored?.timeEnd).toBe('2099-04-01T11:00:00Z');
    });

    it('updates title in place (Phase 3 — title was previously read-only on PATCH)', async () => {
        const { userId, plaintext } = await newUserWithToken();
        const item = await seedItem({ userId, title: 'old' });
        const res = await callApi({ method: 'PATCH', path: `/v1/items/${item._id}`, token: plaintext, body: { title: 'new' } });
        expect(res.status).toBe(200);
        const stored = await itemsDAO.findByOwnerAndId(item._id ?? '', userId);
        expect(stored?.title).toBe('new');
    });

    it('rejects caller-supplied routineId with forbidden_field (server-managed)', async () => {
        const { userId, plaintext } = await newUserWithToken();
        const item = await seedItem({ userId, title: 't' });
        const res = await callApi({ method: 'PATCH', path: `/v1/items/${item._id}`, token: plaintext, body: { routineId: 'r-spoof' } });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('forbidden_field');
    });

    it('rejects caller-supplied user with forbidden_field', async () => {
        const { userId, plaintext } = await newUserWithToken();
        const item = await seedItem({ userId, title: 't' });
        const res = await callApi({ method: 'PATCH', path: `/v1/items/${item._id}`, token: plaintext, body: { user: 'attacker' } });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('forbidden_field');
    });

    it('rejects caller-supplied externalId / contentHash with forbidden_field (Phase-3 broadened keeps them server-only)', async () => {
        const { userId, plaintext } = await newUserWithToken();
        const item = await seedItem({ userId, title: 't' });
        const r1 = await callApi({ method: 'PATCH', path: `/v1/items/${item._id}`, token: plaintext, body: { externalId: 'spoof' } });
        expect(r1.status).toBe(400);
        expect(((await r1.json()) as { code: string }).code).toBe('forbidden_field');
        const r2 = await callApi({ method: 'PATCH', path: `/v1/items/${item._id}`, token: plaintext, body: { contentHash: 'spoof' } });
        expect(r2.status).toBe(400);
        expect(((await r2.json()) as { code: string }).code).toBe('forbidden_field');
    });

    // sanitizeStaleFields is the safety net for status transitions: stale fields from the
    // *existing row* get dropped; caller-supplied fields stay (so Zod surfaces matrix violations).
    it('inbox → nextAction strips a stale `timeStart` carried over from a previous calendar status', async () => {
        const { userId, plaintext } = await newUserWithToken();
        // Seed a row that has a stale timeStart but is in inbox status (simulating a row that
        // was once a calendar item but later moved back to inbox via /sync/push directly).
        const item = await seedItem({ userId, title: 't' });
        await db.collection('items').updateOne({ _id: item._id } as never, { $set: { timeStart: '2099-01-01T10:00:00Z' } });
        // PATCH to nextAction without specifying timeStart — sanitizer strips the stale field
        // so the merged snapshot satisfies the matrix (which forbids timeStart on nextAction).
        const res = await callApi({ method: 'PATCH', path: `/v1/items/${item._id}`, token: plaintext, body: { status: 'nextAction' } });
        expect(res.status).toBe(200);
        const stored = await itemsDAO.findByOwnerAndId(item._id ?? '', userId);
        expect(stored?.status).toBe('nextAction');
        expect(stored?.timeStart).toBeUndefined();
    });

    // The inverse of the previous test: caller explicitly supplies an incompatible field — the
    // sanitizer must NOT silently drop it; Zod must 400. Pins the policy comment in
    // `sanitizeStaleFields` ("caller-supplied fields stay") against a future regression where
    // someone "simplifies" the function back to the old silent-strip behavior.
    it('caller-supplied stale field surfaces status_field_violation rather than being silently stripped', async () => {
        const { userId, plaintext } = await newUserWithToken();
        const item = await seedItem({ userId, title: 't' });
        await db.collection('items').updateOne({ _id: item._id } as never, { $set: { timeStart: '2099-01-01T10:00:00Z' } });
        // Caller asks to move to nextAction AND re-supplies a fresh timeStart — the new value
        // is incompatible with nextAction; we expect a 400, not a silent drop.
        const res = await callApi({
            method: 'PATCH',
            path: `/v1/items/${item._id}`,
            token: plaintext,
            body: { status: 'nextAction', timeStart: '2099-02-01T10:00:00Z' },
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string; extra?: { status: string; field: string } };
        expect(body.code).toBe('status_field_violation');
        expect(body.extra).toEqual({ status: 'nextAction', field: 'timeStart' });
    });

    // Tenant isolation — Alice cannot PATCH Bob's item; per memory feedback_tenant_isolation_test_gap.
    it("Alice cannot PATCH Bob's item — returns 404 and Bob's row is unchanged, no op logged", async () => {
        const a = await newUserWithToken('alice');
        const b = await newUserWithToken('bob');
        const bobItem = await seedItem({ userId: b.userId, title: 'bob' });
        const res = await callApi({ method: 'PATCH', path: `/v1/items/${bobItem._id}`, token: a.plaintext, body: { title: 'pwned' } });
        expect(res.status).toBe(404);
        const after = await db.collection<{ title: string }>('items').findOne({ _id: bobItem._id } as never);
        expect(after?.title).toBe('bob');
        const ops = await db.collection('operations').findOne({ entityId: bobItem._id } as never);
        expect(ops).toBeNull();
    });

    // Empty title via PATCH — must be rejected. Pins the schema-level fix that closes the same
    // gap on /sync/push and /v1/operations/batch (title was z.string(), now nonEmptyString).
    it('rejects PATCH { title: "" } via the schema (matches POST behavior, no empty titles allowed)', async () => {
        const { userId, plaintext } = await newUserWithToken();
        const item = await seedItem({ userId, title: 'old' });
        const res = await callApi({ method: 'PATCH', path: `/v1/items/${item._id}`, token: plaintext, body: { title: '' } });
        expect(res.status).toBe(400);
        // The schema rejects empty strings — Zod's `invalid_operation` code with a path pointing at title.
        expect(((await res.json()) as { code: string }).code).toBe('invalid_operation');
        const after = await itemsDAO.findByOwnerAndId(item._id ?? '', userId);
        expect(after?.title).toBe('old');
    });

    // Trash transitions are intentionally OUT of the public API (no /v1 restore endpoint exists).
    it('PATCH { status: "trash" } is rejected with invalid_transition (in-app UI only)', async () => {
        const { userId, plaintext } = await newUserWithToken();
        const item = await seedItem({ userId, title: 't' });
        const res = await callApi({ method: 'PATCH', path: `/v1/items/${item._id}`, token: plaintext, body: { status: 'trash' } });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_transition');
        // Item still inbox.
        const after = await itemsDAO.findByOwnerAndId(item._id ?? '', userId);
        expect(after?.status).toBe('inbox');
    });

    // Audit trail — every successful PATCH writes one operation row; every rejected PATCH writes zero.
    it('writes exactly one update op with deviceId=api:<tokenId> on success; zero ops on rejection', async () => {
        const { userId, plaintext, tokenId } = await newUserWithToken();
        const item = await seedItem({ userId, title: 'old' });

        // Successful PATCH — one op recorded.
        const ok = await callApi({ method: 'PATCH', path: `/v1/items/${item._id}`, token: plaintext, body: { title: 'new' } });
        expect(ok.status).toBe(200);
        const opsAfter = await db
            .collection<{ deviceId: string; opType: string }>('operations')
            .find({ entityId: item._id } as never)
            .toArray();
        expect(opsAfter).toHaveLength(1);
        expect(opsAfter[0]?.opType).toBe('update');
        expect(opsAfter[0]?.deviceId).toBe(`api:${tokenId}`);

        // Rejected PATCH — no new op is logged.
        await db.collection('operations').deleteMany({ entityId: item._id } as never);
        const rejected = await callApi({ method: 'PATCH', path: `/v1/items/${item._id}`, token: plaintext, body: { user: 'attacker' } });
        expect(rejected.status).toBe(400);
        const opsAfterReject = await db.collection('operations').countDocuments({ entityId: item._id } as never);
        expect(opsAfterReject).toBe(0);
    });
});
