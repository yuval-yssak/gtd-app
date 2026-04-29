import { createHmac } from 'node:crypto';
import { generateId } from 'better-auth';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';
import { auth, db } from '../loaders/mainLoader.js';

// Guard: this module must never be loaded in production — throw immediately if it slips through.
// The dynamic import in index.ts already prevents this; this is a belt-and-suspenders check.
if (process.env.NODE_ENV === 'production') {
    throw new Error('devLogin route must not be loaded in production');
}

const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Replicates better-call's signCookieValue + encodeURIComponent wrapping.
// Format: encodeURIComponent("rawToken.base64(HMAC-SHA256(rawToken, secret))")
// Buffer.from(..., 'utf8') ensures encoding matches Web Crypto's TextEncoder used by Better Auth.
function signSessionToken(rawToken: string, secret: string): string {
    const sig = createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(rawToken, 'utf8')).digest('base64');
    return encodeURIComponent(`${rawToken}.${sig}`);
}

// Auth options are set before any request is served (loadDataAccess runs first).
function readAuthSecret(): string {
    return (
        (auth as unknown as { options: { secret?: string } }).options?.secret ?? process.env.BETTER_AUTH_SECRET ?? 'dev_better_auth_secret_change_in_production'
    );
}

// Shape of a user document as stored by the Better Auth MongoDB adapter.
interface StoredUser {
    _id: string;
    email: string;
}

// Atomic upsert user by email — reuse the existing ID so repeated logins share one user.
// Uses findOneAndUpdate to avoid a TOCTOU race when two devices log in concurrently
// with the same email (parallel loginAs calls in e2e tests).
async function getOrCreateUserId(normalizedEmail: string): Promise<string> {
    const userId = generateId(32);
    const now = dayjs().toDate();
    const result = await db.collection<StoredUser>('user').findOneAndUpdate(
        { email: normalizedEmail },
        {
            $setOnInsert: {
                _id: userId,
                name: normalizedEmail.split('@')[0],
                email: normalizedEmail,
                emailVerified: false,
                image: null,
                createdAt: now,
                updatedAt: now,
            } as never,
        },
        { upsert: true, returnDocument: 'after' },
    );
    if (!result) {
        throw new Error('Failed to create or retrieve user');
    }
    return result._id;
}

