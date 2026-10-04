/**
 * `routes/account.ts`: the unauthenticated tombstone probe (`GET /auth/user-status`), self-service
 * deletion (`DELETE /auth/me`) and the data export (`GET /export`). The app under test mounts the
 * account router BEFORE Better Auth's catch-all exactly as `index.ts` does, so the test also pins
 * that `/auth/user-status` is reachable at all.
 */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import deletedUsersDAO from '../dataAccess/deletedUsersDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { inventoriedCollectionNames } from '../lib/userDataInventory.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { accountRoutes, exportRoutes } from '../routes/account.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE, stubGoogleRevokeEndpoint } from './helpers.js';

const app = new Hono()
    .route('/auth', accountRoutes)
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/export', exportRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test_account_routes');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([...inventoriedCollectionNames()].map((name) => db.collection(name).deleteMany({})));
    vi.restoreAllMocks();
});

async function loginAsAlice(): Promise<{ cookie: string; userId: string }> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    if (!sessionCookie) {
        throw new Error('no session cookie');
    }
    const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await res.json()) as { user: { id: string } };
    return { cookie: sessionCookie, userId: user.id };
}

async function userStatus(userId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await app.fetch(new Request(`http://localhost:4000/auth/user-status?userId=${encodeURIComponent(userId)}`));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /auth/user-status', () => {
    it('reports an existing user as active — without any cookie', async () => {
        const { userId } = await loginAsAlice();
        expect(await userStatus(userId)).toEqual({ status: 200, body: { status: 'active' } });
    });

    it('reports a tombstoned user as deleted with the deletion time', async () => {
        await deletedUsersDAO.upsertTombstone({ _id: 'gone-user', deletedAt: '2026-10-04T12:00:00.000Z' });
        const { status, body } = await userStatus('gone-user');
        expect(status).toBe(200);
        expect(body).toEqual({ status: 'deleted', deletedAt: '2026-10-04T12:00:00.000Z' });
    });

    it('reports an id it has never seen as unknown', async () => {
        expect(await userStatus('never-existed')).toEqual({ status: 200, body: { status: 'unknown' } });
    });

    it('rejects a missing or oversized userId with 400', async () => {
        const missing = await app.fetch(new Request('http://localhost:4000/auth/user-status'));
        expect(missing.status).toBe(400);
        expect((await userStatus('x'.repeat(65))).status).toBe(400);
    });

    it('is rate-limited per client IP on the real route: the 121st probe within a minute gets 429', async () => {
        __resetDefaultStoreForTests();
        const probe = () => app.fetch(new Request('http://localhost:4000/auth/user-status?userId=anyone', { headers: { 'cf-connecting-ip': '203.0.113.9' } }));
        const statuses = await Promise.all(Array.from({ length: 120 }, probe)).then((responses) => responses.map((res) => res.status));
        expect(new Set(statuses)).toEqual(new Set([200]));
        const limited = await probe();
        expect(limited.status).toBe(429);
        expect(limited.headers.get('Retry-After')).toBeTruthy();
        // A different client IP has its own budget.
        const other = await app.fetch(new Request('http://localhost:4000/auth/user-status?userId=anyone', { headers: { 'cf-connecting-ip': '203.0.113.10' } }));
        expect(other.status).toBe(200);
        __resetDefaultStoreForTests();
    });
});

describe('DELETE /auth/me', () => {
    it('returns 401 without a session', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/auth/me', { method: 'DELETE' }));
        expect(res.status).toBe(401);
    });

    it('requires expectedUserId — an irreversible action must name the account it means', async () => {
        const { cookie, userId } = await loginAsAlice();
        const res = await authenticatedRequest(app, { method: 'DELETE', path: '/auth/me', sessionCookie: cookie });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('expected_user_id_required');
        expect((await userStatus(userId)).body).toEqual({ status: 'active' });
    });

    it('deletes the calling user, kills their session and leaves a tombstone the status probe reports', async () => {
        const { cookie, userId } = await loginAsAlice();
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({ _id: 'item-del-1', user: userId, status: 'inbox', title: 'mine', createdTs: now, updatedTs: now });
        stubGoogleRevokeEndpoint();

        const res = await authenticatedRequest(app, { method: 'DELETE', path: `/auth/me?expectedUserId=${encodeURIComponent(userId)}`, sessionCookie: cookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; deletedUserId: string; report: { deleted: Record<string, number> } };
        expect(body.ok).toBe(true);
        expect(body.deletedUserId).toBe(userId);
        expect(body.report.deleted.items).toBe(1);
        expect(body.report.deleted.user).toBe(1);

        expect(await itemsDAO.findArray({ user: userId })).toEqual([]);
        expect(await db.collection('user').countDocuments({ email: 'alice@example.com' })).toBe(0);
        expect((await userStatus(userId)).body).toMatchObject({ status: 'deleted' });
        // The session row went with the user: the same cookie no longer authenticates.
        const again = await authenticatedRequest(app, {
            method: 'DELETE',
            path: `/auth/me?expectedUserId=${encodeURIComponent(userId)}`,
            sessionCookie: cookie,
        });
        expect(again.status).toBe(401);
    });
});

