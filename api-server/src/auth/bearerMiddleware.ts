import dayjs from 'dayjs';
import type { MiddlewareHandler } from 'hono';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import { resolveBearerToken } from './apiTokens.js';

/** Hono context variables made available to v1 route handlers after the bearer middleware runs. */
export type BearerVariables = {
    apiAuth: {
        userId: string;
        tokenId: string;
    };
};

/**
 * Authenticates `/v1/*` requests via `Authorization: Bearer gtd_<token>`.
 * Sets `c.var.apiAuth.{userId, tokenId}` on success; returns 401 otherwise.
 *
 * lastUsedTs is bumped fire-and-forget so a transient Mongo blip can't 500 every authenticated call.
 * The bump can lag a few seconds behind the actual request — the token-list view in settings is the
 * only consumer and a few seconds of staleness is fine there.
 */
export const authenticateBearer: MiddlewareHandler<{ Variables: BearerVariables }> = async (c, next) => {
    const token = await resolveBearerToken(c.req.header('Authorization'));
    if (!token) {
        return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
    }

    c.set('apiAuth', { userId: token.user, tokenId: token._id });

    void apiTokensDAO.touchLastUsed(token._id, dayjs().toISOString()).catch((err) => {
        console.error('[apiTokens] touchLastUsed failed', { tokenId: token._id, err });
    });

    await next();
    return;
};
