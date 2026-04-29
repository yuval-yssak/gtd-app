/** Tests for /push routes. Focus is on the new GET /push/status endpoint plus the deviceUsers
 *  side-effect of POST /push/subscribe — both introduced for the multi-account device join. */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { pushRoutes } from '../routes/push.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/push', pushRoutes);

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
        db.collection('pushSubscriptions').deleteMany({}),
        db.collection('deviceUsers').deleteMany({}),
    ]);
    vi.restoreAllMocks();
});

async function loginAsAlice(): Promise<{ cookie: string; userId: string }> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    if (!sessionCookie) {
        throw new Error('Failed to obtain session cookie');
    }
    const sessionRes = await app.fetch(
        new Request('http://localhost:4000/auth/get-session', {
            headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
        }),
    );
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    return { cookie: sessionCookie, userId: user.id };
}

// Direct fetch with explicit X-Device-Id — authenticatedRequest does not set arbitrary headers.
async function statusRequest(sessionCookie: string, deviceId: string | undefined): Promise<Response> {
    const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${sessionCookie}` };
    if (deviceId !== undefined) {
        headers['X-Device-Id'] = deviceId;
    }
    return app.fetch(new Request('http://localhost:4000/push/status', { headers }));
}

describe('GET /push/status', () => {
    it('returns { registered: true } when a pushSubscriptions row exists for the deviceId', async () => {
        const alice = await loginAsAlice();
        await pushSubscriptionsDAO.upsert({
            _id: 'dev-1',
            user: alice.userId,
            endpoint: 'https://push.example/endpoint',
            keys: { p256dh: 'p', auth: 'a' },
            updatedTs: dayjs().toISOString(),
        });

        const res = await statusRequest(alice.cookie, 'dev-1');

        expect(res.status).toBe(200);
        const body = (await res.json()) as { registered: boolean };
        expect(body.registered).toBe(true);
    });

    it('returns { registered: false } when no pushSubscriptions row exists for the deviceId', async () => {
        const alice = await loginAsAlice();

        const res = await statusRequest(alice.cookie, 'dev-not-registered');

        expect(res.status).toBe(200);
        const body = (await res.json()) as { registered: boolean };
        expect(body.registered).toBe(false);
    });

    it('rejects unauthenticated requests with 401', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/push/status', { headers: { 'X-Device-Id': 'dev-1' } }));
        expect(res.status).toBe(401);
    });

    it('returns 400 when X-Device-Id is missing', async () => {
        const alice = await loginAsAlice();
        const res = await statusRequest(alice.cookie, undefined);
        expect(res.status).toBe(400);
    });
});

describe('POST /push/subscribe — deviceUsers upsert side-effect', () => {
    it('upserts a (deviceId, userId) row when a subscription is created', async () => {
        const alice = await loginAsAlice();

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/push/subscribe',
            sessionCookie: alice.cookie,
            body: {
                deviceId: 'dev-new',
                endpoint: 'https://push.example/endpoint-new',
                keys: { p256dh: 'p', auth: 'a' },
            },
        });

        expect(res.status).toBe(200);
        const join = await db.collection('deviceUsers').findOne({ _id: `dev-new:${alice.userId}` });
        expect(join?.deviceId).toBe('dev-new');
        expect(join?.userId).toBe(alice.userId);
    });
});