export const devLoginRoutes = new Hono()
    // POST /dev/login — upsert a user by email and create a valid Better Auth session.
    // Returns the signed cookie in both Set-Cookie (for browser-side use) and JSON body
    // (easier for the Playwright helper to parse into context.addCookies() format).
    .post('/login', async (c) => {
        const { email } = await c.req.json<{ email: string }>();
        const normalizedEmail = email.toLowerCase();

        const userId = await getOrCreateUserId(normalizedEmail);

        // Create a new session — rawToken is what goes into the signed cookie.
        const rawToken = generateId(32);
        const sessionId = generateId(32);
        const now = dayjs();
        const expiresAt = now.add(SESSION_EXPIRY_MS, 'ms');

        await db.collection('session').insertOne({
            _id: sessionId,
            userId,
            token: rawToken,
            // MongoDB stores these as BSON Date — .toDate() converts from dayjs
            expiresAt: expiresAt.toDate(),
            createdAt: now.toDate(),
            updatedAt: now.toDate(),
            ipAddress: '',
            userAgent: 'playwright-e2e',
        } as never);

        const signedToken = signSessionToken(rawToken, readAuthSecret());

        c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=${signedToken}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toDate().toUTCString()}`);

        return c.json({
            ok: true,
            userId,
            email: normalizedEmail,
            // Playwright's BrowserContext.addCookies() format — returned to avoid parsing Set-Cookie.
            cookie: {
                name: SESSION_COOKIE_NAME,
                value: signedToken,
                domain: 'localhost',
                path: '/',
                httpOnly: true,
                secure: false,
                sameSite: 'Lax' as const,
                expires: expiresAt.unix(), // Unix seconds for Playwright
            },
        });
    })

    // POST /dev/multi-login — produce cookies for *several* accounts on a single browser context.
    // Better Auth's multiSession plugin keeps additional sessions in `better-auth.session_token_multi-<token>`
    // cookies; the active session lives at `better-auth.session_token`. We mirror that format
    // so e2e tests can preload a context with two simultaneous accounts without driving the
    // OAuth + addAnotherAccount UI flow.
    .post('/multi-login', async (c) => {
        const { emails, activeIndex = 0 } = await c.req.json<{ emails: string[]; activeIndex?: number }>();
        if (!Array.isArray(emails) || emails.length === 0) {
            return c.json({ error: 'emails array required' }, 400);
        }
        if (activeIndex < 0 || activeIndex >= emails.length) {
            return c.json({ error: 'activeIndex out of range' }, 400);
        }

        const secret = readAuthSecret();
        const now = dayjs();
        const expiresAt = now.add(SESSION_EXPIRY_MS, 'ms');

        // Provision a fresh session for each email — userId is reused via the email upsert
        // so repeated calls for the same email don't create duplicate Better Auth users.
        const sessions = await Promise.all(
            emails.map(async (email) => {
                const normalizedEmail = email.toLowerCase();
                const userId = await getOrCreateUserId(normalizedEmail);
                const rawToken = generateId(32);
                const sessionId = generateId(32);
                await db.collection('session').insertOne({
                    _id: sessionId,
                    userId,
                    token: rawToken,
                    expiresAt: expiresAt.toDate(),
                    createdAt: now.toDate(),
                    updatedAt: now.toDate(),
                    ipAddress: '',
                    userAgent: 'playwright-e2e',
                } as never);
                return { email: normalizedEmail, userId, rawToken, signedToken: signSessionToken(rawToken, secret) };
            }),
        );

        // Cookie shape Playwright's BrowserContext.addCookies expects.
        const baseCookie = {
            domain: 'localhost',
            path: '/',
            httpOnly: true,
            secure: false,
            sameSite: 'Lax' as const,
            expires: expiresAt.unix(),
        };

        const active = sessions[activeIndex];
        if (!active) {
            // unreachable given the activeIndex validation above; satisfies noUncheckedIndexedAccess
            return c.json({ error: 'invalid activeIndex' }, 400);
        }

        // Each session also lives at `<sessionTokenName>_multi-<rawToken_lowercased>`. The cookie
        // value must be the SIGNED token (matches setSignedCookie behaviour in the multiSession hook).
        const cookies = [
            { ...baseCookie, name: SESSION_COOKIE_NAME, value: active.signedToken },
            ...sessions.map((s) => ({
                ...baseCookie,
                name: `${SESSION_COOKIE_NAME}_multi-${s.rawToken.toLowerCase()}`,
                value: s.signedToken,
            })),
        ];

        return c.json({
            ok: true,
            // Raw token included so e2e tests can pivot to a different session via Better Auth's
            // /auth/multi-session/set-active endpoint (which expects the raw, unsigned token).
            sessions: sessions.map((s) => ({ email: s.email, userId: s.userId, rawToken: s.rawToken })),
            cookies,
        });
    })

    // DELETE /dev/reset — wipe all collections so tests can start with a clean slate.
    .delete('/reset', async (c) => {
        await Promise.all([
            db.collection('user').deleteMany({}),
            db.collection('session').deleteMany({}),
            db.collection('items').deleteMany({}),
            db.collection('operations').deleteMany({}),
            db.collection('deviceSyncState').deleteMany({}),
            db.collection('routines').deleteMany({}),
            db.collection('people').deleteMany({}),
            db.collection('workContexts').deleteMany({}),
            db.collection('deviceUsers').deleteMany({}),
            db.collection('pushSubscriptions').deleteMany({}),
        ]);
        return c.json({ ok: true });
    })

    // GET /dev/device-users?deviceId=... — surface deviceUsers join rows so e2e specs can
    // assert which (deviceId, userId) pairs the server has recorded without reaching into
    // MongoDB directly. Auth-free because tests need to read the collection across sign-out
    // boundaries; safe because the route is only registered in non-production builds.
    .get('/device-users', async (c) => {
        const deviceId = c.req.query('deviceId');
        if (!deviceId) {
            return c.json({ error: 'deviceId query param required' }, 400);
        }
        const rows = await db.collection<{ _id: string; deviceId: string; userId: string }>('deviceUsers').find({ deviceId }).toArray();
        return c.json({ rows: rows.map((r) => ({ deviceId: r.deviceId, userId: r.userId })) });
    })

    // POST /dev/drop-push-subscription — simulate a server-side subscription loss so the
    // Settings page can be exercised against a {registered:false} response without going
    // through the actual 410-from-Apple-or-Google fan-out path.
    .post('/drop-push-subscription', async (c) => {
        const { deviceId } = await c.req.json<{ deviceId: string }>();
        if (!deviceId) {
            return c.json({ error: 'deviceId required' }, 400);
        }
        // `as never` on _id matches the pattern in pushSubscriptionsDAO — driver widens _id to ObjectId.
        await db.collection('pushSubscriptions').deleteOne({ _id: deviceId } as never);
        return c.json({ ok: true });
    });
