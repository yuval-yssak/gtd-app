import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
import type { AuthVariables } from '../types/authTypes.js';

/**
 * Per-device account-membership endpoints.
 *
 * Mounted at `/devices` (not `/auth`) because Better Auth claims the `/auth/*` namespace
 * via a catch-all in index.ts. The client calls these endpoints as part of the sign-out
 * flow so the server-side `deviceUsers` join doesn't outlive the Better Auth session.
 */
export const deviceRoutes = new Hono<{ Variables: AuthVariables }>()
    // POST /devices/signout — drop the (deviceId, currentUserId) pair. The actual Better Auth
    // signOut still happens client-side; this endpoint just removes the join row first so the
    // device stops receiving pushes meant for the about-to-be-signed-out account.
    .post('/signout', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const { deviceId } = await c.req.json<{ deviceId: string }>();
        if (!deviceId) {
            return c.json({ error: 'deviceId required' }, 400);
        }

        await deviceUsersDAO.remove(deviceId, user.id);
        return c.json({ ok: true }, 200);
    });
