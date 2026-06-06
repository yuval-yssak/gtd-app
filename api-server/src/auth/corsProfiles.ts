import { cors } from 'hono/cors';
import { clientUrl } from '../config.js';

/**
 * Two CORS profiles, applied per-router rather than globally:
 *
 *   - `strictCors()` — for cookie-authenticated routes (sync, push, devices, calendar, auth/*,
 *     account/tokens). Restricts `Origin` to the SPA's `clientUrl` in production so a malicious
 *     site cannot ride an authenticated user's session cookie cross-origin. Sends
 *     `Access-Control-Allow-Credentials: true` so the SPA can include the Better Auth cookie.
 *
 *   - `publicCors()` — for the public bearer-authed `/v1/*` API. Allows any origin because the
 *     bearer token is the auth gate; cross-origin restriction adds no security and would block
 *     legitimate browser-based callers (Raycast extensions, static dashboards, tampermonkey
 *     scripts, custom React frontends). `credentials: false` because /v1 doesn't read or set
 *     cookies — bearer header travels independently.
 *
 * Splitting the profiles per-router keeps the policy decisions next to the routes they affect
 * and avoids a path-prefix branch inside a single global cors() factory.
 */

export function strictCors() {
    return cors({
        // Dev: echo any origin (useful for tools like webhook.site, ngrok). Prod: SPA only.
        origin: (origin) => (process.env.NODE_ENV !== 'production' ? origin : origin === clientUrl ? origin : null),
        credentials: true,
        // X-Device-Id lets the auth middleware track which devices host which accounts.
        // Authorization remains in the allowlist so the dev console / fetch helpers can attach it
        // to cookie-authed calls without preflight errors.
        allowHeaders: ['Content-Type', 'X-Device-Id', 'Authorization'],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    });
}

export function publicCors() {
    return cors({
        origin: '*',
        credentials: false,
        allowHeaders: ['Authorization', 'Content-Type'],
        // Public API only exposes GET, POST, and PATCH. Listing all of them so a future PATCH
        // endpoint (issue #19 step 7) doesn't fail preflight.
        allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    });
}

/**
 * CORS for the Claude-assist routes (`/v1/claude/*`) — the FIRST credentialed CORS profile on `/v1`.
 *
 * These routes are dual-auth (`authenticateBearerOrSession`): the first-party SPA reaches them with
 * its Better Auth session cookie, which requires `Access-Control-Allow-Credentials: true` and a
 * SPECIFIC allowed origin (the wildcard `*` is illegal alongside credentials).
 *
 * The session cookie is `sameSite: 'none'` in production (SPA and API live on different domains —
 * see `betterAuth.ts`), so it DOES ride cross-site. We therefore pin the allowed origin to the SPA's
 * `clientUrl` in production — exactly as `strictCors` does — so a malicious origin cannot make a
 * credentialed request that rides the victim's session and reads the response (the proposal + minted
 * `executeToken`). Bearer callers are unaffected: they carry no cookie, so a pinned/absent
 * Allow-Origin doesn't gate them (the browser only enforces CORS for cookie-bearing reads, and a
 * server-to-server bearer caller isn't a browser). Dev echoes any origin for local tooling.
 */
export function assistCors() {
    return cors({
        origin: (origin) => (process.env.NODE_ENV !== 'production' ? origin : origin === clientUrl ? origin : null),
        credentials: true,
        allowHeaders: ['Authorization', 'Content-Type', 'X-Device-Id'],
        allowMethods: ['POST', 'OPTIONS'],
    });
}
