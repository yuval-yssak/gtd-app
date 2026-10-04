import { type Context, Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import { ipRateLimit, USER_STATUS_BUCKET } from '../auth/rateLimitMiddleware.js';
import deletedUsersDAO from '../dataAccess/deletedUsersDAO.js';
import { deleteUserCompletely } from '../lib/deleteUserCompletely.js';
import { exportFilename, exportUserData } from '../lib/exportUserData.js';
import { findUserById } from '../lib/userLookup.js';
import type { AuthVariables } from '../types/authTypes.js';

/**
 * Account lifecycle endpoints, mounted under `/auth` BEFORE Better Auth's catch-all handler in
 * `index.ts` (Hono runs the first matching handler, so these win for their exact paths).
 */

/** Better Auth ids are 32-char strings or 24-hex ObjectIds; anything longer is not a lookup worth doing. */
const MAX_USER_ID_LENGTH = 64;

export type UserStatus = { status: 'active' } | { status: 'deleted'; deletedAt: string } | { status: 'unknown' };

/** Pure lookup order behind `GET /auth/user-status`: a live user wins, then the tombstone, else unknown. */
export async function resolveUserStatus(userId: string): Promise<UserStatus> {
    if (await findUserById(userId)) {
        return { status: 'active' };
    }
    const tombstone = await deletedUsersDAO.findByUserId(userId);
    return tombstone ? { status: 'deleted', deletedAt: tombstone.deletedAt } : { status: 'unknown' };
}

export const accountRoutes = new Hono<{ Variables: AuthVariables }>()
    // GET /auth/user-status?userId=<id> — UNAUTHENTICATED by design. A device whose 30-day session
    // expired while it was offline cannot call anything authenticated, yet it must still learn
    // that its account was deleted. The userId is not a secret (the device already holds it) and
    // the response carries nothing beyond the deletion timestamp. IP rate-limited; the client
    // treats a 429 like `unknown`.
    .get('/user-status', ipRateLimit({ bucket: USER_STATUS_BUCKET, keyPrefix: 'user-status' }), async (c) => {
        const userId = c.req.query('userId');
        if (!userId || userId.length > MAX_USER_ID_LENGTH) {
            return c.json({ error: 'userId query parameter is required' }, 400);
        }
        return c.json(await resolveUserStatus(userId));
    })
    // DELETE /auth/me?expectedUserId=<id> — self-service account deletion. Everything the user owns goes, server-side,
    // in this request; the session is among the deleted rows, so the caller's cookie is dead when
    // the response arrives and the client finishes by evaporating the account locally.
    .delete('/me', authenticateRequest, async (c) => {
        const userId = c.get('session').user.id;
        const mismatch = sessionMismatchResponse(c, userId);
        if (mismatch) {
            return mismatch;
        }
        const report = await deleteUserCompletely(userId);
        return c.json({ ok: true, deletedUserId: userId, report });
    });

// GET /export?expectedUserId=<id> — "Download my data", as a JSON attachment.
export const exportRoutes = new Hono<{ Variables: AuthVariables }>().get('/', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const mismatch = sessionMismatchResponse(c, userId);
    if (mismatch) {
        return mismatch;
    }
    const payload = await exportUserData(userId);
    c.header('Content-Disposition', `attachment; filename="${exportFilename()}"`);
    return c.json(payload);
});

/**
 * On a multi-account device the app's active account lives in IDB while the API-origin cookie can
 * still point at a DIFFERENT signed-in account (the known cookie/IDB drift). For an irreversible
 * action the cookie alone is not enough: the client sends the id of the account the user is
 * looking at, and a disagreement is refused instead of deleting (or exporting) the wrong account.
 */
function sessionMismatchResponse(c: Context, sessionUserId: string): Response | null {
    const expectedUserId = c.req.query('expectedUserId');
    if (expectedUserId === undefined) {
        // Required, not optional: an irreversible action must always say which account it means.
        return c.json({ error: 'expectedUserId query parameter is required', code: 'expected_user_id_required' }, 400);
    }
    if (expectedUserId === sessionUserId) {
        return null;
    }
    return c.json({ error: 'The session on this device belongs to a different account than the one requested', code: 'session_mismatch', sessionUserId }, 409);
}
