import type { Context, MiddlewareHandler } from 'hono';
import type { BearerVariables } from './bearerMiddleware.js';

/**
 * Token-bucket rate limiting for /v1/*.
 *
 * Three independent buckets per principal:
 *   - Write  60 / min  (POST /v1/items, POST /v1/items/:id/complete)
 *   - Read  600 / min  (GET  /v1/items, GET  /v1/items/:id)
 *   - Anon   30 / min  (no token / failed auth, keyed by client IP)
 *
 * Storage today is an in-process `Map`. That's sufficient for the single Cloud Run instance
 * footprint we run on; multi-instance deployments would need a Redis-backed store. The
 * `RateLimitStore` interface keeps the swap to a one-file change.
 */

export interface BucketState {
    tokens: number;
    lastRefillMs: number;
}

export interface RateLimitStore {
    get(key: string): BucketState | undefined;
    set(key: string, state: BucketState): void;
}

export interface BucketConfig {
    /** Max tokens in the bucket. */
    capacity: number;
    /** Tokens added per second. */
    refillPerSec: number;
}

export const WRITE_BUCKET: BucketConfig = { capacity: 60, refillPerSec: 60 / 60 };
export const READ_BUCKET: BucketConfig = { capacity: 600, refillPerSec: 600 / 60 };
export const ANON_BUCKET: BucketConfig = { capacity: 30, refillPerSec: 30 / 60 };

/**
 * Decides which bucket a /v1 request falls into. Pure — no I/O. Exposed for tests so we don't
 * have to spin up a Hono context to assert routing.
 */
export function classifyRequest(method: string, path: string): 'write' | 'read' | null {
    const isWrite =
        (method === 'POST' &&
            (path === '/v1/items' ||
                path === '/v1/items/bulk' ||
                /^\/v1\/items\/[^/]+\/complete$/.test(path) ||
                path === '/v1/people' ||
                path === '/v1/work-contexts' ||
                path === '/v1/routines')) ||
        (method === 'PATCH' &&
            (/^\/v1\/items\/[^/]+$/.test(path) ||
                /^\/v1\/people\/[^/]+$/.test(path) ||
                /^\/v1\/work-contexts\/[^/]+$/.test(path) ||
                /^\/v1\/routines\/[^/]+$/.test(path))) ||
        (method === 'DELETE' && (/^\/v1\/people\/[^/]+$/.test(path) || /^\/v1\/work-contexts\/[^/]+$/.test(path) || /^\/v1\/routines\/[^/]+$/.test(path)));
    if (isWrite) return 'write';
    const isRead =
        method === 'GET' &&
        (path === '/v1/items' ||
            /^\/v1\/items\/[^/]+$/.test(path) ||
            path === '/v1/people' ||
            /^\/v1\/people\/[^/]+$/.test(path) ||
            path === '/v1/work-contexts' ||
            /^\/v1\/work-contexts\/[^/]+$/.test(path) ||
            path === '/v1/routines' ||
            /^\/v1\/routines\/[^/]+$/.test(path));
    if (isRead) return 'read';
    return null;
}

/**
 * Default in-process store. Each Cloud Run instance keeps its own counters; on multi-instance
 * deployments a caller can briefly burst capacity * N, which is acceptable for this UX-grade
 * limiter (the goal is "stop runaway scripts", not "exact transaction-per-second budget").
 */
class InMemoryStore implements RateLimitStore {
    private map = new Map<string, BucketState>();
    get(key: string): BucketState | undefined {
        return this.map.get(key);
    }
    set(key: string, state: BucketState): void {
        this.map.set(key, state);
    }
    /** Test-only: drop all bucket state so a spec doesn't leak counters into the next file. */
    clear(): void {
        this.map = new Map();
    }
}

const defaultStoreImpl = new InMemoryStore();
export const defaultStore: RateLimitStore = defaultStoreImpl;
/** Test-only escape hatch — never call from production code. */
export function __resetDefaultStoreForTests(): void {
    defaultStoreImpl.clear();
}

interface ConsumeResult {
    allowed: boolean;
    /** Seconds until the bucket can satisfy the next single-token request. */
    retryAfterSec: number;
}

