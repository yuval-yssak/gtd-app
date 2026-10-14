import { createAuthMiddleware } from 'better-auth/api';
import { parseCookies, parseSetCookieHeader } from 'better-auth/cookies';
import dayjs from 'dayjs';

/** The cookie headers of one auth request/response pair — what the renewal decision reads. */
interface CookieExchange {
    requestCookieHeader: string | null | undefined;
    responseSetCookieHeader: string | null | undefined;
}

/** Mirrors the name the multiSession plugin gives a session's companion cookie. */
function multiSessionCookieName(sessionCookieName: string, sessionToken: string) {
    return `${sessionCookieName}_multi-${sessionToken.toLowerCase()}`;
}

/**
 * Renew only a cookie the browser already holds — a sign-in (cookie not yet held) is the plugin's
 * own job, and its after-hook runs after ours. Never override a write already in the response:
 * `/multi-session/revoke` refreshes the active session in its sessionMiddleware (so `newSession`
 * names it), then deletes that session and expires its cookie; renewing would resurrect it.
 */
function isHeldAndNotRewritten(cookieName: string, { requestCookieHeader, responseSetCookieHeader }: CookieExchange) {
    const isHeld = parseCookies(requestCookieHeader ?? '').has(cookieName);
    const isRewritten = parseSetCookieHeader(responseSetCookieHeader ?? '').has(cookieName);
    return isHeld && !isRewritten;
}

function remainingLifetimeSeconds(expiresAt: Date) {
    return Math.max(0, dayjs(expiresAt).diff(dayjs(), 'second'));
}

/**
 * Better Auth after-hook. The multiSession plugin writes `<session cookie>_multi-<token>` once, at
 * sign-in, with a fixed max-age, and never refreshes it — yet `/multi-session/set-active` (which the
 * client calls to pivot to each account on every sync pass) and `list-device-sessions` both require
 * it. So every account on a device was silently signed out a fixed time after its sign-in, however
 * actively it was used, while its DB session was still valid. Whenever Better Auth (re)issues a
 * session cookie — set-active, the daily get-session refresh — re-issue the companion cookie too,
 * matching the DB session's remaining lifetime.
 */
export const renewMultiSessionCookie = createAuthMiddleware(async (ctx) => {
    const session = ctx.context.newSession;
    if (!session) {
        return;
    }
    const sessionCookie = ctx.context.authCookies.sessionToken;
    const cookieName = multiSessionCookieName(sessionCookie.name, session.session.token);
    const exchange = { requestCookieHeader: ctx.headers?.get('cookie'), responseSetCookieHeader: ctx.context.responseHeaders?.get('set-cookie') };
    if (!isHeldAndNotRewritten(cookieName, exchange)) {
        return;
    }
    await ctx.setSignedCookie(cookieName, session.session.token, ctx.context.secret, {
        ...sessionCookie.attributes,
        maxAge: remainingLifetimeSeconds(session.session.expiresAt),
    });
});
