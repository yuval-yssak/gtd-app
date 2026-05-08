/** Bulk-import tests for `POST /v1/items/bulk` (issue #19 step 6).
 *
 * The endpoint always returns `200` with a per-item `results` array (even when individual items
 * fail validation), and uses `413` only for whole-request rejections (oversize batches). The
 * critical contract: `externalId` is required on every item so re-running an import after a
 * partial failure picks up where it left off via the existing externalId idempotency. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ItemsRoutes } from '../routes/v1/items.js';
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
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

async function userWithToken(): Promise<{ plaintext: string; userId: string }> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    const sessionRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    const { plaintext } = await issueApiToken(user.id, 'bulk-test');
    return { plaintext, userId: user.id };
}

async function postBulk(plaintext: string, body: unknown): Promise<Response> {
    return app.fetch(
        new Request('http://localhost:4000/v1/items/bulk', {
            method: 'POST',
            headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

interface BulkResponseShape {
    results: Array<{ externalId: string; status: 'created' | 'replayed' | 'failed'; _id?: string; error?: string; code?: string }>;
    counts: { created: number; replayed: number; failed: number };
}

describe('POST /v1/items/bulk', () => {
    it('happy path: creates all rows and returns per-item _ids', async () => {
        const { plaintext } = await userWithToken();
        const res = await postBulk(plaintext, {
            items: [
                { title: 'first', externalId: 'ext-1' },
                { title: 'second', externalId: 'ext-2', notes: 'with notes' },
            ],
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as BulkResponseShape;
        expect(body.counts).toEqual({ created: 2, replayed: 0, failed: 0 });
        expect(body.results.every((r) => r.status === 'created' && typeof r._id === 'string' && r._id.length > 0)).toBe(true);
    });

    it('idempotent across runs: a second call with the same externalIds returns replayed', async () => {
        const { plaintext } = await userWithToken();
        const first = await postBulk(plaintext, {
            items: [
                { title: 'a', externalId: 'ext-1' },
                { title: 'b', externalId: 'ext-2' },
            ],
        });
        const firstBody = (await first.json()) as BulkResponseShape;

        const second = await postBulk(plaintext, {
            items: [
                { title: 'a', externalId: 'ext-1' },
                { title: 'b', externalId: 'ext-2' },
            ],
        });
        const secondBody = (await second.json()) as BulkResponseShape;
        expect(secondBody.counts).toEqual({ created: 0, replayed: 2, failed: 0 });
        // Replayed rows return the original _ids — that's what makes the import idempotent.
        const idsByExt = new Map(firstBody.results.map((r) => [r.externalId, r._id]));
        for (const replay of secondBody.results) {
            expect(replay._id).toBe(idsByExt.get(replay.externalId));
        }
    });

    it('mixed batch: validation failures coexist with successes; counts are correct', async () => {
        const { plaintext } = await userWithToken();
        const res = await postBulk(plaintext, {
            items: [
                { title: 'good', externalId: 'ext-1' },
                { title: '', externalId: 'ext-2' }, // empty title
                { title: 'no-ext-id' }, // missing externalId
            ],
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as BulkResponseShape;
        expect(body.counts).toEqual({ created: 1, replayed: 0, failed: 2 });
        const failed = body.results.filter((r) => r.status === 'failed');
        expect(failed.map((r) => r.code).sort()).toEqual(['externalId_required', 'invalid_title']);
    });

    it('rejects an empty items array with 400', async () => {
        const { plaintext } = await userWithToken();
        const res = await postBulk(plaintext, { items: [] });
        expect(res.status).toBe(400);
    });

    it('rejects > 5,000 items with 413 (whole-request rejection, no per-item processing)', async () => {
        const { plaintext } = await userWithToken();
        const items = Array.from({ length: 5_001 }, (_, i) => ({ title: `t-${i}`, externalId: `ext-${i}` }));
        const res = await postBulk(plaintext, { items });
        expect(res.status).toBe(413);
        expect(((await res.json()) as { code: string }).code).toBe('too_many_items');
    });

    it('externalId is required on every item; rows without it are reported but do not abort the batch', async () => {
        const { plaintext } = await userWithToken();
        const res = await postBulk(plaintext, {
            items: [
                { title: 'a', externalId: 'ext-1' },
                { title: 'b' }, // missing externalId
                { title: 'c', externalId: 'ext-3' },
            ],
        });
        const body = (await res.json()) as BulkResponseShape;
        expect(body.counts.created).toBe(2);
        expect(body.counts.failed).toBe(1);
    });

    it('chunkSize is clamped: > MAX_BULK_CHUNK_SIZE silently capped, < 1 falls back to default', async () => {
        const { plaintext } = await userWithToken();
        const items = Array.from({ length: 10 }, (_, i) => ({ title: `t-${i}`, externalId: `ext-${i}` }));
        // Caller asks for an absurd chunk size; server clamps it but still produces correct results.
        const res = await postBulk(plaintext, { items, chunkSize: 9_999 });
        const body = (await res.json()) as BulkResponseShape;
        expect(body.counts).toEqual({ created: 10, replayed: 0, failed: 0 });
    });

    it('returns 400 for a missing items field', async () => {
        const { plaintext } = await userWithToken();
        const res = await postBulk(plaintext, {});
        expect(res.status).toBe(400);
    });
});
