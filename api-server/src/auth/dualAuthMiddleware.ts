import type { MiddlewareHandler } from 'hono';
import { auth } from '../loaders/mainLoader.js';
import type { ApiTokenScope } from '../types/entities.js';
import { type BearerVariables, resolveBearerApiAuth } from './bearerMiddleware.js';
import { anonymousRejection } from './rateLimitMiddleware.js';

/**
 * Dual-auth middleware for the cookie-authed `/v1` surfaces (today: `/v1/items/:id/brief/generate`).
 *
 * `/v1/*` is otherwise bearer-only, but the first-party client authenticates with a Better Auth
 * COOKIE SESSION and holds no bearer token. So these routes accept EITHER:
 *   - an `Authorization: Bearer gtd_<token>` (external/MCP callers, unchanged — same resolution as
 *     `authenticateBearer`, including scope backfill; `requireScope` still enforces the route's
 *     scope downstream), OR
 *   - the first-party Better Auth session cookie. A session is the user acting on their OWN data, so
 *     it implicitly carries the route's capability — we synthesise the scope so the existing
 *     `requireScope(...)` gate passes, rather than weakening that gate for the bearer path.
 *
 * The synthesised `tokenId` is `session:<sessionId>`; handlers that attribute an op to the caller
 * must map it to their own device id (see `itemBriefGenerate.ts`).
 *
 * The credentialed cross-origin request this enables requires the `dualAuthCors()` profile (see
 * `corsProfiles.ts`), not the relaxed `publicCors`.
 */
export function authenticateBearerOrSessionWith(sessionScopes: ApiTokenScope[]): MiddlewareHandler<{ Variables: BearerVariables }> {
    return async (c, next) => {
        const bearerAuth = await resolveBearerApiAuth(c.req.header('Authorization'));
        if (bearerAuth) {
            c.set('apiAuth', bearerAuth);
            await next();
            return;
        }

        const session = await auth.api.getSession({ headers: c.req.raw.headers });
        if (!session) {
            // Same IP-keyed anon bucket `authenticateBearer` charges on a failed auth, so an
            // unauthenticated flood of a dual-auth route is throttled like any other /v1 route.
            return anonymousRejection(c) ?? c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
        }

        c.set('apiAuth', { userId: session.user.id, tokenId: `session:${session.session.id}`, scopes: sessionScopes });
        await next();
        return;
    };
}
