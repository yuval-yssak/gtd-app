/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { createHmac } from 'node:crypto';
import { generateId } from 'better-auth';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { calendarRoutes } from '../routes/calendar.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface } from '../types/entities.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/calendar', calendarRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test_all_sync_configs');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('user').deleteMany({}),
        db.collection('session').deleteMany({}),
        db.collection('calendarIntegrations').deleteMany({}),
        db.collection('calendarSyncConfigs').deleteMany({}),
    ]);
});

// ── Multi-session cookie helpers ───────────────────────────────────────────────
//
// The /calendar/all-sync-configs endpoint authenticates via the standard middleware,
// then reads every "device session" via auth.api.listDeviceSessions which scans
// `<sessionTokenName>_multi-<rawToken>` cookies. To exercise multi-account behaviour
// without driving the OAuth UI, we build signed multi-session cookies the same way
// devLogin.ts does — keeps the test self-contained and avoids reaching across modules.

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

/** Builds a single Cookie header carrying both an active-session cookie and a multi-session cookie per emitted session. */
function buildMultiSessionCookieHeader(active: SeedSessionResult, all: SeedSessionResult[]): string {
    const pairs = [
        `${SESSION_COOKIE_NAME}=${active.signedToken}`,
        ...all.map((s) => `${SESSION_COOKIE_NAME}_multi-${s.rawToken.toLowerCase()}=${s.signedToken}`),
    ];
    return pairs.join('; ');
}

async function fetchAllSyncConfigs(cookieHeader: string): Promise<Response> {
    return app.fetch(
        new Request('http://localhost:4000/calendar/all-sync-configs', {
            headers: { Cookie: cookieHeader },
        }),
    );
}

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makeIntegration(userId: string, overrides: Partial<CalendarIntegrationInterface> = {}): CalendarIntegrationInterface {
    const now = dayjs().toISOString();
    return {
        _id: generateId(16),
        user: userId,
        provider: 'google',
        // Plaintext secrets are fine in tests because we never round-trip them through GCal.
        accessToken: 'at',
        refreshToken: 'rt',
        tokenExpiry: now,
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

function makeSyncConfig(userId: string, integrationId: string, overrides: Partial<CalendarSyncConfigInterface> = {}): CalendarSyncConfigInterface {
    const now = dayjs().toISOString();
    return {
        _id: generateId(16),
        integrationId,
        user: userId,
        calendarId: 'primary',
        isDefault: true,
        enabled: true,
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GET /calendar/all-sync-configs', () => {
    it('returns 401 when unauthenticated', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/calendar/all-sync-configs'));
        expect(res.status).toBe(401);
    });

    it('aggregates integrations + sync configs across two device sessions', async () => {
        const alice = await seedUserSession('alice@example.com');
        const bob = await seedUserSession('bob@example.com');

        const aliceIntegration = makeIntegration(alice.userId, { _id: 'int-a' });
        await calendarIntegrationsDAO.insertEncrypted(aliceIntegration);
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(alice.userId, 'int-a', { _id: 'cfg-a-primary', displayName: 'Primary' }));
        await calendarSyncConfigsDAO.insertOne(
            makeSyncConfig(alice.userId, 'int-a', { _id: 'cfg-a-holidays', calendarId: 'holidays', displayName: 'Holidays', isDefault: false }),
        );

        const bobIntegration = makeIntegration(bob.userId, { _id: 'int-b' });
        await calendarIntegrationsDAO.insertEncrypted(bobIntegration);
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(bob.userId, 'int-b', { _id: 'cfg-b-primary', displayName: 'Primary' }));

        const cookieHeader = buildMultiSessionCookieHeader(alice, [alice, bob]);
        const res = await fetchAllSyncConfigs(cookieHeader);
        expect(res.status).toBe(200);
        const bundles = (await res.json()) as Array<{
            userId: string;
            accountEmail: string;
            integrations: Array<{ _id: string; syncConfigs: Array<{ _id: string; displayName?: string }> }>;
        }>;
        expect(bundles).toHaveLength(2);
        const aliceBundle = bundles.find((b) => b.userId === alice.userId);
        const bobBundle = bundles.find((b) => b.userId === bob.userId);
        expect(aliceBundle?.accountEmail).toBe('alice@example.com');
        expect(bobBundle?.accountEmail).toBe('bob@example.com');
        expect(aliceBundle?.integrations).toHaveLength(1);
        expect(aliceBundle?.integrations[0]?.syncConfigs.map((c) => c._id).sort()).toEqual(['cfg-a-holidays', 'cfg-a-primary']);
        expect(bobBundle?.integrations[0]?.syncConfigs).toHaveLength(1);
    });

    it('strips access and refresh tokens from every integration in the response', async () => {
        const alice = await seedUserSession('alice@example.com');
        const integration = makeIntegration(alice.userId, { _id: 'int-1' });
        await calendarIntegrationsDAO.insertEncrypted(integration);
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(alice.userId, 'int-1'));

        const cookieHeader = buildMultiSessionCookieHeader(alice, [alice]);
        const res = await fetchAllSyncConfigs(cookieHeader);
        expect(res.status).toBe(200);
        const json = JSON.stringify(await res.json());
        expect(json).not.toContain('accessToken');
        expect(json).not.toContain('refreshToken');
    });

    it('returns a single bundle when only one session is present', async () => {
        const alice = await seedUserSession('alice@example.com');
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(alice.userId, { _id: 'int-1' }));
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(alice.userId, 'int-1'));

        const cookieHeader = buildMultiSessionCookieHeader(alice, [alice]);
        const res = await fetchAllSyncConfigs(cookieHeader);
        expect(res.status).toBe(200);
        const bundles = (await res.json()) as Array<{ userId: string; integrations: unknown[] }>;
        expect(bundles).toHaveLength(1);
        expect(bundles[0]?.userId).toBe(alice.userId);
    });

    it('returns an empty integrations array for users with no calendar connections', async () => {
        const alice = await seedUserSession('alice@example.com');

        const cookieHeader = buildMultiSessionCookieHeader(alice, [alice]);
        const res = await fetchAllSyncConfigs(cookieHeader);
        expect(res.status).toBe(200);
        const bundles = (await res.json()) as Array<{ userId: string; integrations: unknown[] }>;
        expect(bundles).toHaveLength(1);
        expect(bundles[0]?.integrations).toEqual([]);
    });
});
