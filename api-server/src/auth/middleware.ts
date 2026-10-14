import { parseCookies } from 'better-auth/cookies';
import type { Context, MiddlewareHandler } from 'hono';
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

const MULTI_SESSION_COOKIE_MARKER = '_multi-';

function setCookieName(setCookie: string) {
    return setCookie.slice(0, setCookie.indexOf('='));
}

/**
 * Renew only cookies the browser already holds (never plant a multi-session cookie the device
 * lacks). The main session cookie is renewed only on a device without multi-session cookies: a
 * device that has them pivots the main cookie between accounts via `set-active` under the client's
 * session gate, and this ungated response landing after a pivot would point it back at the previous
 * account. A `_multi-<token>` name belongs to one session, so a late write of it is harmless.
 */
function isSafeToForward(setCookie: string, heldCookieNames: string[]) {
    const name = setCookieName(setCookie);
    const isPivotingDevice = heldCookieNames.some((held) => held.includes(MULTI_SESSION_COOKIE_MARKER));
    return heldCookieNames.includes(name) && (name.includes(MULTI_SESSION_COOKIE_MARKER) || !isPivotingDevice);
}

/**
 * When `getSession` slides the session's expiry (once per `updateAge`), Better Auth emits fresh
 * Set-Cookie headers for the session cookie and its multi-session companion. An `auth.api` call
 * would drop them, leaving the browser cookies on their sign-in expiry while the DB session lives
 * on. Sync re-issues cookies through `/multi-session/set-active`, but skips it for a lone account
 * with no multi-session cookie — so that device was signed out a fixed time after sign-in.
 */
function forwardRefreshedSessionCookies(c: Context, sessionHeaders: Headers | null) {
    const heldCookieNames = [...parseCookies(c.req.header('cookie') ?? '').keys()];
    (sessionHeaders?.getSetCookie() ?? [])
        .filter((setCookie) => isSafeToForward(setCookie, heldCookieNames))
        .forEach((setCookie) => {
            c.header('Set-Cookie', setCookie, { append: true });
        });
}

export const authenticateRequest: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    const { headers: sessionHeaders, response: session } = await auth.api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
    if (!session) {
        return c.json({ error: 'Unauthorized: No session' }, 401);
    }

    c.set('session', session);
    forwardRefreshedSessionCookies(c, sessionHeaders);

    // Track which (device, user) pairs are alive so reads of "all devices for user X"
    // and pushes after sign-out can stay correct without scanning every Better Auth session.
    const deviceId = c.req.header(DEVICE_ID_HEADER);
    if (deviceId) {
        recordDeviceUserSeen(deviceId, session.user.id);
    }

    await next();
    return; // noImplicitReturns requires explicit return after next()
};
