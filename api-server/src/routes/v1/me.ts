import { Hono } from 'hono';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import apiTokensDAO from '../../dataAccess/apiTokensDAO.js';

/**
 * Returns the authenticated caller's identity — the userId behind the bearer token plus the
 * token's human label. The label is the same value shown in the settings UI's token list, so
 * MCP-style integrations can translate an account-name slug → userId without ever surfacing
 * the raw UUID to the model. Any minted scope grants access; this is identity only and exposes
 * nothing beyond what `/v1/items` would already imply about the caller's user.
 */
export const v1MeRoutes = new Hono<{ Variables: BearerVariables }>()
    .use('*', authenticateBearer)
    .use('*', authenticatedRateLimit())

    .get('/me', async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        // The bearer middleware doesn't expose the token's label (it's not load-bearing for any
        // other route). Look it up here — the row is already cached in Mongo's hot set since the
        // auth middleware just read it.
        const token = await apiTokensDAO.findOne({ _id: tokenId });
        return c.json({ userId, label: token?.label ?? '' });
    });
