import type { MiddlewareHandler } from 'hono';
import { auth } from '../loaders/mainLoader.js';
import type { ApiTokenScope } from '../types/entities.js';
import { type BearerVariables, resolveBearerApiAuth } from './bearerMiddleware.js';
import { anonymousRejection } from './rateLimitMiddleware.js';

/**
 * Dual-auth middleware for the Claude-assist routes (`/v1/claude/*`).
 *
 * `/v1/*` is otherwise bearer-only, but the first-party client authenticates with a Better Auth
 * COOKIE SESSION and holds no bearer token. So the assist routes accept EITHER:
 *   - an `Authorization: Bearer gtd_<token>` (external/MCP callers, unchanged — same resolution as
 *     `authenticateBearer`, including scope backfill and the explicit `claude.assist` scope which
 *     `requireScope` still enforces downstream), OR
 *   - the first-party Better Auth session cookie. A session is the user acting on their OWN data, so
 *     it implicitly carries the `claude.assist` capability — we synthesise the scope so the existing
 *     `requireScope('claude.assist')` gate passes, rather than weakening that gate for the bearer path.
 *
 * The synthesised `tokenId` is `session:<sessionId>`. The apply handler builds the op's deviceId as
 * `api:${tokenId}` → `api:session:<sessionId>`; the `api:` prefix is load-bearing (it makes
 * `applyAndPublishOperation` fan the op out to ALL of the user's devices, including the originating
 * one — the client does not write IDB optimistically, so it must receive its own op via pull/SSE).
 *
 * This is the FIRST cookie-authed route under `/v1`. The credentialed cross-origin request it
 * enables requires the `assistCors()` profile (see `corsProfiles.ts`), not the relaxed `publicCors`.
 */
/**
 * Builds the dual-auth middleware for one cookie-authed `/v1` surface. `sessionScopes` are the
 * capabilities a first-party session implicitly carries on that surface — the user acting on their
 * own data — so the route's `requireScope(...)` gate passes without being weakened for bearer
 * callers, who must still hold the scope on their token.
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

/** The Claude-assist flavour: a session synthesises `claude.assist`. */
export const authenticateBearerOrSession = authenticateBearerOrSessionWith(['claude.assist']);
