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
 * `GET /auth/user-status` — the unauthenticated tombstone probe every device runs per logged-in
 * account on boot and on every reconnect. Keyed by IP, so a NAT'd office or a CI box shares one
 * bucket; 120/min leaves headroom for that, and the client treats a 429 as `unknown` (fail-open:
 * nothing is evaporated, the next probe retries), so exhaustion only delays an evaporation.
 */
export const USER_STATUS_BUCKET: BucketConfig = { capacity: 120, refillPerSec: 120 / 60 };

/**
 * Decides which bucket a /v1 request falls into. Pure — no I/O. Exposed for tests so we don't
 * have to spin up a Hono context to assert routing.
 */
export function classifyRequest(method: string, path: string): 'write' | 'read' | null {
    const isWrite =
        (method === 'POST' &&
            (path === '/v1/items' ||
                path === '/v1/items/bulk' ||
                /^\/v1\/items\/[^/]+\/(complete|trash)$/.test(path) ||
                path === '/v1/people' ||
                path === '/v1/work-contexts' ||
                path === '/v1/routines' ||
                /^\/v1\/routines\/[^/]+\/(pause|resume|split)$/.test(path) ||
                path === '/v1/reassign' ||
                path === '/v1/operations/batch')) ||
        (method === 'PATCH' &&
            (/^\/v1\/items\/[^/]+$/.test(path) ||
                /^\/v1\/people\/[^/]+$/.test(path) ||
                /^\/v1\/work-contexts\/[^/]+$/.test(path) ||
                /^\/v1\/routines\/[^/]+$/.test(path))) ||
        (method === 'DELETE' && (/^\/v1\/people\/[^/]+$/.test(path) || /^\/v1\/work-contexts\/[^/]+$/.test(path) || /^\/v1\/routines\/[^/]+$/.test(path))) ||
        // This classifier is an allowlist, not a method rule: an unlisted route gets NO limiter
        // at all (see authenticatedRateLimit), so every new write route must be added here.
        (method === 'PUT' && /^\/v1\/items\/[^/]+\/brief$/.test(path)) ||
        // Brief generation also has its own per-user cap (see routes/v1/itemBriefGenerate.ts);
        // the write bucket still applies so it counts against the token's overall write budget.
        (method === 'POST' && /^\/v1\/items\/[^/]+\/brief\/generate$/.test(path));
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
 * Upper bound on distinct bucket keys. Keys are `<bucket>:<tokenId|ip>`; an attacker rotating a
 * spoofed client IP against an unauthenticated endpoint could otherwise grow the map without end.
 * At the cap the OLDEST key is evicted (Map iteration order is insertion order), so legitimate
 * buckets are only ever lost one at a time under attack — never reset wholesale.
 */
const MAX_BUCKET_KEYS = 50_000;

/**
 * Default in-process store. Each Cloud Run instance keeps its own counters; on multi-instance
 * deployments a caller can briefly burst capacity * N, which is acceptable for this UX-grade
 * limiter (the goal is "stop runaway scripts", not "exact transaction-per-second budget").
 * Exported for the eviction test; production uses the module-level `defaultStore` instance.
 */
export class InMemoryStore implements RateLimitStore {
    private map = new Map<string, BucketState>();
    private readonly maxKeys: number;
    constructor(maxKeys = MAX_BUCKET_KEYS) {
        this.maxKeys = maxKeys;
    }
    get(key: string): BucketState | undefined {
        return this.map.get(key);
    }
    set(key: string, state: BucketState): void {
        if (!this.map.has(key) && this.map.size >= this.maxKeys) {
            const oldest = this.map.keys().next().value;
            if (oldest !== undefined) {
                this.map.delete(oldest);
            }
        }
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

interface IpRateLimitDeps extends MiddlewareDeps {
    bucket: BucketConfig;
    /** Namespaces the store key so two IP-keyed limiters on different routes never share a bucket. */
    keyPrefix: string;
}

/**
 * Best-effort client IP extraction. `CF-Connecting-IP` first: the Cloudflare Worker in front of the
 * API sets it from the connection and a client cannot forge it through Cloudflare. `X-Forwarded-For`
 * is the fallback for direct Cloud Run / local traffic; its left-most entry is client-controlled, so
 * on an unauthenticated route the limiter is advisory there (see MAX_BUCKET_KEYS). Falls back to `'unknown'`.
 */
function extractClientIp(c: Context): string {
    const cloudflareIp = c.req.header('cf-connecting-ip')?.trim();
    if (cloudflareIp) {
        return cloudflareIp;
    }
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
        // x-forwarded-for can be a comma-separated chain; the first entry is the original client.
        const first = xff.split(',')[0]?.trim();
        if (first) {
            return first;
        }
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
 * Charges the IP-keyed anon bucket for a request that failed authentication and returns the 429
 * to send when it is exhausted, or `null` to proceed with the caller's own 401. Shared by the
 * bearer-only and the dual-auth middlewares so every /v1 401 path is throttled identically.
 */
export function anonymousRejection(c: Context): Response | null {
    const ip = extractClientIp(c);
    const result = tryConsume(defaultStore, `anon:${ip}`, ANON_BUCKET, Date.now());
    if (result.allowed) {
        return null;
    }
    console.log('[rate-limit]', { bucket: 'anon', ip, route: c.req.path, method: c.req.method });
    return rateLimitedResponse(c, result.retryAfterSec);
}

/**
 * Generic IP-keyed limiter for unauthenticated endpoints (`GET /auth/user-status` today). The
 * bucket and key prefix are the caller's so each endpoint gets its own budget.
 */
export function ipRateLimit(deps: IpRateLimitDeps): MiddlewareHandler {
    const store = deps.store ?? defaultStore;
    const now = deps.now ?? Date.now;
    return async (c, next) => {
        const ip = extractClientIp(c);
        const key = `${deps.keyPrefix}:${ip}`;
        const result = tryConsume(store, key, deps.bucket, now());
        if (!result.allowed) {
            console.log('[rate-limit]', { bucket: deps.keyPrefix, ip, route: c.req.path, method: c.req.method });
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
    return ipRateLimit({ ...deps, bucket: ANON_BUCKET, keyPrefix: 'anon' });
}