describe('expectedUserId guard (cookie/IDB drift)', () => {
    it('DELETE /auth/me refuses with 409 and deletes nothing when expectedUserId is another account', async () => {
        const { cookie, userId } = await loginAsAlice();
        const res = await authenticatedRequest(app, { method: 'DELETE', path: '/auth/me?expectedUserId=some-other-account', sessionCookie: cookie });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: expect.any(String), code: 'session_mismatch', sessionUserId: userId });
        expect((await userStatus(userId)).body).toEqual({ status: 'active' });
    });

    it('DELETE /auth/me proceeds when expectedUserId matches the session', async () => {
        const { cookie, userId } = await loginAsAlice();
        stubGoogleRevokeEndpoint();
        const res = await authenticatedRequest(app, { method: 'DELETE', path: `/auth/me?expectedUserId=${encodeURIComponent(userId)}`, sessionCookie: cookie });
        expect(res.status).toBe(200);
        expect((await userStatus(userId)).body).toMatchObject({ status: 'deleted' });
    });

    it('GET /export refuses with 409 when expectedUserId is another account, and 400 when it is missing', async () => {
        const { cookie } = await loginAsAlice();
        const res = await authenticatedRequest(app, { method: 'GET', path: '/export?expectedUserId=some-other-account', sessionCookie: cookie });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe('session_mismatch');
        const missing = await authenticatedRequest(app, { method: 'GET', path: '/export', sessionCookie: cookie });
        expect(missing.status).toBe(400);
    });
});

describe('GET /export', () => {
    it('returns 401 without a session', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/export'));
        expect(res.status).toBe(401);
    });

    it('returns the user’s collections as a JSON attachment with credentials stripped', async () => {
        const { cookie, userId } = await loginAsAlice();
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({ _id: 'item-exp-1', user: userId, status: 'inbox', title: 'export me', createdTs: now, updatedTs: now });
        await itemsDAO.insertOne({ _id: 'item-exp-other', user: 'someone-else', status: 'inbox', title: 'not mine', createdTs: now, updatedTs: now });
        await apiTokensDAO.insertOne({ _id: 'tok-1', user: userId, tokenHash: 'secret-hash', label: 'cli', createdTs: now });
        await calendarIntegrationsDAO.insertEncrypted({
            _id: 'int-exp',
            user: userId,
            provider: 'google',
            accessToken: 'cal-at',
            refreshToken: 'cal-rt',
            tokenExpiry: now,
            createdTs: now,
            updatedTs: now,
        });
        await db.collection('operations').insertOne({ user: userId, entityType: 'item', opType: 'create', ts: now } as never);

        const res = await authenticatedRequest(app, { method: 'GET', path: `/export?expectedUserId=${encodeURIComponent(userId)}`, sessionCookie: cookie });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="done-export-\d{4}-\d{2}-\d{2}\.json"$/);
        const body = (await res.json()) as {
            format: string;
            user: { _id: string; email: string } | null;
            collections: Record<string, Array<Record<string, unknown>>>;
            omitted: Record<string, { reason: string; count: number }>;
        };
        expect(body.format).toBe('done-export/1');
        expect(body.user?.email).toBe('alice@example.com');
        expect(body.collections.items?.map((item) => item.title)).toEqual(['export me']);
        expect(body.collections.apiTokens).toEqual([expect.objectContaining({ _id: 'tok-1', label: 'cli' })]);
        expect(body.collections.apiTokens?.[0]).not.toHaveProperty('tokenHash');
        expect(body.collections.calendarIntegrations?.[0]).toMatchObject({ _id: 'int-exp', provider: 'google' });
        expect(body.collections.calendarIntegrations?.[0]).not.toHaveProperty('accessToken');
        expect(body.collections.calendarIntegrations?.[0]).not.toHaveProperty('refreshToken');
        // The Google sign-in tokens Better Auth stored for this login are stripped too.
        expect(body.collections.account?.[0]).not.toHaveProperty('accessToken');
        expect(body.collections.account?.[0]).not.toHaveProperty('refreshToken');
        expect(body.collections.account?.[0]).not.toHaveProperty('idToken');
        expect(body.collections.session?.[0]).not.toHaveProperty('token');
        expect(body.omitted.operations).toEqual({ reason: expect.any(String), count: 1 });
        // Nothing of the OTHER user's leaks.
        expect(JSON.stringify(body)).not.toContain('not mine');
        expect(JSON.stringify(body)).not.toContain('secret-hash');
    });
});
