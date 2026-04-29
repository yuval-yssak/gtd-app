/** biome-ignore-all lint/style/noNonNullAssertion: tests assert preconditions before using ! */
import { createHmac } from 'node:crypto';
import { generateId } from 'better-auth';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { syncRoutes } from '../routes/sync.js';

// Reuses the multi-session cookie-forging pattern from allSyncConfigs.test.ts so we can drive
// `auth.api.listDeviceSessions` directly without going through the OAuth UI. The SSE endpoint
// reads exactly the same cookie set the multiSession plugin reads, so this faithfully exercises
// production behaviour for the multi-account `?userId=` validation path.

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/sync', syncRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test_sync_events_auth');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('user').deleteMany({}), db.collection('session').deleteMany({})]);
});

// ── Multi-session cookie helpers (mirrors allSyncConfigs.test.ts) ───────────────

function signSessionToken(rawToken: string, secret: string): string {
    const sig = createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(rawToken, 'utf8')).digest('base64');
    return encodeURIComponent(`${rawToken}.${sig}`);
}

function readAuthSecret(): string {
    return (
        (auth as unknown as { options: { secret?: string } }).options?.secret ?? process.env.BETTER_AUTH_SECRET ?? 'dev_better_auth_secret_change_in_production'
    );
}

interface SeedSessionResult {
    userId: string;
    email: string;
    rawToken: string;
    signedToken: string;
}

async function seedUserSession(email: string): Promise<SeedSessionResult> {
    const userId = generateId(32);
    const rawToken = generateId(32);
    const sessionId = generateId(32);
    const now = dayjs();
    const expiresAt = now.add(30, 'day');
    await db.collection('user').insertOne({
        _id: userId,
        email,
        name: email.split('@')[0],
        emailVerified: false,
        image: null,
        createdAt: now.toDate(),
        updatedAt: now.toDate(),
    } as never);
    await db.collection('session').insertOne({
        _id: sessionId,
        userId,
        token: rawToken,
        expiresAt: expiresAt.toDate(),
        createdAt: now.toDate(),
        updatedAt: now.toDate(),
        ipAddress: '',
        userAgent: 'vitest',
    } as never);
    return { userId, email, rawToken, signedToken: signSessionToken(rawToken, readAuthSecret()) };
}

function buildMultiSessionCookieHeader(active: SeedSessionResult, all: SeedSessionResult[]): string {
    const pairs = [
        `${SESSION_COOKIE_NAME}=${active.signedToken}`,
        ...all.map((s) => `${SESSION_COOKIE_NAME}_multi-${s.rawToken.toLowerCase()}=${s.signedToken}`),
    ];
    return pairs.join('; ');
}

async function fetchSseStream(cookieHeader: string, query: string): Promise<Response> {
    return app.fetch(
        new Request(`http://localhost:4000/sync/events${query}`, {
            headers: { Cookie: cookieHeader },
        }),
    );
}

// Drains the initial SSE comment frame and cancels the stream so the request handler's
// abort hook can run cleanly. Without cancel, the fake-streamed response leaks.
async function drainAndCancel(res: Response): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) return;
    await reader.read();
    await reader.cancel();
}

describe('GET /sync/events?userId=', () => {
    it('falls back to the active session when ?userId is absent', async () => {
        const alice = await seedUserSession('alice@example.com');
        const cookieHeader = buildMultiSessionCookieHeader(alice, [alice]);

        const res = await fetchSseStream(cookieHeader, '');
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/event-stream');
        await drainAndCancel(res);
    });

    it('accepts ?userId matching the active session', async () => {
        const alice = await seedUserSession('alice@example.com');
        const cookieHeader = buildMultiSessionCookieHeader(alice, [alice]);

        const res = await fetchSseStream(cookieHeader, `?userId=${alice.userId}`);
        expect(res.status).toBe(200);
        await drainAndCancel(res);
    });

    it('accepts ?userId of a non-active session that lives on this device', async () => {
        // Alice is the active session; Bob is the secondary multi-session. The endpoint must
        // accept either id because the device hosts both — a multi-account tab opens N channels.
        const alice = await seedUserSession('alice@example.com');
        const bob = await seedUserSession('bob@example.com');
        const cookieHeader = buildMultiSessionCookieHeader(alice, [alice, bob]);

        const res = await fetchSseStream(cookieHeader, `?userId=${bob.userId}`);
        expect(res.status).toBe(200);
        await drainAndCancel(res);
    });

    it('rejects with 403 when ?userId is not a session on this device', async () => {
        const alice = await seedUserSession('alice@example.com');
        // Bob exists in the DB but his session cookie is NOT included on this device.
        const bob = await seedUserSession('bob@example.com');
        const cookieHeaderWithoutBob = buildMultiSessionCookieHeader(alice, [alice]);

        const res = await fetchSseStream(cookieHeaderWithoutBob, `?userId=${bob.userId}`);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('Forbidden');
    });

    it('returns 401 when the request has no session cookie at all', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/sync/events?userId=anything'));
        expect(res.status).toBe(401);
    });
});
