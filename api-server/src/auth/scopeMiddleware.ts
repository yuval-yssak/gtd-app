import type { MiddlewareHandler } from 'hono';
import type { ApiTokenScope } from '../types/entities.js';
import type { BearerVariables } from './bearerMiddleware.js';

/**
 * Gates a /v1 route on a specific token scope. Mounted AFTER `authenticateBearer` so
 * `c.var.apiAuth.scopes` is populated. Returns 403 with `forbidden_scope` when the token
 * lacks the required capability.
 *
 * Usage:
 *   .post('/items', requireScope('items.capture'), handler)
 *
 * Issuing tokens with the smallest scope set is the right hygiene; this middleware is the
 * server-side enforcement of that contract. Pre-scopes tokens are backfilled to capture+read
 * by the bearer middleware, so they continue to work for the endpoints they could already use.
 */
export function requireScope(scope: ApiTokenScope): MiddlewareHandler<{ Variables: BearerVariables }> {
    return async (c, next) => {
        const { scopes } = c.var.apiAuth;
        if (!scopes.includes(scope)) {
            return c.json(
                {
                    error: `This token is not permitted to perform this action. Required scope: ${scope}.`,
                    code: 'forbidden_scope',
                    requiredScope: scope,
                },
                403,
            );
        }
        await next();
        return;
    };
}