/**
 * Atomically refills (lazy refill from elapsed time) and consumes one token from the bucket
 * under `key`. Returns `allowed=false` when the bucket is empty after refill.
 *
 * Pure with respect to the store: a different store implementation (Redis) would change the
 * persistence layer but not this algorithm.
 */
export function tryConsume(store: RateLimitStore, key: string, config: BucketConfig, nowMs: number): ConsumeResult {
    const existing = store.get(key);
    const elapsedMs = existing ? Math.max(0, nowMs - existing.lastRefillMs) : 0;
    const refilled = existing ? Math.min(config.capacity, existing.tokens + (elapsedMs * config.refillPerSec) / 1000) : config.capacity;
    if (refilled < 1) {
        // Save the refilled state so a subsequent call doesn't recompute from a stale baseline.
        store.set(key, { tokens: refilled, lastRefillMs: nowMs });
        const tokensNeeded = 1 - refilled;
        const retryAfterSec = Math.max(1, Math.ceil(tokensNeeded / config.refillPerSec));
        return { allowed: false, retryAfterSec };
    }
    store.set(key, { tokens: refilled - 1, lastRefillMs: nowMs });
    return { allowed: true, retryAfterSec: 0 };
}

interface MiddlewareDeps {
    store?: RateLimitStore;
    /** Override `Date.now()` for fake-timer tests. */
    now?: () => number;
}

/** Best-effort client IP extraction from the standard proxy headers. Falls back to `'unknown'`. */
function extractClientIp(c: Context): string {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
        // x-forwarded-for can be a comma-separated chain; the first entry is the original client.
        const first = xff.split(',')[0]?.trim();
        if (first) return first;
    }
    return c.req.header('x-real-ip') ?? 'unknown';
}

function rateLimitedResponse(c: Context, retryAfterSec: number) {
    c.header('Retry-After', String(retryAfterSec));
    return c.json({ error: 'Rate limit exceeded. Slow down and retry after a brief pause.', code: 'rate_limited' }, 429);
}

/**
 * Rate-limits authenticated /v1 requests by `tokenId`. Mounted AFTER `authenticateBearer` so
 * `c.var.apiAuth.tokenId` is populated. Read and write buckets are independent so a hot read
 * loop can't starve writes (and vice versa).
 */
export function authenticatedRateLimit(deps: MiddlewareDeps = {}): MiddlewareHandler<{ Variables: BearerVariables }> {
    const store = deps.store ?? defaultStore;
    const now = deps.now ?? Date.now;
    return async (c, next) => {
        const classification = classifyRequest(c.req.method, c.req.path);
        if (classification === null) {
            await next();
            return;
        }
        const { tokenId } = c.var.apiAuth;
        const config = classification === 'write' ? WRITE_BUCKET : READ_BUCKET;
        const key = `${classification}:${tokenId}`;
        const result = tryConsume(store, key, config, now());
        if (!result.allowed) {
            console.log('[rate-limit]', { bucket: classification, tokenId, route: c.req.path, method: c.req.method });
            return rateLimitedResponse(c, result.retryAfterSec);
        }
        await next();
        return;
    };
}

/**
 * Rate-limits requests that have NOT yet authenticated. Reusable as a standalone middleware,
 * but on /v1 specifically the anon-bucket consumption is now handled inline by `authenticateBearer`
 * so successful-auth requests don't burn anon tokens. Kept exported for unit tests and any
 * future endpoint that wants a pure pre-auth IP-bucket check.
 */
export function anonymousRateLimit(deps: MiddlewareDeps = {}): MiddlewareHandler {
    const store = deps.store ?? defaultStore;
    const now = deps.now ?? Date.now;
    return async (c, next) => {
        const ip = extractClientIp(c);
        const key = `anon:${ip}`;
        const result = tryConsume(store, key, ANON_BUCKET, now());
        if (!result.allowed) {
            console.log('[rate-limit]', { bucket: 'anon', ip, route: c.req.path, method: c.req.method });
            return rateLimitedResponse(c, result.retryAfterSec);
        }
        await next();
        return;
    };
}
