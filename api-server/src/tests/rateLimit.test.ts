/** Token-bucket rate limiter unit tests.
 *
 * The middleware is exercised via a small Hono harness rather than against the real /v1 router,
 * so we can drive the bucket precisely with a fake `now()`. The /v1 integration (auth ordering,
 * Retry-After header) is verified once at the end with the real router wired up.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import type { BearerVariables } from '../auth/bearerMiddleware.js';
import {
    __resetDefaultStoreForTests,
    ANON_BUCKET,
    anonymousRateLimit,
    authenticatedRateLimit,
    type BucketState,
    classifyRequest,
    type RateLimitStore,
    READ_BUCKET,
    tryConsume,
    WRITE_BUCKET,
} from '../auth/rateLimitMiddleware.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ItemsRoutes } from '../routes/v1Items.js';
import { oauthLogin } from './helpers.js';

// Backing store the test owns so each test starts from an empty state without resetting modules.
class InMemoryStore implements RateLimitStore {
    private readonly map = new Map<string, BucketState>();
    get(key: string): BucketState | undefined {
        return this.map.get(key);
    }
    set(key: string, state: BucketState): void {
        this.map.set(key, state);
    }
}

describe('classifyRequest', () => {
    it('routes the four /v1 endpoints into the correct bucket', () => {
        expect(classifyRequest('POST', '/v1/items')).toBe('write');
        expect(classifyRequest('POST', '/v1/items/abc-123/complete')).toBe('write');
        expect(classifyRequest('GET', '/v1/items')).toBe('read');
        expect(classifyRequest('GET', '/v1/items/abc-123')).toBe('read');
    });

    it('returns null for paths not under /v1/items', () => {
        expect(classifyRequest('GET', '/account/tokens')).toBeNull();
        expect(classifyRequest('POST', '/sync/push')).toBeNull();
    });
});

describe('tryConsume', () => {
    it('grants until capacity is exhausted, then refuses with retryAfterSec >= 1', () => {
        const store = new InMemoryStore();
        const config = { capacity: 3, refillPerSec: 1 };
        const t0 = 1_000_000;
        for (let i = 0; i < 3; i++) {
            expect(tryConsume(store, 'k', config, t0).allowed).toBe(true);
        }
        const denied = tryConsume(store, 'k', config, t0);
        expect(denied.allowed).toBe(false);
        expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    });

    it('refills tokens lazily based on elapsed time', () => {
        const store = new InMemoryStore();
        const config = { capacity: 2, refillPerSec: 1 };
        const t0 = 1_000_000;
        // Drain the bucket.
        tryConsume(store, 'k', config, t0);
        tryConsume(store, 'k', config, t0);
        expect(tryConsume(store, 'k', config, t0).allowed).toBe(false);
        // 2 seconds later: 2 tokens refilled, both consumable, capped at capacity.
        const later = t0 + 2_000;
        expect(tryConsume(store, 'k', config, later).allowed).toBe(true);
        expect(tryConsume(store, 'k', config, later).allowed).toBe(true);
        expect(tryConsume(store, 'k', config, later).allowed).toBe(false);
    });

    it('keeps separate buckets per key', () => {
        const store = new InMemoryStore();
        const config = { capacity: 1, refillPerSec: 1 };
        const t0 = 1_000_000;
        expect(tryConsume(store, 'a', config, t0).allowed).toBe(true);
        // 'b' has its own bucket and should not be affected.
        expect(tryConsume(store, 'b', config, t0).allowed).toBe(true);
    });
});

describe('authenticatedRateLimit middleware', () => {
    function buildApp(store: RateLimitStore, now: () => number) {
        // Stub authenticateBearer with a static apiAuth so we don't need real tokens for these tests.
        return new Hono<{ Variables: BearerVariables }>()
            .use('*', async (c, next) => {
                c.set('apiAuth', { userId: 'u1', tokenId: 'tok-1' });
                await next();
            })
            .use('*', authenticatedRateLimit({ store, now }))
            .post('/v1/items', (c) => c.json({ ok: true }))
            .get('/v1/items', (c) => c.json({ items: [] }))
            .post('/v1/items/:id/complete', (c) => c.json({ ok: true }))
            .get('/v1/items/:id', (c) => c.json({ item: {} }))
            .get('/account/tokens', (c) => c.json({ tokens: [] }));
    }

    let now: number;
    const advanceTo = (ms: number) => {
        now = ms;
    };

    beforeEach(() => {
        now = 1_000_000;
    });

    it('write bucket: 60th call allowed, 61st returns 429 with Retry-After', async () => {
        const store = new InMemoryStore();
        const app = buildApp(store, () => now);
        for (let i = 0; i < WRITE_BUCKET.capacity; i++) {
            const res = await app.request('/v1/items', { method: 'POST' });
            expect(res.status).toBe(200);
        }
        const denied = await app.request('/v1/items', { method: 'POST' });
        expect(denied.status).toBe(429);
        expect(denied.headers.get('Retry-After')).not.toBeNull();
        const body = (await denied.json()) as { code: string };
        expect(body.code).toBe('rate_limited');
    });

    it('read bucket is independent of the write bucket', async () => {
        const store = new InMemoryStore();
        const app = buildApp(store, () => now);
        // Drain the write bucket.
        for (let i = 0; i < WRITE_BUCKET.capacity; i++) {
            await app.request('/v1/items', { method: 'POST' });
        }
        expect((await app.request('/v1/items', { method: 'POST' })).status).toBe(429);
        // Read still has full capacity.
        const read = await app.request('/v1/items');
        expect(read.status).toBe(200);
    });

    it('refills after the configured window so eventually allows again', async () => {
        const store = new InMemoryStore();
        const app = buildApp(store, () => now);
        for (let i = 0; i < WRITE_BUCKET.capacity; i++) {
            await app.request('/v1/items', { method: 'POST' });
        }
        expect((await app.request('/v1/items', { method: 'POST' })).status).toBe(429);
        // Advance one minute → bucket fully refilled.
        advanceTo(now + 60_000);
        expect((await app.request('/v1/items', { method: 'POST' })).status).toBe(200);
    });

    it('does not consume tokens for unrelated routes', async () => {
        const store = new InMemoryStore();
        const app = buildApp(store, () => now);
        // /account/tokens is not under /v1/items, so the limiter should pass through.
        for (let i = 0; i < 100; i++) {
            const res = await app.request('/account/tokens');
            expect(res.status).toBe(200);
        }
    });
});

describe('anonymousRateLimit middleware', () => {
    function buildApp(store: RateLimitStore, now: () => number) {
        return new Hono().use('*', anonymousRateLimit({ store, now })).get('/v1/items', (c) => c.json({ items: [] }));
    }

    it('30th call allowed, 31st returns 429, distinct ips bucketed independently', async () => {
        const store = new InMemoryStore();
        const app = buildApp(store, () => 1_000_000);
        for (let i = 0; i < ANON_BUCKET.capacity; i++) {
            expect((await app.request('/v1/items', { headers: { 'X-Forwarded-For': '1.1.1.1' } })).status).toBe(200);
        }
        expect((await app.request('/v1/items', { headers: { 'X-Forwarded-For': '1.1.1.1' } })).status).toBe(429);
        // Different IP → fresh bucket.
        expect((await app.request('/v1/items', { headers: { 'X-Forwarded-For': '2.2.2.2' } })).status).toBe(200);
    });

    it('falls back to a single bucket when no proxy header is present', async () => {
        const store = new InMemoryStore();
        const app = buildApp(store, () => 1_000_000);
        for (let i = 0; i < ANON_BUCKET.capacity; i++) {
            expect((await app.request('/v1/items')).status).toBe(200);
        }
        expect((await app.request('/v1/items')).status).toBe(429);
    });
});

describe('integration with the real /v1 router', () => {
    const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/v1', v1ItemsRoutes);

    beforeEach(async () => {
        await loadDataAccess('gtd_test');
        await Promise.all([
            db.collection('user').deleteMany({}),
            db.collection('session').deleteMany({}),
            db.collection('account').deleteMany({}),
            db.collection('verification').deleteMany({}),
            db.collection('items').deleteMany({}),
            db.collection('operations').deleteMany({}),
            db.collection('apiTokens').deleteMany({}),
        ]);
        // Reset the in-process bucket counters so this test doesn't leak state into other files.
        __resetDefaultStoreForTests();
        vi.restoreAllMocks();
    });

    afterEach(async () => {
        __resetDefaultStoreForTests();
        await closeDataAccess();
    });

    it('returns 429 with Retry-After once the read bucket is exhausted', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const sessionRes = await app.fetch(
            new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `better-auth.session_token=${sessionCookie}` } }),
        );
        const { user } = (await sessionRes.json()) as { user: { id: string } };
        const { plaintext } = await issueApiToken(user.id, 'rate-limit-test');

        const headers = { Authorization: `Bearer ${plaintext}` };
        // Drain the read bucket. We use the read bucket because its capacity (600) will exhaust
        // any test environment's per-token state. We only fire ~601 lightweight GETs which is fast.
        let lastStatus = 200;
        for (let i = 0; i < READ_BUCKET.capacity + 1; i++) {
            const res = await app.fetch(new Request('http://localhost:4000/v1/items', { headers }));
            lastStatus = res.status;
            if (res.status === 429) {
                expect(res.headers.get('Retry-After')).not.toBeNull();
                expect(((await res.json()) as { code: string }).code).toBe('rate_limited');
                return;
            }
        }
        throw new Error(`Expected 429 within ${READ_BUCKET.capacity + 1} requests, but the bucket never exhausted (lastStatus=${lastStatus})`);
    });
});
