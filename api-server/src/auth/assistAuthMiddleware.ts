import type { MiddlewareHandler } from 'hono';
import { auth } from '../loaders/mainLoader.js';
import { type BearerVariables, resolveBearerApiAuth } from './bearerMiddleware.js';

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
export const authenticateBearerOrSession: MiddlewareHandler<{ Variables: BearerVariables }> = async (c, next) => {
    const bearerAuth = await resolveBearerApiAuth(c.req.header('Authorization'));
    if (bearerAuth) {
        c.set('apiAuth', bearerAuth);
        await next();
        return;
    }

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
        return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
    }

    c.set('apiAuth', { userId: session.user.id, tokenId: `session:${session.session.id}`, scopes: ['claude.assist'] });
    await next();
    return;
};
