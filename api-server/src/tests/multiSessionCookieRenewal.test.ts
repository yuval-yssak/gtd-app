import { generateId } from 'better-auth';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';
import { authenticateRequest } from '../auth/middleware.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { AuthVariables } from '../types/authTypes.js';
import { signSessionToken } from './helpers.js';

// Forges Better Auth sessions + signed multi-session cookies so the real multiSession plugin, our
// after-hook and the auth middleware all run against a genuine cookie set.

const app = new Hono<{ Variables: AuthVariables }>()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .get('/protected', authenticateRequest, (c) => c.json({ userId: c.get('session').user.id }));

const DAY_SECONDS = 24 * 60 * 60;
// Inside the refresh window (expiresIn 7d − updateAge 1d), so the next getSession slides the session.
const DAYS_LEFT_NEEDING_REFRESH = 1;
// Outside the refresh window — getSession leaves the session (and its cookies) alone.
const DAYS_LEFT_FRESH = 6.9;

beforeAll(async () => {
    await loadDataAccess('gtd_test_multi_session_cookie_renewal');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('user').deleteMany({}), db.collection('session').deleteMany({})]);
});

interface SeededSession {
    rawToken: string;
    signedToken: string;
}

/** The Better Auth `session` row fields this file seeds and reads back. */
interface StoredSession {
    _id: string;
    userId: string;
    token: string;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

/** Inserts a user plus a session expiring `expiresInDays` from now. */
async function seedSession(email: string, expiresInDays: number): Promise<SeededSession> {
    const userId = generateId(32);
    const rawToken = generateId(32);
    const now = dayjs();
    await db.collection('user').insertOne({ _id: userId, email, name: email, emailVerified: false, createdAt: now.toDate(), updatedAt: now.toDate() } as never);
    await db.collection<StoredSession>('session').insertOne({
        _id: generateId(32),
        userId,
        token: rawToken,
        // Seconds, not calendar days: a 'day' add across a DST change shifts the expiry by an hour.
        expiresAt: now.add(expiresInDays * DAY_SECONDS, 'second').toDate(),
        createdAt: now.toDate(),
        updatedAt: now.toDate(),
    });
    return { rawToken, signedToken: signSessionToken(rawToken) };
}

function multiCookieName(session: SeededSession) {
    return `${SESSION_COOKIE_NAME}_multi-${session.rawToken.toLowerCase()}`;
}

/** The browser's cookie jar: `active` in the main cookie, each of `held` in its multi cookie. */
function cookieHeader(active: SeededSession, held: SeededSession[]) {
    return [`${SESSION_COOKIE_NAME}=${active.signedToken}`, ...held.map((s) => `${multiCookieName(s)}=${s.signedToken}`)].join('; ');
}

function request(path: string, cookies: string, body?: unknown) {
    const init =
        body === undefined
            ? { headers: { Cookie: cookies } }
            : { method: 'POST', headers: { Cookie: cookies, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return app.fetch(new Request(`http://localhost:4000${path}`, init));
}

/** Every Max-Age the response writes for `name`, in header order — the browser applies the last. */
function setCookieMaxAges(res: Response, name: string) {
    return res.headers
        .getSetCookie()
        .filter((h) => h.startsWith(`${name}=`))
        .map((h) => {
            const match = /Max-Age=(-?\d+)/i.exec(h);
            if (!match?.[1]) {
                throw new Error(`Set-Cookie for ${name} has no Max-Age: ${h}`);
            }
            return Number(match[1]);
        });
}

/** The one Max-Age the response writes for `name`; fails when it is written zero or several times. */
function onlySetCookieMaxAge(res: Response, name: string) {
    const maxAges = setCookieMaxAges(res, name);
    expect(maxAges).toHaveLength(1);
    const [maxAge] = maxAges;
    if (maxAge === undefined) {
        throw new Error(`expected one Set-Cookie for ${name}`);
    }
    return maxAge;
}

describe('multi-session cookie renewal (Better Auth after-hook)', () => {
    it('set-active re-issues the target account’s multi cookie with the session’s remaining lifetime', async () => {
        const alice = await seedSession('alice@example.com', 30);
        const bob = await seedSession('bob@example.com', 60);

        const res = await request('/auth/multi-session/set-active', cookieHeader(alice, [alice, bob]), { sessionToken: bob.rawToken });

        expect(res.status).toBe(200);
        const maxAge = onlySetCookieMaxAge(res, multiCookieName(bob));
        expect(maxAge).toBeGreaterThan(60 * DAY_SECONDS - 60);
        expect(maxAge).toBeLessThanOrEqual(60 * DAY_SECONDS);
        // Only the pivot target is renewed — the other account renews on its own pivot.
        expect(setCookieMaxAges(res, multiCookieName(alice))).toEqual([]);
    });

    it('the get-session refresh slides the session to 7 days and renews its multi cookie to match', async () => {
        const alice = await seedSession('alice@example.com', DAYS_LEFT_NEEDING_REFRESH);

        const res = await request('/auth/get-session', cookieHeader(alice, [alice]));

        expect(res.status).toBe(200);
        const stored = await db.collection<StoredSession>('session').findOne({ token: alice.rawToken });
        expect(dayjs(stored?.expiresAt).diff(dayjs(), 'second')).toBeGreaterThan(7 * DAY_SECONDS - 60);
        expect(onlySetCookieMaxAge(res, multiCookieName(alice))).toBeGreaterThan(7 * DAY_SECONDS - 60);
    });

    it('leaves a multi cookie the browser does not hold to the plugin (written once, not twice)', async () => {
        const alice = await seedSession('alice@example.com', DAYS_LEFT_NEEDING_REFRESH);

        const res = await request('/auth/get-session', cookieHeader(alice, []));

        expect(res.status).toBe(200);
        expect(onlySetCookieMaxAge(res, multiCookieName(alice))).toBeGreaterThan(7 * DAY_SECONDS - 60);
    });

    it('revoking the active account keeps its cookie expired and renews the account that takes over', async () => {
        const alice = await seedSession('alice@example.com', 30);
        const bob = await seedSession('bob@example.com', 60);

        const res = await request('/auth/multi-session/revoke', cookieHeader(alice, [alice, bob]), { sessionToken: alice.rawToken });

        expect(res.status).toBe(200);
        expect(onlySetCookieMaxAge(res, multiCookieName(alice))).toBe(0);
        expect(onlySetCookieMaxAge(res, multiCookieName(bob))).toBeGreaterThan(59 * DAY_SECONDS);
    });

    it('does not resurrect the cookie of a revoked session that the same request refreshed', async () => {
        // revoke's sessionMiddleware refreshes alice (so newSession = alice), then the handler deletes
        // her and expires her multi cookie. With no other session left, newSession still names her.
        const alice = await seedSession('alice@example.com', DAYS_LEFT_NEEDING_REFRESH);

        const res = await request('/auth/multi-session/revoke', cookieHeader(alice, [alice]), { sessionToken: alice.rawToken });

        expect(res.status).toBe(200);
        expect(setCookieMaxAges(res, multiCookieName(alice))).toEqual([0]);
    });
});

describe('authenticateRequest forwards refreshed session cookies', () => {
    it('renews a lone account’s session cookie when the request slides the session', async () => {
        const alice = await seedSession('alice@example.com', DAYS_LEFT_NEEDING_REFRESH);

        const res = await request('/protected', cookieHeader(alice, []));

        expect(res.status).toBe(200);
        expect(onlySetCookieMaxAge(res, SESSION_COOKIE_NAME)).toBeGreaterThan(7 * DAY_SECONDS - 60);
        // The plugin's companion-cookie write is not forwarded: renew what the browser holds, never add.
        expect(setCookieMaxAges(res, multiCookieName(alice))).toEqual([]);
    });

    it('on a multi-session device renews only the multi cookie, never the pivoted main cookie', async () => {
        // The main cookie is pivoted under the client's session gate; a late ungated write could undo a pivot.
        const alice = await seedSession('alice@example.com', DAYS_LEFT_NEEDING_REFRESH);
        const bob = await seedSession('bob@example.com', 30);

        const res = await request('/protected', cookieHeader(alice, [alice, bob]));

        expect(res.status).toBe(200);
        expect(setCookieMaxAges(res, SESSION_COOKIE_NAME)).toEqual([]);
        expect(onlySetCookieMaxAge(res, multiCookieName(alice))).toBeGreaterThan(7 * DAY_SECONDS - 60);
        expect(setCookieMaxAges(res, multiCookieName(bob))).toEqual([]);
    });

    it('writes no cookies while the session is outside the refresh window', async () => {
        const alice = await seedSession('alice@example.com', DAYS_LEFT_FRESH);

        const res = await request('/protected', cookieHeader(alice, [alice]));

        expect(res.status).toBe(200);
        expect(res.headers.getSetCookie()).toEqual([]);
    });
});
