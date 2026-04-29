/** Tests for POST /devices/signout — the endpoint the client calls before Better Auth's signOut
 *  to drop the (deviceId, currentUserId) join row so push fan-out for the about-to-be-signed-out
 *  account stops targeting this device. */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { deviceRoutes } from '../routes/devices.js';
import { authenticatedRequest, oauthLogin } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/devices', deviceRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('user').deleteMany({}),
        db.collection('session').deleteMany({}),
        db.collection('account').deleteMany({}),
        db.collection('verification').deleteMany({}),
        db.collection('deviceUsers').deleteMany({}),
    ]);
    vi.restoreAllMocks();
});

async function loginAsAlice(): Promise<{ cookie: string; userId: string }> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    if (!sessionCookie) {
        throw new Error('Failed to obtain session cookie for Alice');
    }
    const sessionRes = await app.fetch(
        new Request('http://localhost:4000/auth/get-session', {
            headers: { Cookie: `better-auth.session_token=${sessionCookie}` },
        }),
    );
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    return { cookie: sessionCookie, userId: user.id };
}

async function loginAsBob(): Promise<{ cookie: string; userId: string }> {
    // GitHub provider with an unrelated email so Bob is a distinct Better Auth user
    const { sessionCookie } = await oauthLogin(app, 'github', { email: 'bob@example.com', login: 'bob-gh' });
    if (!sessionCookie) {
        throw new Error('Failed to obtain session cookie for Bob');
    }
    const sessionRes = await app.fetch(
        new Request('http://localhost:4000/auth/get-session', {
            headers: { Cookie: `better-auth.session_token=${sessionCookie}` },
        }),
    );
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    return { cookie: sessionCookie, userId: user.id };
}

describe('POST /devices/signout', () => {
    it('removes only the active user’s (deviceId, userId) row and leaves other users intact', async () => {
        const alice = await loginAsAlice();
        vi.restoreAllMocks();
        const bob = await loginAsBob();

        // Both accounts share the same device — model the multi-account scenario
        await deviceUsersDAO.upsert('dev-shared', alice.userId);
        await deviceUsersDAO.upsert('dev-shared', bob.userId);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/devices/signout',
            sessionCookie: alice.cookie,
            body: { deviceId: 'dev-shared' },
        });

        expect(res.status).toBe(200);
        // Alice's row is gone; Bob's row remains
        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'dev-shared', userId: alice.userId })).toBe(0);
        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'dev-shared', userId: bob.userId })).toBe(1);
    });

    it('returns 200 even when no row exists (idempotent — safe to retry)', async () => {
        const alice = await loginAsAlice();

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/devices/signout',
            sessionCookie: alice.cookie,
            body: { deviceId: 'dev-not-seen-before' },
        });

        expect(res.status).toBe(200);
    });

    it('rejects unauthenticated requests with 401', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/devices/signout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId: 'dev-x' }),
            }),
        );
        expect(res.status).toBe(401);
    });

    it('returns 400 when deviceId is missing from the body', async () => {
        const alice = await loginAsAlice();

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/devices/signout',
            sessionCookie: alice.cookie,
            body: {},
        });

        expect(res.status).toBe(400);
    });

    it('does not touch rows for other devices when removing one device’s row', async () => {
        const alice = await loginAsAlice();
        await deviceUsersDAO.upsert('dev-phone', alice.userId);
        await deviceUsersDAO.upsert('dev-laptop', alice.userId);

        await authenticatedRequest(app, {
            method: 'POST',
            path: '/devices/signout',
            sessionCookie: alice.cookie,
            body: { deviceId: 'dev-phone' },
        });

        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'dev-phone' })).toBe(0);
        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'dev-laptop' })).toBe(1);
    });
});
