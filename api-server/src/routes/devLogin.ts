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
        ]);
        return c.json({ ok: true });
    });
