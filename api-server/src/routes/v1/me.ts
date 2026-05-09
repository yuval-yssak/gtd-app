import { Hono } from 'hono';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import apiTokensDAO from '../../dataAccess/apiTokensDAO.js';
import { getUserEmail } from '../../lib/userLookup.js';

/**
 * Returns the authenticated caller's identity — the userId behind the bearer token, the
 * token's human label, and the user's email. The label is the same value shown in the settings
 * UI's token list, so MCP-style integrations can translate an account-name slug → userId
 * without ever surfacing the raw UUID to the model. The email lets the MCP echo a
 * human-recognisable identifier ("which Google account is this?") when the model lists
 * connected accounts. Any minted scope grants access; this is identity only and exposes
 * nothing beyond what `/v1/items` would already imply about the caller's user.
 */
export const v1MeRoutes = new Hono<{ Variables: BearerVariables }>()
    .use('*', authenticateBearer)
    .use('*', authenticatedRateLimit())

    .get('/me', async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        // Bearer middleware doesn't surface the token's label (no other route needs it). Look it
        // up here — the row is already in Mongo's hot set since the auth middleware just read it.
        // `getUserEmail` handles both ObjectId-keyed Better Auth rows and string-keyed test seeds.
        // Falls back to '' when missing — defensive against a deleted-user race.
        const [token, email] = await Promise.all([apiTokensDAO.findOne({ _id: tokenId }), getUserEmail(userId)]);
        return c.json({ userId, label: token?.label ?? '', email: email ?? '' });
    });
