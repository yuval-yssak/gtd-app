/**
 * Bearer-token authentication middleware for /v1/*.
 *
 * REVOCATION-PROPAGATION GUARDRAIL (issue #19 step 11): same constraint as `apiTokens.ts` —
 * do NOT add an in-process token cache here. `resolveBearerToken` reads Mongo on every request
 * by design so revocation takes effect within ms. A cache without invalidation lets revoked
 * tokens linger; on multi-instance deploys the staleness window is unbounded.
 */
import dayjs from 'dayjs';
import type { Context, MiddlewareHandler } from 'hono';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import { type ApiTokenScope, DEFAULT_API_TOKEN_SCOPES } from '../types/entities.js';
import { resolveBearerToken } from './apiTokens.js';
import { ANON_BUCKET, defaultStore, tryConsume } from './rateLimitMiddleware.js';

/** Hono context variables made available to v1 route handlers after the bearer middleware runs. */
export type BearerVariables = {
    apiAuth: {
        userId: string;
        tokenId: string;
        /** Capabilities the token holder can exercise. Always populated post-middleware (see lazy backfill below). */
        scopes: ApiTokenScope[];
    };
};

/** Best-effort client IP extraction matching the rate-limiter's logic. */
function extractClientIp(c: Context): string {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
        const first = xff.split(',')[0]?.trim();
        if (first) return first;
    }
    return c.req.header('x-real-ip') ?? 'unknown';
}

/**
 * Resolves an `Authorization: Bearer gtd_<token>` header to a populated `apiAuth` value, or null
 * when no valid bearer token is present. Extracted so the dual-auth assist middleware can reuse the
 * exact bearer resolution (scope backfill, legacy `items.clarify` bridge, fire-and-forget
 * `lastUsedTs` bump) without duplicating it — keeping the two auth paths from drifting.
 *
 * Returns null (rather than throwing) so callers can decide the fallback: `authenticateBearer`
 * returns 401, while `authenticateBearerOrSession` falls through to cookie-session resolution.
 * Honors the no-token-cache revocation guardrail — `resolveBearerToken` hits Mongo every call.
 */
export async function resolveBearerApiAuth(authorizationHeader: string | undefined): Promise<BearerVariables['apiAuth'] | null> {
    const token = await resolveBearerToken(authorizationHeader);
    if (!token) {
        return null;
    }

    const storedScopes = token.scopes ?? DEFAULT_API_TOKEN_SCOPES;
    if (token.scopes === undefined) {
        // One-time write per legacy token; idempotent.
        void apiTokensDAO.setScopes(token._id, storedScopes).catch((err) => {
            console.error('[apiTokens] scopes backfill failed', { tokenId: token._id, err });
        });
    }
    // Phase 2 legacy bridge: pre-extension tokens carry `items.clarify` for what is now
    // `items.write`. We backfill in-memory only — leaving the stored row untouched keeps the
    // mint endpoint's "no new items.clarify" rule simple and means revocation/auditing of legacy
    // tokens still works against the original scope string.
    // The `as const` narrows the literal back to `ApiTokenScope` inside the spread; without it
    // TypeScript widens the literal to `string` and `c.set('apiAuth', …)` rejects the mixed array.
    const scopes = storedScopes.includes('items.clarify') && !storedScopes.includes('items.write') ? [...storedScopes, 'items.write' as const] : storedScopes;

    void apiTokensDAO.touchLastUsed(token._id, dayjs().toISOString()).catch((err) => {
        console.error('[apiTokens] touchLastUsed failed', { tokenId: token._id, err });
    });

    return { userId: token.user, tokenId: token._id, scopes };
}

/**
 * Authenticates `/v1/*` requests via `Authorization: Bearer gtd_<token>`.
 * Sets `c.var.apiAuth.{userId, tokenId, scopes}` on success; returns 401 otherwise.
 *
 * Scope backfill: tokens minted before issue #19 step 7 do not carry `scopes`. Rather than run a
 * one-shot migration, we lazily backfill on first authenticated use — populating both the in-row
 * value (so subsequent reads are O(1)) and the request's `apiAuth.scopes`. New tokens already
 * carry scopes from `issueApiToken`, so the backfill is a transient measure.
 *
 * Anonymous-bucket consumption: failed-auth requests consume from the IP-keyed anon bucket
 * (30/min, see `rateLimitMiddleware.ts`). Successful-auth requests do NOT touch the anon bucket —
 * they're scoped by `tokenId` via `authenticatedRateLimit` instead. This split prevents a noisy
 * test environment from accidentally exhausting the anon bucket with valid tokens.
 *
 * lastUsedTs is bumped fire-and-forget so a transient Mongo blip can't 500 every authenticated call.
 */
export const authenticateBearer: MiddlewareHandler<{ Variables: BearerVariables }> = async (c, next) => {
    const apiAuth = await resolveBearerApiAuth(c.req.header('Authorization'));
    if (!apiAuth) {
        const result = tryConsume(defaultStore, `anon:${extractClientIp(c)}`, ANON_BUCKET, Date.now());
        if (!result.allowed) {
            console.log('[rate-limit]', { bucket: 'anon', ip: extractClientIp(c), route: c.req.path, method: c.req.method });
            c.header('Retry-After', String(result.retryAfterSec));
            return c.json({ error: 'Rate limit exceeded. Slow down and retry after a brief pause.', code: 'rate_limited' }, 429);
        }
        return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
    }

    c.set('apiAuth', apiAuth);

    await next();
    return;
};
