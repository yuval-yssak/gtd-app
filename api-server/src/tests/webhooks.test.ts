/** Webhook subscription routes (issue #19 step 8) — POST/GET/DELETE /v1/webhooks. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ItemsRoutes } from '../routes/v1/items.js';
import { WEBHOOK_SUBSCRIPTION_CAP_PER_USER, webhookRoutes } from '../routes/webhooks.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/v1', v1ItemsRoutes)
    .route('/v1/webhooks', webhookRoutes);

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
        db.collection('apiTokens').deleteMany({}),
        db.collection('webhookSubscriptions').deleteMany({}),
        db.collection('webhookDeliveries').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

async function login(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    const sessionRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    return user.id;
}

async function tokenWithScope(userId: string, scopes: string[] = ['webhooks.manage']): Promise<string> {
    const { plaintext } = await issueApiToken(userId, 't', scopes as never);
    return plaintext;
}

async function postSub(plaintext: string, body: unknown): Promise<Response> {
    return app.fetch(
        new Request('http://localhost:4000/v1/webhooks', {
            method: 'POST',
            headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

describe('POST /v1/webhooks', () => {
    it('creates a subscription with secret, url, events; secret is shown once', async () => {
        const userId = await login();
        const token = await tokenWithScope(userId);
        const res = await postSub(token, { url: 'https://hooks.example/path', events: ['item.created'] });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { id: string; url: string; events: string[]; secret: string; createdTs: string };
        expect(body.url).toBe('https://hooks.example/path');
        expect(body.events).toEqual(['item.created']);
        expect(body.secret.length).toBeGreaterThan(20);

        // GET response excludes the secret.
        const list = await app.fetch(new Request('http://localhost:4000/v1/webhooks', { headers: { Authorization: `Bearer ${token}` } }));
        const listBody = (await list.json()) as { subscriptions: Array<Record<string, unknown>> };
        expect(listBody.subscriptions[0]).not.toHaveProperty('secret');
        expect(listBody.subscriptions[0]).not.toHaveProperty('user');
    });

    it('rejects URLs with non-http(s) schemes', async () => {
        const userId = await login();
        const token = await tokenWithScope(userId);
        const res = await postSub(token, { url: 'file:///etc/passwd', events: ['item.created'] });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_url');
    });

    it('rejects unknown event names', async () => {
        const userId = await login();
        const token = await tokenWithScope(userId);
        const res = await postSub(token, { url: 'https://hooks.example', events: ['item.exploded'] });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_events');
    });

    it('rejects empty events array', async () => {
        const userId = await login();
        const token = await tokenWithScope(userId);
        const res = await postSub(token, { url: 'https://hooks.example', events: [] });
        expect(res.status).toBe(400);
    });

    it('returns 403 when token lacks webhooks.manage scope', async () => {
        const userId = await login();
        const token = await tokenWithScope(userId, ['items.capture']);
        const res = await postSub(token, { url: 'https://hooks.example', events: ['item.created'] });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { code: string }).code).toBe('forbidden_scope');
    });

    it('enforces the per-user subscription cap', async () => {
        const userId = await login();
        const token = await tokenWithScope(userId);
        for (let i = 0; i < WEBHOOK_SUBSCRIPTION_CAP_PER_USER; i++) {
            const res = await postSub(token, { url: `https://hooks.example/${i}`, events: ['item.created'] });
            expect(res.status).toBe(200);
        }
        const overflow = await postSub(token, { url: 'https://hooks.example/cap', events: ['item.created'] });
        expect(overflow.status).toBe(429);
        expect(((await overflow.json()) as { code: string }).code).toBe('subscription_cap_reached');
    });
});

describe('DELETE /v1/webhooks/:id', () => {
    it('deletes the subscription for the caller', async () => {
        const userId = await login();
        const token = await tokenWithScope(userId);
        const create = await postSub(token, { url: 'https://hooks.example', events: ['item.created'] });
        const { id } = (await create.json()) as { id: string };

        const del = await app.fetch(
            new Request(`http://localhost:4000/v1/webhooks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }),
        );
        expect(del.status).toBe(200);

        const list = await app.fetch(new Request('http://localhost:4000/v1/webhooks', { headers: { Authorization: `Bearer ${token}` } }));
        const body = (await list.json()) as { subscriptions: unknown[] };
        expect(body.subscriptions).toEqual([]);
    });

    it("returns 404 when deleting another user's subscription", async () => {
        const aliceId = await login();
        const aliceToken = await tokenWithScope(aliceId);
        const create = await postSub(aliceToken, { url: 'https://hooks.example', events: ['item.created'] });
        const { id } = (await create.json()) as { id: string };

        const bobSession = (await oauthLogin(app, 'github', { email: 'bob@example.com', login: 'bob-gh' })).sessionCookie!;
        const bobUserRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${bobSession}` } }));
        const bobUser = ((await bobUserRes.json()) as { user: { id: string } }).user;
        const bobToken = await tokenWithScope(bobUser.id);
        const cross = await app.fetch(
            new Request(`http://localhost:4000/v1/webhooks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${bobToken}` } }),
        );
        expect(cross.status).toBe(404);
    });
});
