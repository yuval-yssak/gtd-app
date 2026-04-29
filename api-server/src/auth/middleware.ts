import type { MiddlewareHandler } from 'hono';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
import { auth } from '../loaders/mainLoader.js';
import type { AuthVariables } from '../types/authTypes.js';

const DEVICE_ID_HEADER = 'X-Device-Id';

// Fire-and-forget: never let a maintenance write block the request lifecycle.
// Logged-not-rethrown so a transient Mongo blip doesn't 500 every authenticated request.
function recordDeviceUserSeen(deviceId: string, userId: string): void {
    void deviceUsersDAO.upsert(deviceId, userId).catch((err) => {
        console.error('[deviceUsers] upsert failed', { deviceId, userId, err });
    });
}

export const authenticateRequest: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
        return c.json({ error: 'Unauthorized: No session' }, 401);
    }

    c.set('session', session);

    // Track which (device, user) pairs are alive so reads of "all devices for user X"
    // and pushes after sign-out can stay correct without scanning every Better Auth session.
    const deviceId = c.req.header(DEVICE_ID_HEADER);
    if (deviceId) {
        recordDeviceUserSeen(deviceId, session.user.id);
    }

    await next();
    return; // noImplicitReturns requires explicit return after next()
};
