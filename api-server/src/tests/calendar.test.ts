/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { google } from 'googleapis';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDeterministicGCalId, GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { applyEntityOp } from '../lib/applyEntityOp.js';
import { gcalCreationInFlight, maybePushToGCal } from '../lib/calendarPushback.js';
import { regenerateFutureRoutineItems } from '../lib/routineItemRegeneration.js';
import * as sseConnections from '../lib/sseConnections.js';
import * as webPush from '../lib/webPush.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { bareIdsWithLiveMasterInBatch, calendarRoutes, classifyRecurringMaster, pickSplitParent } from '../routes/calendar.js';
import { maintenanceRoutes } from '../routes/maintenance.js';
import type {
    CalendarIntegrationInterface,
    CalendarSyncConfigInterface,
    GCalAttendee,
    ItemInterface,
    OperationInterface,
    RoutineInterface,
} from '../types/entities.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/calendar', calendarRoutes);

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeAll(async () => {
    await loadDataAccess('gtd_test_calendar');
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
        db.collection('items').deleteMany({}),
        db.collection('routines').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('calendarIntegrations').deleteMany({}),
        db.collection('calendarSyncConfigs').deleteMany({}),
        db.collection('sentEmails').deleteMany({}),
    ]);
    vi.restoreAllMocks();
    gcalCreationInFlight.clear();
    // Mock getCalendarTimeZone globally — sync flows call it to refresh the cached timezone.
    vi.spyOn(GoogleCalendarProvider.prototype, 'getCalendarTimeZone').mockResolvedValue('Asia/Jerusalem');
});

// ─── Helpers ──────────────────────────────────────────────────────────────

async function loginAsAlice(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    return sessionCookie!;
}

async function getUserId(sessionCookie: string): Promise<string> {
    const res = await app.fetch(
        new Request('http://localhost:4000/auth/get-session', {
            headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
        }),
    );
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
}

function makeIntegration(userId: string, overrides: Partial<CalendarIntegrationInterface> = {}): CalendarIntegrationInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'int-1',
        user: userId,
        provider: 'google',
        accessToken: 'at',
        refreshToken: 'rt',
        tokenExpiry: now,
        calendarId: 'primary',
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

function makeRoutine(userId: string, overrides: Partial<RoutineInterface> = {}): RoutineInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'routine-1',
        user: userId,
        title: 'Standup',
        routineType: 'calendar',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        template: {},
        active: true,
        createdTs: now,
        updatedTs: now,
        calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
        ...overrides,
    };
}

function makeSyncConfig(userId: string, integrationId: string, overrides: Partial<CalendarSyncConfigInterface> = {}): CalendarSyncConfigInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'sync-config-1',
        integrationId,
        user: userId,
        calendarId: 'primary',
        isDefault: true,
        enabled: true,
        timeZone: 'Asia/Jerusalem',
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

/** Inserts an integration and its default sync config. Returns both for convenience. */
async function insertIntegrationWithConfig(userId: string, integrationOverrides?: Partial<CalendarIntegrationInterface>) {
    const integration = makeIntegration(userId, integrationOverrides);
    await calendarIntegrationsDAO.insertEncrypted(integration);
    const config = makeSyncConfig(userId, integration._id);
    await calendarSyncConfigsDAO.insertOne(config);
    return { integration, config };
}

// ─── Auth guard ────────────────────────────────────────────────────────────

describe('GET /calendar/integrations — auth guard', () => {
    it('returns 401 when not authenticated', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/calendar/integrations'));
        expect(res.status).toBe(401);
    });
});

// ─── GET /calendar/auth/google ─────────────────────────────────────────────

describe('GET /calendar/auth/google', () => {
    it('redirects to Google OAuth with calendar scope', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google',
            sessionCookie,
        });
        expect(res.status).toBe(302);
        const location = res.headers.get('location') ?? '';
        expect(location).toContain('accounts.google.com');
        // Both scopes must be requested: `calendar` for events, `userinfo.email` so the
        // callback can verify the authorized account matches the active session.
        const scope = new URL(location).searchParams.get('scope') ?? '';
        expect(scope).toContain('https://www.googleapis.com/auth/calendar');
        expect(scope).toContain('https://www.googleapis.com/auth/userinfo.email');
        // state must be present and HMAC-signed (verified below in callback test)
        expect(new URL(location).searchParams.get('state')).toBeTruthy();
    });

    it('forwards login_hint to Google and signs it into the state payload', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        expect(res.status).toBe(302);
        const location = new URL(res.headers.get('location') ?? '');
        // Google's authorization URL must carry the hint so the picker pre-selects the account.
        expect(location.searchParams.get('login_hint')).toBe('alice@example.com');

        // The HMAC-signed state envelope must round-trip the loginHint so the callback can
        // compare it to the userinfo email and reject mismatches.
        const stateParam = location.searchParams.get('state');
        expect(stateParam).toBeTruthy();
        const envelope = JSON.parse(Buffer.from(stateParam!, 'base64url').toString('utf8')) as { payload: string };
        const inner = JSON.parse(envelope.payload) as { loginHint?: string };
        expect(inner.loginHint).toBe('alice@example.com');
    });

    it('forces Google account selection (prompt=select_account) so a second-account connect is not silently reused', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        expect(res.status).toBe(302);
        const location = new URL(res.headers.get('location') ?? '');
        // Must include both select_account (force the account chooser) and consent (force refresh token).
        const promptValues = (location.searchParams.get('prompt') ?? '').split(/\s+/);
        expect(promptValues).toContain('select_account');
        expect(promptValues).toContain('consent');
    });

    it('omits login_hint when the query value is empty', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=',
            sessionCookie,
        });
        const location = new URL(res.headers.get('location') ?? '');
        expect(location.searchParams.get('login_hint')).toBeNull();
        const envelope = JSON.parse(Buffer.from(location.searchParams.get('state')!, 'base64url').toString('utf8')) as { payload: string };
        const inner = JSON.parse(envelope.payload) as { loginHint?: string };
        expect(inner.loginHint).toBeUndefined();
    });
});

// ─── GET /calendar/auth/google/callback ───────────────────────────────────

describe('GET /calendar/auth/google/callback', () => {
    it('returns 400 when code or state is missing', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/calendar/auth/google/callback'));
        expect(res.status).toBe(400);
    });

    it('returns 400 for an invalid (unsigned) state', async () => {
        // A plain base64 payload without HMAC signature.
        const fakeState = Buffer.from(JSON.stringify({ userId: 'evil' })).toString('base64url');
        const res = await app.fetch(new Request(`http://localhost:4000/calendar/auth/google/callback?code=x&state=${fakeState}`));
        expect(res.status).toBe(400);
    });

    it('returns 502 when Google token exchange fails', async () => {
        // Obtain a valid signed state by triggering the /auth/google redirect and extracting the state.
        const sessionCookie = await loginAsAlice();
        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;

        // Spy on OAuth2.prototype.getToken to simulate Google rejecting the code.
        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockRejectedValueOnce(new Error('invalid_grant'));

        const res = await app.fetch(new Request(`http://localhost:4000/calendar/auth/google/callback?code=used-code&state=${state}`));
        expect(res.status).toBe(502);
    });

    it('redirects to client settings and stores integration on success', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        // login_hint is required so the callback's email-mismatch check has both a hint
        // and session email to compare against the authorized userinfo email.
        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;

        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'test-at', refresh_token: 'test-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        // The callback fetches userinfo to validate the authorized account email — mock it inline so
        // the test doesn't depend on the global helpers' fetch mock.
        mockUserInfoEmail('alice@example.com');

        const res = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(res.status).toBe(302);

        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        expect(integrations).toHaveLength(1);
        // Redirect carries the persisted integration id so the client picker targets the real row.
        const [persisted] = integrations;
        if (!persisted) throw new Error('expected one integration');
        expect(res.headers.get('location')).toContain(`calendarConnected=${persisted._id}`);
        expect(persisted.user).toBe(userId);
        expect(persisted.provider).toBe('google');
        expect(persisted.accessToken).toBe('test-at');
        expect(persisted.refreshToken).toBe('test-rt');
        // Step 2: integrations no longer carry a `calendarId` field — the user picks one or more
        // calendars via ChooseCalendarDialog after the redirect, which creates CalendarSyncConfig rows.
        expect(persisted.calendarId).toBeUndefined();
    });

    it('redirects to settings with calendarConnectError=mismatch when authorized email differs from login_hint', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;

        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'test-at', refresh_token: 'test-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        const revokeSpy = vi.spyOn(google.auth.OAuth2.prototype, 'revokeToken').mockResolvedValueOnce({} as never);
        // User picked a different account in Google's picker — userinfo returns a non-matching email.
        mockUserInfoEmail('imposter@example.com');

        const res = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('calendarConnectError=mismatch');

        // Tokens revoked, no integration row written.
        expect(revokeSpy).toHaveBeenCalledWith('test-at');
        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        expect(integrations).toHaveLength(0);
    });

    it('redirects to mismatch when the authorized email matches no signed-in session', async () => {
        // Alice is signed in. Google authorizes a DIFFERENT identity (different-account@example.com)
        // that owns no session on this device. The owner-resolution returns null (no session matches
        // the authorized email) → reject. This is the security guard: we never attach an integration
        // to a Google identity that doesn't correspond to a signed-in account, even with no loginHint.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google', // no login_hint
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;

        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'test-at', refresh_token: 'test-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        const revokeSpy = vi.spyOn(google.auth.OAuth2.prototype, 'revokeToken').mockResolvedValueOnce({} as never);
        // userinfo email belongs to no signed-in session.
        mockUserInfoEmail('different-account@example.com');

        const res = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('calendarConnectError=mismatch');
        expect(revokeSpy).toHaveBeenCalledWith('test-at');
        expect(await calendarIntegrationsDAO.findByUserDecrypted(userId)).toHaveLength(0);
    });

    it('redirects to mismatch when there is no active session at all', async () => {
        // No session cookie on the callback request → listDeviceSessions resolves empty → the
        // authorized email matches no session → reject. Guards against authorizing any account when
        // the request carries no signed-in session.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;

        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'test-at', refresh_token: 'test-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        const revokeSpy = vi.spyOn(google.auth.OAuth2.prototype, 'revokeToken').mockResolvedValueOnce({} as never);
        mockUserInfoEmail('alice@example.com');

        // Note: NO Cookie header → listDeviceSessions resolves empty → no owner match.
        const res = await app.fetch(new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`));
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('calendarConnectError=mismatch');
        expect(revokeSpy).toHaveBeenCalled();
        expect(await calendarIntegrationsDAO.findByUserDecrypted(userId)).toHaveLength(0);
    });

    it('attaches the integration to the account that owns the authorized email — even when the active-session cookie points at a DIFFERENT signed-in account (cookie/IDB drift)', async () => {
        // The core regression: app intends to connect bob@ (login_hint=bob), Google authorizes bob@,
        // but the API-origin active-session cookie still resolves to alice@ (drift). The callback must
        // attach the integration to BOB (the authorized-email owner), not alice (the cookie's user).
        const aliceCookie = await loginAsAlice();
        const aliceId = await getUserId(aliceCookie);
        // bob is a second account signed in on this device. We don't need a real user row (the
        // integration carries `user: bobId` without an FK), so use a distinct synthetic id and stub
        // the device-session list to report bob alongside alice's (drifted) active session.
        const bobId = 'bob-user-id';

        // Initiate connect for bob (login_hint=bob) under ALICE's cookie to simulate the drift:
        // /auth/google stamps state.userId = alice, yet the app intends bob.
        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=bob@example.com',
            sessionCookie: aliceCookie, // drifted cookie = alice
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;

        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'bob-at', refresh_token: 'bob-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        // Google authorized bob@ (matches login_hint).
        mockUserInfoEmail('bob@example.com');
        // Active session still resolves to alice (the drift); the device-session list adds bob, so the
        // owner-resolver can match the authorized bob@ against a signed-in account.
        vi.spyOn(auth.api, 'listDeviceSessions').mockResolvedValueOnce([{ user: { id: bobId, email: 'bob@example.com' } }] as never);

        const res = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${aliceCookie}` }, // still the drifted cookie
            }),
        );
        expect(res.status).toBe(302);

        // Integration attached to BOB, not alice.
        expect(await calendarIntegrationsDAO.findByUserDecrypted(aliceId)).toHaveLength(0);
        const bobIntegrations = await calendarIntegrationsDAO.findByUserDecrypted(bobId);
        expect(bobIntegrations).toHaveLength(1);
        const [bobIntegration] = bobIntegrations;
        if (!bobIntegration) throw new Error('expected one integration for bob');
        // Redirect carries the persisted integration id (bob's, the resolved owner).
        expect(res.headers.get('location')).toContain(`calendarConnected=${bobIntegration._id}`);
        expect(bobIntegration.user).toBe(bobId);
        expect(bobIntegration.accessToken).toBe('bob-at');
    });

    it('rejects (mismatch + revoke) when BOTH session lookups fail — fails closed', async () => {
        // If getSession AND listDeviceSessions both throw (transient Better Auth outage), the
        // candidate set is empty → no owner → reject. The connect must NEVER fall back to attaching
        // the integration to an unverified account when account resolution is unavailable.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;

        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'test-at', refresh_token: 'test-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        const revokeSpy = vi.spyOn(google.auth.OAuth2.prototype, 'revokeToken').mockResolvedValueOnce({} as never);
        mockUserInfoEmail('alice@example.com');
        // Both account-resolution sources down.
        vi.spyOn(auth.api, 'getSession').mockRejectedValueOnce(new Error('auth down'));
        vi.spyOn(auth.api, 'listDeviceSessions').mockRejectedValueOnce(new Error('auth down'));

        const res = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('calendarConnectError=mismatch');
        expect(revokeSpy).toHaveBeenCalledWith('test-at');
        expect(await calendarIntegrationsDAO.findByUserDecrypted(userId)).toHaveLength(0);
    });

    it('de-duplicates the active account appearing in BOTH sources — attaches exactly one integration', async () => {
        // listDeviceSessions in production includes the active account. The candidate union must
        // de-dupe by userId so the same account isn't double-counted; the integration still attaches
        // exactly once to that account.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;

        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'test-at', refresh_token: 'test-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        mockUserInfoEmail('alice@example.com');
        // Active session (getSession) is alice; listDeviceSessions ALSO reports alice → overlap.
        vi.spyOn(auth.api, 'listDeviceSessions').mockResolvedValueOnce([{ user: { id: userId, email: 'alice@example.com' } }] as never);

        const res = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(res.status).toBe(302);
        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        expect(integrations).toHaveLength(1);
        const [persisted] = integrations;
        if (!persisted) throw new Error('expected one integration');
        expect(res.headers.get('location')).toContain(`calendarConnected=${persisted._id}`);
    });

    it('persists tokens.scope as grantedScopes on the integration', async () => {
        // Google returns scope as a space-separated string on every fresh consent; the callback
        // splits it into an array on the integration so RSVP can gate on calendar write later.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;

        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: {
                access_token: 'scoped-at',
                refresh_token: 'scoped-rt',
                expiry_date: dayjs().add(1, 'hour').valueOf(),
                scope: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email',
            },
        } as never);
        mockUserInfoEmail('alice@example.com');

        const res = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(res.status).toBe(302);

        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        expect(integrations).toHaveLength(1);
        const [integration] = integrations;
        if (!integration) throw new Error('expected an integration');
        expect(integration.grantedScopes).toEqual(['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/userinfo.email']);
    });

    it('leaves grantedScopes undefined when tokens.scope is absent', async () => {
        // Some refresh-token paths omit scope; the callback treats absence as permissive (legacy).
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;

        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'noscope-at', refresh_token: 'noscope-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        mockUserInfoEmail('alice@example.com');

        const res = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(res.status).toBe(302);

        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        expect(integrations).toHaveLength(1);
        const [integration] = integrations;
        if (!integration) throw new Error('expected an integration');
        expect(integration.grantedScopes).toBeUndefined();
    });
});

/**
 * Mocks the Google userinfo endpoint to return a fixed email — used by callback tests.
 * Patches the prototype of the oauth2.userinfo Resource so any new client instance built by the
 * route under test inherits the mock without coupling to gaxios internals.
 */
function mockUserInfoEmail(email: string): void {
    // biome-ignore lint/suspicious/noExplicitAny: googleapis Resource$Userinfo type is internal; cast to access prototype.
    const userinfoCtor = Object.getPrototypeOf(google.oauth2('v2').userinfo) as { constructor: any };
    vi.spyOn(userinfoCtor.constructor.prototype, 'get').mockResolvedValue({ data: { email } } as never);
}

// ─── GET /calendar/integrations ───────────────────────────────────────────

describe('GET /calendar/integrations', () => {
    it('returns empty array when no integrations', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations', sessionCookie });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
    });

    it('returns integrations without token fields', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const res = await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations', sessionCookie });
        expect(res.status).toBe(200);
        const integrations = (await res.json()) as Record<string, unknown>[];
        expect(integrations).toHaveLength(1);
        // Tokens must be stripped from the response.
        expect(integrations[0]).not.toHaveProperty('accessToken');
        expect(integrations[0]).not.toHaveProperty('refreshToken');
        expect(integrations[0]).toHaveProperty('calendarId', 'primary');
    });

    it("does not return another user's integrations", async () => {
        const aliceCookie = await loginAsAlice();
        // Insert an integration belonging to a different (non-existent) user.
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration('other-user-id'));

        const res = await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations', sessionCookie: aliceCookie });
        expect(await res.json()).toEqual([]);
    });

    it('surfaces grantedScopes on the response payload', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(
            makeIntegration(userId, {
                grantedScopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/userinfo.email'],
            }),
        );

        const res = await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations', sessionCookie });
        expect(res.status).toBe(200);
        const integrations = (await res.json()) as Array<{ grantedScopes?: string[] }>;
        expect(integrations).toHaveLength(1);
        const [first] = integrations;
        if (!first) throw new Error('expected one integration');
        expect(first.grantedScopes).toEqual(['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/userinfo.email']);
    });
});

// ─── GET /calendar/integrations/:id/calendars ─────────────────────────────

describe('GET /calendar/integrations/:id/calendars', () => {
    it('returns 404 for an unknown integration', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations/no-such-id/calendars', sessionCookie });
        expect(res.status).toBe(404);
    });

    it('returns 502 when Google calendar listing fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        vi.spyOn(GoogleCalendarProvider.prototype, 'listCalendars').mockRejectedValueOnce(new Error('Google error'));

        const res = await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations/int-1/calendars', sessionCookie });
        expect(res.status).toBe(502);
    });

    it('returns the list of calendars on success', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        vi.spyOn(GoogleCalendarProvider.prototype, 'listCalendars').mockResolvedValueOnce([
            { id: 'primary', name: 'Alice Smith', primary: true, accessRole: 'owner' },
            { id: 'work@group.calendar.google.com', name: 'Work', primary: false, accessRole: 'writer' },
        ]);

        const res = await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations/int-1/calendars', sessionCookie });
        expect(res.status).toBe(200);
        // The route is a passthrough — primary/accessRole flow to the client untouched so the picker
        // can group and pre-select.
        expect(await res.json()).toEqual([
            { id: 'primary', name: 'Alice Smith', primary: true, accessRole: 'owner' },
            { id: 'work@group.calendar.google.com', name: 'Work', primary: false, accessRole: 'writer' },
        ]);
    });
});

// ─── POST /calendar/integrations/:id/sync ─────────────────────────────────

describe('POST /calendar/integrations/:id/sync', () => {
    // listEventsFull is called by importCalendarEvents on every sync — mock it by default so
    // tests that focus on other behaviour don't need to set it up themselves.
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });
    });

    it('returns 404 for an unknown integration', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/bad-id/sync', sessionCookie });
        expect(res.status).toBe(404);
    });

    it('returns syncedRoutines: 0 when no routines are linked', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Mock the GoogleCalendarProvider so no real HTTP calls are made.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, syncedRoutines: 0 });
    });

    it('merges a deleted exception as type:skipped in routineExceptions', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([{ originalDate: '2025-06-02', type: 'deleted' }]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updated?.routineExceptions).toContainEqual({ date: '2025-06-02', type: 'skipped' });
    });

    it('skips the routine write + op when the merged exception set is unchanged (no-op churn guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Routine already carries the exact exception GCal will re-surface (getExceptions is a time-range,
        // not incremental, query — every fire re-returns the same rows). The merge reproduces an identical
        // list, so no routine write and no `update` op should be recorded for this routine.
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-noop',
            calendarIntegrationId: 'int-1',
            routineExceptions: [{ date: '2025-06-02', type: 'skipped' }],
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        await routinesDAO.insertOne(routine);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([{ originalDate: '2025-06-02', type: 'deleted' }]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const ops = await operationsDAO.findArray({ entityId: 'routine-1', entityType: 'routine' });
        expect(ops).toHaveLength(0);
        // updatedTs untouched — the routine was not rewritten.
        const unchanged = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(unchanged?.updatedTs).toBe('2026-01-01T00:00:00.000Z');
    });

    it('skips the item write + op when a modified exception re-surfaces values the item already holds (no-op churn guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Routine already carries this exception, so syncRoutineExceptions' own guard short-circuits the
        // routine write. The item below already holds the exact times the modified exception re-surfaces,
        // so applyModifiedExceptionToOne must also skip — getExceptions is a time-range (not incremental)
        // query, so each webhook fire would otherwise rewrite this item with an identical snapshot.
        const newTimeStart = '2025-06-09T10:00:00Z';
        const newTimeEnd = '2025-06-09T10:30:00Z';
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-itemnoop',
            calendarIntegrationId: 'int-1',
            routineExceptions: [{ date: '2025-06-09', type: 'modified', newTimeStart, newTimeEnd }],
        });
        await routinesDAO.insertOne(routine);

        const itemTs = '2026-01-01T00:00:00.000Z';
        await itemsDAO.insertOne({
            _id: 'item-noop-ex',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-noop',
            timeStart: newTimeStart,
            timeEnd: newTimeEnd,
            createdTs: itemTs,
            updatedTs: itemTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: '2025-06-09', googleEventId: 'inst-noop', type: 'modified', title: 'Standup', newTimeStart, newTimeEnd },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const itemOps = await operationsDAO.findArray({ entityId: 'item-noop-ex', entityType: 'item' });
        expect(itemOps).toHaveLength(0);
        // updatedTs untouched — the item was not rewritten.
        const unchanged = await itemsDAO.findByOwnerAndId('item-noop-ex', userId);
        expect(unchanged?.updatedTs).toBe(itemTs);
    });

    it('re-asserts master attendees on an exception-date item when the exception omits them (RFC 5545 inheritance)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Regression: buildModifiedException omits attendees when the instance list equals the
        // master's. The old apply path $unset any GCal-owned key absent on the exception and relied
        // on a re-mirror that never ran — permanently stripping participants from every
        // exception-date item. The fix must restore the master values on such an item.
        const masterAttendees: GCalAttendee[] = [
            { email: 'alice@example.com', responseStatus: 'accepted' },
            { email: 'bob@example.com', responseStatus: 'needsAction' },
        ];
        const date = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const newTimeStart = `${date}T10:15:00`;
        const newTimeEnd = `${date}T10:30:00`;
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-inherit',
            calendarIntegrationId: 'int-1',
            attendees: masterAttendees,
            organizer: { email: 'alice@example.com' },
            routineExceptions: [{ date, type: 'modified', newTimeStart, newTimeEnd }],
        });
        await routinesDAO.insertOne(routine);

        // Item already stripped by the pre-fix behavior: no attendees/organizer despite the master carrying them.
        await itemsDAO.insertOne({
            _id: 'item-stripped',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-stripped',
            timeStart: newTimeStart,
            timeEnd: newTimeEnd,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: date, googleEventId: 'inst-stripped', type: 'modified', title: 'Standup', newTimeStart, newTimeEnd },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const healed = await itemsDAO.findByOwnerAndId('item-stripped', userId);
        expect(healed?.attendees).toEqual(masterAttendees);
        expect(healed?.organizer).toEqual({ email: 'alice@example.com' });
        // The heal is a real change and must be recorded as an op so other devices converge.
        const itemOps = await operationsDAO.findArray({ entityId: 'item-stripped', entityType: 'item' });
        expect(itemOps).toHaveLength(1);
    });

    it('keeps a per-instance attendee override winning over the master list', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const masterAttendees: GCalAttendee[] = [{ email: 'alice@example.com', responseStatus: 'accepted' }];
        const overrideAttendees: GCalAttendee[] = [
            { email: 'alice@example.com', responseStatus: 'accepted' },
            { email: 'guest@example.com', responseStatus: 'tentative' },
        ];
        const date = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-override',
            calendarIntegrationId: 'int-1',
            attendees: masterAttendees,
            routineExceptions: [{ date, type: 'modified', attendees: overrideAttendees }],
        });
        await routinesDAO.insertOne(routine);

        await itemsDAO.insertOne({
            _id: 'item-override',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-override',
            timeStart: `${date}T09:00:00`,
            timeEnd: `${date}T09:30:00`,
            attendees: masterAttendees,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: date, googleEventId: 'inst-override', type: 'modified', title: 'Standup', attendees: overrideAttendees },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await itemsDAO.findByOwnerAndId('item-override', userId);
        expect(updated?.attendees).toEqual(overrideAttendees);
    });

    it('unsets GCal-owned keys carried by neither the exception nor the master', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // "GCal removed all attendees" case: master no longer mirrors any attendees and the
        // exception reports none either — a stale mirrored list on the item must be cleared,
        // not resurrected by the inheritance merge.
        const date = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const newTimeStart = `${date}T11:00:00`;
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-clear',
            calendarIntegrationId: 'int-1',
            routineExceptions: [{ date, type: 'modified', newTimeStart }],
        });
        await routinesDAO.insertOne(routine);

        await itemsDAO.insertOne({
            _id: 'item-stale-att',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-stale-att',
            timeStart: `${date}T09:00:00`,
            timeEnd: `${date}T09:30:00`,
            attendees: [{ email: 'ghost@example.com', responseStatus: 'declined' }],
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: date, googleEventId: 'inst-stale-att', type: 'modified', title: 'Standup', newTimeStart },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const cleared = await itemsDAO.findByOwnerAndId('item-stale-att', userId);
        expect(cleared?.attendees).toBeUndefined();
    });

    it('does not overwrite a per-instance RSVP responseStatus with the master series response', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // buildModifiedException NEVER emits responseStatus, so a naive master∪override merge resolves
        // it to the series value on every sync — silently replacing the user's own per-instance RSVP
        // (the one local-write exception to GCal ownership) with data contradicting the attendees array.
        const date = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const masterAttendees: GCalAttendee[] = [{ email: 'me@example.com', responseStatus: 'needsAction', self: true }];
        const myRsvpAttendees: GCalAttendee[] = [{ email: 'me@example.com', responseStatus: 'declined', self: true }];
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-rsvp',
                calendarIntegrationId: 'int-1',
                attendees: masterAttendees,
                responseStatus: 'needsAction',
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-rsvped',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-rsvped',
            timeStart: `${date}T09:00:00`,
            timeEnd: `${date}T09:30:00`,
            attendees: myRsvpAttendees,
            responseStatus: 'declined',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        // The forked instance reports the diverged attendee list but carries no responseStatus.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: date, googleEventId: 'inst-rsvped', type: 'modified', attendees: myRsvpAttendees },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const after = await itemsDAO.findByOwnerAndId('item-rsvped', userId);
        // The denorm must agree with the attendees array in the same document.
        expect(after?.responseStatus).toBe('declined');
        expect(after?.attendees).toEqual(myRsvpAttendees);
    });

    it('restores master GCal-owned fields when reverting an item to master time', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Reconcile-away path: GCal stopped reporting the instance as overridden (user dragged it back
        // to its master time), so the local exception is dropped and the item reverts. The revert must
        // positively RE-ASSERT the master's GCal-owned values — the previous implementation relied on
        // unset-everything plus a re-mirror that never ran, leaving the item bare.
        const masterAttendees: GCalAttendee[] = [
            { email: 'alice@example.com', responseStatus: 'accepted' },
            { email: 'bob@example.com', responseStatus: 'needsAction' },
        ];
        const date = dayjs().add(7, 'day').format('YYYY-MM-DD');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-revert',
                calendarIntegrationId: 'int-1',
                attendees: masterAttendees,
                organizer: { email: 'alice@example.com' },
                location: 'Room 4',
                // Pure-time move ⇒ isReconcilable, and the date is inside the reconcile window.
                routineExceptions: [{ date, type: 'modified', newTimeStart: `${date}T14:00:00`, newTimeEnd: `${date}T14:30:00` }],
            }),
        );
        // Item sits at the MOVED time and has been stripped of master values by the old behavior.
        await itemsDAO.insertOne({
            _id: 'item-reverting',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-reverting',
            timeStart: `${date}T14:00:00`,
            timeEnd: `${date}T14:30:00`,
            location: 'Stale Room 9',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        // GCal no longer reports the override ⇒ reconcileRemovedExceptions reverts + drops it.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const reverted = await itemsDAO.findByOwnerAndId('item-reverting', userId);
        // masterTimes must win over the patch's sharedFields — the item returns to the 09:00 template time.
        expect(reverted?.timeStart).toBe(`${date}T09:00:00`);
        // …and the master's GCal-owned slice is re-asserted rather than left bare.
        expect(reverted?.attendees).toEqual(masterAttendees);
        expect(reverted?.organizer).toEqual({ email: 'alice@example.com' });
        expect(reverted?.location).toBe('Room 4');
        // The reconciled-away exception is gone from the routine.
        const routineAfter = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(routineAfter?.routineExceptions ?? []).toHaveLength(0);
    });

    it('reverts a modified-instance item to master time and drops the exception when GCal stops reporting it', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Repro of the "nudged then moved back, app stuck at the old time" bug: the user moved an
        // instance (12:00 → 11:45, recorded as a modified exception), then dragged it back to master
        // time. GCal drops the override, so getExceptions no longer reports this date. The stale
        // exception + moved item must be reconciled away.
        const date = dayjs().add(14, 'day').format('YYYY-MM-DD'); // in-window (within now+1y)
        const movedStart = `${date}T11:45:00`;
        const movedEnd = `${date}T12:45:00`;
        // makeRoutine's template is 09:00 / 30min, so master time for `date` is 09:00–09:30.
        const masterStart = `${date}T09:00:00`;
        const masterEnd = `${date}T09:30:00`;
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-revert',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date, type: 'modified', newTimeStart: movedStart, newTimeEnd: movedEnd }],
            }),
        );
        const itemTs = '2026-01-01T00:00:00.000Z';
        await itemsDAO.insertOne({
            _id: 'item-revert',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: movedStart,
            timeEnd: movedEnd,
            createdTs: itemTs,
            updatedTs: itemTs,
        });

        // GCal reports NO exceptions for this series — the instance is back at master time.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-revert' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Item reverted to master time.
        const item = await itemsDAO.findByOwnerAndId('item-revert', userId);
        expect(item?.timeStart).toBe(masterStart);
        expect(item?.timeEnd).toBe(masterEnd);
        // Stale exception removed from the routine.
        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions ?? []).not.toContainEqual(expect.objectContaining({ date, type: 'modified' }));
    });

    it('does NOT reconcile away a modified exception outside the getExceptions window (older than 30 days)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // An exception 60 days in the past is never reported by getExceptions (timeMin floor is now-30d),
        // so its absence must NOT be treated as "removed" — that would wrongly drop a still-valid override.
        const oldDate = dayjs().subtract(60, 'day').format('YYYY-MM-DD');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-oldex',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date: oldDate, type: 'modified', newTimeStart: `${oldDate}T11:45:00`, newTimeEnd: `${oldDate}T12:45:00` }],
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-oldex' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: oldDate, type: 'modified' }));
    });

    it('does NOT reconcile away a time-move exception dated before the sync cursor (within now-30d but predating lastSyncedTs)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Recent cursor: getExceptions' real timeMin is max(since, now-30d) = since. An exception dated
        // 10 days ago is inside [now-30d, now] but BEFORE the cursor, so GCal never returns it — its
        // absence must NOT be treated as "removed". Pre-fix (hardcoded now-30d window) this was a
        // silent data-loss revert.
        const integration = makeIntegration(userId);
        await calendarIntegrationsDAO.insertEncrypted(integration);
        const recentCursor = dayjs().subtract(5, 'day').toISOString();
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id, { lastSyncedTs: recentCursor }));

        const preCursorDate = dayjs().subtract(10, 'day').format('YYYY-MM-DD');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-precursor',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [
                    { date: preCursorDate, type: 'modified', newTimeStart: `${preCursorDate}T11:45:00`, newTimeEnd: `${preCursorDate}T12:45:00` },
                ],
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-precursor' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: preCursorDate, type: 'modified' }));
    });

    it('does NOT reconcile away a time-move exception ON the cursor date (same-day boundary, master time before cursor instant)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Same-day sliver: cursor instant is 14:30 on its date; the master instance time is 09:00, so
        // GCal's timeMin (full ISO) excludes this instance even though its date == the cursor's date.
        // A date-only window would wrongly include it → revert. The strict floor (date > floorDate)
        // must drop the cursor's own date so this exception is preserved.
        const integration = makeIntegration(userId);
        await calendarIntegrationsDAO.insertEncrypted(integration);
        const sinceDate = dayjs().subtract(3, 'day').format('YYYY-MM-DD');
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id, { lastSyncedTs: `${sinceDate}T14:30:00.000Z` }));

        // Exception on the cursor's own date; master template time is 09:00 (< 14:30 cursor).
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-sameday',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date: sinceDate, type: 'modified', newTimeStart: `${sinceDate}T11:45:00`, newTimeEnd: `${sinceDate}T12:45:00` }],
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-sameday' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: sinceDate, type: 'modified' }));
    });

    it('does NOT reconcile away a time-move exception ON the now+1y ceiling date (symmetric boundary)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Symmetric to the floor sliver: getExceptions' timeMax is the now+1y INSTANT. An exception on
        // the now+1y calendar date but later-in-day than `now` is excluded by the provider, so its
        // absence must not trigger a revert. The strict ceiling (date < windowEnd) drops that day.
        const ceilingDate = dayjs().add(1, 'year').format('YYYY-MM-DD');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-ceiling',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date: ceilingDate, type: 'modified', newTimeStart: `${ceilingDate}T11:45:00`, newTimeEnd: `${ceilingDate}T12:45:00` }],
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-ceiling' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: ceilingDate, type: 'modified' }));
    });

    // ─── skipped-exception revival (un-deleted / restored GCal instances) ─────
    //
    // Symmetric sibling of the time-move reconcile tests above. makeRoutine's rrule is
    // FREQ=WEEKLY;BYDAY=MO anchored at createdTs (now), so revival dates must be a Monday ON/AFTER
    // the anchor week for `routineGeneratesOccurrenceOnDate` to confirm the occurrence is real.

    /** The Nth future Monday from today (N=1 → the next upcoming Monday), as YYYY-MM-DD. */
    function futureMonday(weeksAhead: number): string {
        const today = dayjs().startOf('day');
        const daysUntilMonday = (8 - today.day()) % 7 || 7; // 1..7, never 0 → always strictly future
        return today
            .add(daysUntilMonday, 'day')
            .add((weeksAhead - 1) * 7, 'day')
            .format('YYYY-MM-DD');
    }

    it('revives a trashed routine item to master time and drops the skipped exception when GCal stops reporting the deletion', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // The user deleted a routine occurrence on GCal (→ local `skipped` exception + trashed item),
        // then un-deleted it. GCal no longer reports the date as `deleted`, so the occurrence is back:
        // the trashed item must return to `status:'calendar'` at master time + the exception drop.
        const date = futureMonday(2);
        // makeRoutine's template is 09:00 / 30min → master time for `date` is 09:00–09:30.
        const masterStart = `${date}T09:00:00`;
        const masterEnd = `${date}T09:30:00`;
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-revive',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date, type: 'skipped' }],
            }),
        );
        const itemTs = '2026-01-01T00:00:00.000Z';
        await itemsDAO.insertOne({
            _id: 'item-revive',
            user: userId,
            status: 'trash',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: masterStart,
            timeEnd: masterEnd,
            cancelledByGCal: true,
            createdTs: itemTs,
            updatedTs: itemTs,
        });

        // GCal reports NO exceptions — the cancellation tombstone is gone.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-revive' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-revive', userId);
        expect(item?.status).toBe('calendar');
        expect(item?.timeStart).toBe(masterStart);
        expect(item?.timeEnd).toBe(masterEnd);
        // cancelledByGCal badge cleared on revive.
        expect(item?.cancelledByGCal).toBeUndefined();
        // Instance id re-minted so the row re-occupies the unique partial index.
        expect(item?.calendarInstanceEventId).toBeTruthy();
        // skipped exception dropped from the routine.
        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions ?? []).not.toContainEqual(expect.objectContaining({ date, type: 'skipped' }));
    });

    it('revives an ALL-DAY routine occurrence to the single-day master range with a YYYYMMDD instance id', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // All-day template path: revival must produce a date-only single-day range (GCal exclusive-end
        // → +1 day), set allDay:true, and mint the YYYYMMDD (no T) instance-id form. The all-day branch
        // in buildRevivedInstanceEventId + reviveTrashedRoutineItemInPlace was otherwise untested.
        const date = futureMonday(2);
        const nextDay = dayjs(date).add(1, 'day').format('YYYY-MM-DD');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-allday',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                calendarItemTemplate: { allDay: true },
                routineExceptions: [{ date, type: 'skipped' }],
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-allday-revive',
            user: userId,
            status: 'trash',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: date,
            timeEnd: nextDay,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-allday' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-allday-revive', userId);
        expect(item?.status).toBe('calendar');
        expect(item?.allDay).toBe(true);
        expect(item?.timeStart).toBe(date);
        expect(item?.timeEnd).toBe(nextDay);
        // All-day instance id is YYYYMMDD only (no T component).
        expect(item?.calendarInstanceEventId).toBe(`gcal-evt-allday_${date.replace(/-/g, '')}`);
    });

    it('revives via orphan-create when no trashed row survives at the master date', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // The trashed row was purged (or its timeStart shifted off the master date by a prior move), so
        // the in-place lookup misses → reviveSkippedOccurrence falls back to createItemForOrphanedException,
        // which mints a fresh master-time row. Exercises the `!target` branch.
        const date = futureMonday(2);
        const masterStart = `${date}T09:00:00`;
        const masterEnd = `${date}T09:30:00`;
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-orphanrevive',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date, type: 'skipped' }],
            }),
        );
        // Deliberately NO trashed item at the master date.

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-orphanrevive' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // A fresh live calendar item was created at master time, with the re-minted instance id.
        const created = await itemsDAO.findArray({ user: userId, routineId: 'routine-1', status: 'calendar' });
        expect(created).toHaveLength(1);
        const [item] = created;
        if (!item) throw new Error('expected one orphan-created item');
        expect(item.timeStart).toBe(masterStart);
        expect(item.timeEnd).toBe(masterEnd);
        expect(item.calendarInstanceEventId).toBeTruthy();
        // skipped exception dropped.
        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions ?? []).not.toContainEqual(expect.objectContaining({ date, type: 'skipped' }));
    });

    // ─── moved instance landing on a cancelled occurrence's date (the "ALL HANDS" flip-flop) ─────

    it('keeps a moved instance that landed on a cancelled occurrence date stable across syncs (no create/trash flip-flop)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Staging incident: GCal moved the Sept 1 occurrence to Sept 8 15:00 AND cancelled the regular
        // Sept 8 occurrence. The cancelled exception missed tier 1 (no row carries the Sept 8 id) and
        // the tier-2 date fallback grabbed the moved Sept 1 row now sitting on Sept 8 → trashed it; the
        // next sync found no live row for the Sept 1 exception → re-created it as an orphan. Every
        // sync produced create/update/trash ops (~1,600 dead rows, a push notification per cycle).
        const movedFrom = futureMonday(2);
        const cancelled = futureMonday(3);
        const movedInstanceId = `gcal-evt-allhands_${movedFrom.replace(/-/g, '')}T060000Z`;
        const cancelledInstanceId = `gcal-evt-allhands_${cancelled.replace(/-/g, '')}T060000Z`;
        const selfAttendees: GCalAttendee[] = [
            { email: 'organizer@example.com', responseStatus: 'accepted', organizer: true },
            { email: 'alice@example.com', responseStatus: 'needsAction', self: true },
        ];
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                title: 'ALL HANDS',
                calendarEventId: 'gcal-evt-allhands',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                attendees: [
                    { email: 'organizer@example.com', responseStatus: 'accepted', organizer: true },
                    { email: 'alice@example.com', responseStatus: 'accepted', self: true },
                ],
                responseStatus: 'accepted',
            }),
        );
        // Re-syncs carry the syncToken from the first run and take the incremental fetch path.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({ events: [], nextSyncToken: 'tok-allhands' });
        // getExceptions is a time-range query — both exceptions are re-reported on EVERY sync.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: movedFrom,
                type: 'modified',
                newTimeStart: `${cancelled}T15:00:00+03:00`,
                newTimeEnd: `${cancelled}T15:30:00+03:00`,
                googleEventId: movedInstanceId,
                attendees: selfAttendees,
            },
            { originalDate: cancelled, type: 'deleted', googleEventId: cancelledInstanceId },
        ]);

        const syncAndReadBack = async () => {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const rows = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
            const itemOps = await operationsDAO.findArray({ user: userId, entityType: 'item' });
            return { live: rows.filter((row) => row.status === 'calendar'), trashed: rows.filter((row) => row.status === 'trash'), itemOps };
        };

        const first = await syncAndReadBack();
        expect(first.live).toHaveLength(1);
        expect(first.trashed).toHaveLength(0);
        const [created] = first.live;
        if (!created) throw new Error('expected one orphan-created item');
        expect(created.calendarInstanceEventId).toBe(movedInstanceId);
        expect(created.timeStart).toBe(`${cancelled}T15:00:00+03:00`);
        // The orphan-create path derives responseStatus from the instance's own self attendee (the
        // modified-exception apply rule), NOT the series value — otherwise the next apply is a
        // guaranteed redundant update op.
        expect(created.responseStatus).toBe('needsAction');
        expect(first.itemOps.map((op) => op.opType)).toEqual(['create']);

        // Re-syncs are fully idempotent: same single live row, nothing trashed, no new item ops.
        const second = await syncAndReadBack();
        const third = await syncAndReadBack();
        for (const run of [second, third]) {
            expect(run.live.map((row) => row._id)).toEqual([created._id]);
            expect(run.trashed).toHaveLength(0);
            expect(run.itemOps).toHaveLength(1);
        }
    });

    it('date-matches only the legacy row (no instance id) on a date shared with a row anchored to another occurrence', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Two live rows on the cancelled date: a legacy row (pre instance-id rollout, no id) that IS this
        // occurrence and must still resolve by date, and a row carrying a DIFFERENT instance id (another
        // occurrence GCal moved onto this date) that must be left alone. Dropping or inverting the
        // tier-2 exclusion fails this either way.
        const date = futureMonday(2);
        const movedFrom = futureMonday(1);
        await routinesDAO.insertOne(
            makeRoutine(userId, { calendarEventId: 'gcal-evt-legacy', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' }),
        );
        const rowOnDate = (id: string, timeOfDay: string, instanceEventId?: string): ItemInterface => ({
            _id: id,
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${date}T${timeOfDay}:00`,
            timeEnd: `${date}T${timeOfDay}:00`,
            ...(instanceEventId ? { calendarInstanceEventId: instanceEventId } : {}),
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        await itemsDAO.insertOne(rowOnDate('item-legacy', '09:00'));
        await itemsDAO.insertOne(rowOnDate('item-moved-here', '15:00', `gcal-evt-legacy_${movedFrom.replace(/-/g, '')}T060000Z`));
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: date, type: 'deleted', googleEventId: `gcal-evt-legacy_${date.replace(/-/g, '')}T060000Z` },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        expect((await itemsDAO.findByOwnerAndId('item-legacy', userId))?.status).toBe('trash');
        expect((await itemsDAO.findByOwnerAndId('item-moved-here', userId))?.status).toBe('calendar');
    });

    it('stamps inbound timestamps when the calendar lock is acquired, not at request arrival', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // A manual sync queued behind the per-calendar lock used to carry `now` from request arrival
        // (observed ~85 min stale on staging under a client-driven sync storm), so every row it wrote
        // got a backdated createdTs/updatedTs and lost LWW against real edits.
        const date = futureMonday(2);
        await routinesDAO.insertOne(
            makeRoutine(userId, { calendarEventId: 'gcal-evt-stamp', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' }),
        );
        const lockReleasedAt: string[] = [];
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({ events: [], nextSyncToken: 'tok-stamp' });
        const getExceptions = vi
            .spyOn(GoogleCalendarProvider.prototype, 'getExceptions')
            // First sync: hold the lock for a while, then note when it is about to be released.
            .mockImplementationOnce(async () => {
                await new Promise((resolve) => setTimeout(resolve, 300));
                lockReleasedAt.push(dayjs().toISOString());
                return [];
            })
            // Second sync (queued behind the first): orphan-creates a row whose stamps we inspect.
            .mockResolvedValueOnce([
                {
                    originalDate: date,
                    type: 'modified',
                    newTimeStart: `${date}T10:00:00+03:00`,
                    newTimeEnd: `${date}T10:30:00+03:00`,
                    googleEventId: `gcal-evt-stamp_${date.replace(/-/g, '')}T060000Z`,
                },
            ]);

        const firstSync = authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        // Only fire the second request once the first provably holds the lock (it is inside getExceptions).
        await vi.waitFor(() => expect(getExceptions).toHaveBeenCalledTimes(1));
        const secondSync = authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        const [firstRes, secondRes] = await Promise.all([firstSync, secondSync]);
        expect(firstRes.status).toBe(200);
        expect(secondRes.status).toBe(200);

        const [releasedAt] = lockReleasedAt;
        if (!releasedAt) throw new Error('expected the first sync to record its lock release');
        const created = await itemsDAO.findArray({ user: userId, routineId: 'routine-1', status: 'calendar' });
        expect(created).toHaveLength(1);
        const [item] = created;
        if (!item) throw new Error('expected one orphan-created item');
        expect(item.createdTs >= releasedAt).toBe(true);
        expect(item.updatedTs).toBe(item.createdTs);
        const [createOp] = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: item._id });
        if (!createOp) throw new Error('expected a create op for the orphan-created item');
        expect(createOp.ts >= releasedAt).toBe(true);
    });

    it('does NOT revive a skipped exception when the master rrule no longer generates that occurrence', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // A skipped date can vanish from getExceptions because the master recurrence changed (e.g. the
        // routine was paused → capped with UNTIL) so the occurrence no longer exists — reviving it would
        // resurrect a phantom. Here the routine is weekly-Monday but the exception is on a SUNDAY, which
        // the rrule never generates → the GCal-truth guard must refuse to revive.
        const monday = futureMonday(2);
        const sunday = dayjs(monday).subtract(1, 'day').format('YYYY-MM-DD'); // never an rrule occurrence
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-phantom',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date: sunday, type: 'skipped' }],
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-phantom',
            user: userId,
            status: 'trash',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${sunday}T09:00:00`,
            timeEnd: `${sunday}T09:30:00`,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-phantom' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Item stays trashed; skipped exception preserved.
        const item = await itemsDAO.findByOwnerAndId('item-phantom', userId);
        expect(item?.status).toBe('trash');
        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: sunday, type: 'skipped' }));
    });

    it('does NOT revive a skipped exception GCal still reports as deleted (occurrence still cancelled)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // GCal still reports the date as `deleted` → the occurrence is still cancelled → no revival.
        const date = futureMonday(2);
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-stillcancelled',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date, type: 'skipped' }],
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-stillcancelled',
            user: userId,
            status: 'trash',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${date}T09:00:00`,
            timeEnd: `${date}T09:30:00`,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([{ originalDate: date, type: 'deleted' }]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-stillcancelled' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-stillcancelled', userId);
        expect(item?.status).toBe('trash');
        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date, type: 'skipped' }));
    });

    it('does NOT revive a skipped exception outside the getExceptions window (older than 30 days)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // 60 days in the past: getExceptions' timeMin floor is now-30d, so this date is never reported —
        // its absence from the deleted set must NOT trigger a revival (would resurrect a stale deletion).
        // Pick a past Monday so the rrule-generates guard isn't what blocks it — the window guard must.
        const today = dayjs().startOf('day');
        const daysSinceMonday = (today.day() + 6) % 7; // 0 if Monday
        const recentPastMonday = today.subtract(daysSinceMonday, 'day');
        const oldMonday = recentPastMonday.subtract(9, 'week').format('YYYY-MM-DD'); // ~63 days ago, a Monday
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-oldskip',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                // Anchor startDate well before the old date so the rrule WOULD generate it — isolating the window guard.
                startDate: oldMonday,
                routineExceptions: [{ date: oldMonday, type: 'skipped' }],
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-oldskip' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: oldMonday, type: 'skipped' }));
    });

    it('does NOT revive a skipped exception dated before the sync cursor (within now-30d but predating lastSyncedTs)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Recent cursor: getExceptions' real timeMin is max(since, now-30d) = since. A skipped date 10
        // days ago is inside [now-30d, now] but BEFORE the cursor, so GCal never returns it — its absence
        // must NOT be treated as a revival (mirrors the time-move pre-cursor preserve test).
        const integration = makeIntegration(userId);
        await calendarIntegrationsDAO.insertEncrypted(integration);
        const recentCursor = dayjs().subtract(5, 'day').toISOString();
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id, { lastSyncedTs: recentCursor }));

        const today = dayjs().startOf('day');
        const daysSinceMonday = (today.day() + 6) % 7;
        const recentPastMonday = today.subtract(daysSinceMonday, 'day');
        const preCursorMonday = recentPastMonday.subtract(1, 'week').format('YYYY-MM-DD'); // a Monday ~7-13 days ago
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-precursorskip',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                startDate: preCursorMonday,
                routineExceptions: [{ date: preCursorMonday, type: 'skipped' }],
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-precursorskip' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: preCursorMonday, type: 'skipped' }));
    });

    it('does not re-fire (zero churn) on a sync against already-revived state (no skipped exception left)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Steady state AFTER a revival: the skipped exception was already dropped on a prior sync and the
        // item is already live at master time. A subsequent sync (getExceptions still []) must find no
        // skipped exception to revive → no item write, no routine write, no ops. This is exactly the
        // second-fire condition; we set it up directly to avoid a second real-HTTP sync in the harness.
        const date = futureMonday(2);
        const itemTs = '2026-01-01T00:00:00.000Z';
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-churn',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [], // already reconciled away
                updatedTs: itemTs,
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-churn',
            user: userId,
            status: 'calendar', // already revived
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'gcal-evt-churn_inst',
            timeStart: `${date}T09:00:00`,
            timeEnd: `${date}T09:30:00`,
            createdTs: itemTs,
            updatedTs: itemTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-churn' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // No new ops for the item or routine, and neither was rewritten.
        const itemOps = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-churn' });
        expect(itemOps).toHaveLength(0);
        const routineOps = await operationsDAO.findArray({ user: userId, entityType: 'routine', entityId: 'routine-1' });
        expect(routineOps).toHaveLength(0);
        const item = await itemsDAO.findByOwnerAndId('item-churn', userId);
        expect(item?.updatedTs).toBe(itemTs);
        const routine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(routine?.updatedTs).toBe(itemTs);
    });

    it('skips the routine master write + op when an unchanged GCal event re-syncs (no-op churn guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Steady state: the GCal master is untouched, so `event.updated` equals the routine's stored
        // `lastSyncedFromGCalTs`. `structurallyNewer` uses `>=` (GCal wins same-second ties), so this
        // still passes the structural-newer gate and falls through to the master merge — but the merged
        // routine is byte-identical to what's stored, so no routine write and no `update` op should fire.
        const gcalUpdated = '2026-01-01T00:00:00.000Z';
        // 09:00 Jerusalem (UTC+3 in June) / 30-minute duration → matches makeRoutine's default template.
        const masterTimeStart = '2025-06-09T09:00:00+03:00';
        const masterTimeEnd = '2025-06-09T09:30:00+03:00';
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-master-noop',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                lastSyncedFromGCalTs: gcalUpdated,
                updatedTs: '2026-02-01T00:00:00.000Z',
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-noop',
                    title: 'Standup',
                    timeStart: masterTimeStart,
                    timeEnd: masterTimeEnd,
                    updated: gcalUpdated,
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-master-noop',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routineOps = await operationsDAO.findArray({ entityId: 'routine-1', entityType: 'routine' });
        expect(routineOps).toHaveLength(0);
        // updatedTs untouched — the routine was not rewritten.
        const unchanged = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(unchanged?.updatedTs).toBe('2026-02-01T00:00:00.000Z');
    });

    it('still writes the item when only notes change but times are unchanged (no-op guard lets real changes through)', async () => {
        // Positive-direction guard check: same times as the item already holds, but a new notes value.
        // The per-field comparison in isItemUpdateNoop must report "changed" so the write proceeds.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const timeStart = '2025-06-09T09:00:00Z';
        const timeEnd = '2025-06-09T09:30:00Z';
        await routinesDAO.insertOne(makeRoutine(userId, { calendarEventId: 'gcal-evt-notesonly', calendarIntegrationId: 'int-1' }));
        await itemsDAO.insertOne({
            _id: 'item-notes-change',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            notes: 'old agenda',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-notes',
            timeStart,
            timeEnd,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: '2025-06-09',
                googleEventId: 'inst-notes',
                type: 'modified',
                title: 'Standup',
                notes: '<p>new agenda</p>',
                newTimeStart: timeStart,
                newTimeEnd: timeEnd,
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-notes-change', userId);
        expect(item?.notes).toBe('new agenda');
        const itemOps = await operationsDAO.findArray({ entityId: 'item-notes-change', entityType: 'item' });
        expect(itemOps.length).toBeGreaterThan(0);
    });

    it('still writes the item when a modified exception drops a GCal-owned override the item carried (unset branch)', async () => {
        // Unset-branch guard check: the item carries an `attendees` override; the inbound exception omits
        // it (instance reverted to master inheritance), so unsetFields is non-empty. isItemUpdateNoop must
        // return false on any pending unset so the clearing write proceeds.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const timeStart = '2025-06-09T09:00:00Z';
        const timeEnd = '2025-06-09T09:30:00Z';
        await routinesDAO.insertOne(makeRoutine(userId, { calendarEventId: 'gcal-evt-unset', calendarIntegrationId: 'int-1' }));
        await itemsDAO.insertOne({
            _id: 'item-unset-attendees',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-unset',
            attendees: [{ email: 'extra@example.com', responseStatus: 'accepted' }],
            timeStart,
            timeEnd,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        // Exception omits `attendees` ⇒ instance inherits master ⇒ the override must be unset on the item.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: '2025-06-09', googleEventId: 'inst-unset', type: 'modified', title: 'Standup', newTimeStart: timeStart, newTimeEnd: timeEnd },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-unset-attendees', userId);
        expect(item?.attendees).toBeUndefined();
        const itemOps = await operationsDAO.findArray({ entityId: 'item-unset-attendees', entityType: 'item' });
        expect(itemOps.length).toBeGreaterThan(0);
    });

    it('merges a modified exception and updates item times', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        const newTimeStart = '2025-06-09T10:00:00Z';
        const newTimeEnd = '2025-06-09T10:30:00Z';
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: '2025-06-09', type: 'modified', newTimeStart, newTimeEnd },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updated?.routineExceptions).toContainEqual({
            date: '2025-06-09',
            type: 'modified',
            newTimeStart,
            newTimeEnd,
        });
    });

    it('merges a content-modified exception and updates item title and notes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        // Insert an item for the occurrence date that will be content-modified
        await itemsDAO.insertOne({
            _id: 'item-content-ex',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: '2025-06-09T09:00:00Z',
            timeEnd: '2025-06-09T09:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: '2025-06-09', type: 'modified', title: 'Retro', notes: '<p>Agenda: review Q2</p>' },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Verify the routine exception record stores markdown-converted notes
        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(
            expect.objectContaining({ date: '2025-06-09', type: 'modified', title: 'Retro', notes: 'Agenda: review Q2' }),
        );

        // Verify the item was updated with converted notes and lastSyncedNotes
        const item = await itemsDAO.findByOwnerAndId('item-content-ex', userId);
        expect(item?.title).toBe('Retro');
        expect(item?.notes).toBe('Agenda: review Q2');
        expect(item?.lastSyncedNotes).toBe('<p>Agenda: review Q2</p>');
    });

    it('preserves a user-typed ✓ in the GCal title when the local routine-generated item is open (not done)', async () => {
        // Symmetric to updateExistingCalendarItem's "open item keeps user-typed ✓" rule: the strip
        // is GCal-marker-aware only when the local item is already done; for an open item, the ✓
        // is treated as user content and must round-trip verbatim.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        await itemsDAO.insertOne({
            _id: 'item-user-checkmark',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: '2025-06-09T09:00:00Z',
            timeEnd: '2025-06-09T09:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([{ originalDate: '2025-06-09', type: 'modified', title: '✓ Standup' }]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-user-checkmark', userId);
        // Open item — the ✓ is user content, not our marker. Round-trip verbatim.
        expect(item?.title).toBe('✓ Standup');
        expect(item?.status).toBe('calendar');
    });

    it('strips the ✓ done marker on inbound modified-exception when the local item is already done', async () => {
        // Echo path: our own pushback applies "✓ Standup" + sage to the GCal instance for a done
        // routine-generated item. The next inbound sync sees that as a `modified` exception with
        // title="✓ Standup". Without stripping, the local item's clean stored title would be
        // overwritten with the marker. The marker must be GCal-only — symmetric to the strip in
        // updateExistingCalendarItem for non-routine calendar items.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        await itemsDAO.insertOne({
            _id: 'item-done-echo',
            user: userId,
            status: 'done',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: '2025-06-09T09:00:00Z',
            timeEnd: '2025-06-09T09:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([{ originalDate: '2025-06-09', type: 'modified', title: '✓ Standup' }]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-done-echo', userId);
        // Stored title stays clean; the ✓ marker remains on the GCal side only.
        expect(item?.title).toBe('Standup');
        expect(item?.status).toBe('done');
    });

    it('does not generate spurious exceptions when instance matches master content', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-1',
            calendarIntegrationId: 'int-1',
            title: 'Standup',
            lastSyncedNotes: '<p>Daily standup</p>',
            template: { notes: 'Daily standup' },
        });
        await routinesDAO.insertOne(routine);

        // getExceptions returns [] because instance matches master — no changes
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updated?.routineExceptions).toBeUndefined();
    });

    it('imports a new GCal event as a calendar item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const eventTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-abc', title: 'Team lunch', timeStart: eventTs, timeEnd: eventTs, updated: eventTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const items = await db.collection('items').find({ user: userId, calendarEventId: 'evt-abc' }).toArray();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ status: 'calendar', title: 'Team lunch', calendarIntegrationId: 'int-1', lastSyncedFromGCalTs: eventTs });
    });

    it('manual sync notifies SSE when ops are produced so the calling client knows to pull', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Spy must be installed before the route runs — the SSE notify happens inline.
        const notifySpy = vi.spyOn(sseConnections, 'notifyUserViaSse');

        const eventTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-notify', title: 'After connect', timeStart: eventTs, timeEnd: eventTs, updated: eventTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Without this notify, a freshly-connected calendar's events would be created server-side
        // but stay invisible on the originating client until the next webhook arrived.
        expect(notifySpy).toHaveBeenCalledWith(userId, expect.objectContaining({ type: 'update' }));
    });

    it('manual sync skips SSE notify when no ops were produced (avoid spurious pulls)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const notifySpy = vi.spyOn(sseConnections, 'notifyUserViaSse');

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        expect(notifySpy).not.toHaveBeenCalled();
    });

    // ── Outbound backfill: app-created entities pushed to GCal on "Sync now" ────────────
    //
    // Repairs the scenario where a user creates calendar items / routines BEFORE connecting
    // their Google Calendar (or while offline). Without this, those entities stay locally-only
    // forever — no automatic mechanism would push them up. After connecting + clicking
    // "Sync now," they should land on Google Calendar.

    /** Inserts an unlinked calendar item (no calendarEventId, no routineId). */
    async function insertUnlinkedItem(userId: string, overrides: Partial<ItemInterface> = {}): Promise<ItemInterface> {
        const now = dayjs().toISOString();
        const item: ItemInterface = {
            _id: overrides._id ?? 'item-unlinked-1',
            user: userId,
            status: 'calendar',
            title: 'Standalone meeting',
            timeStart: dayjs().add(1, 'day').toISOString(),
            timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
            createdTs: now,
            updatedTs: now,
            ...overrides,
        };
        await itemsDAO.insertOne(item);
        return item;
    }

    it('pushes unlinked calendar items to GCal as part of Sync now', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-backfill-1', title: 'Backfilled item' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi
            .spyOn(GoogleCalendarProvider.prototype, 'createEvent')
            .mockResolvedValue({ eventId: 'gcal-id-1', htmlLink: 'https://calendar.google.com/calendar/event?eid=backfill-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; pushedItems: number };
        expect(body.pushedItems).toBe(1);

        expect(createSpy).toHaveBeenCalledOnce();
        const updated = await itemsDAO.findByOwnerAndId('item-backfill-1', userId);
        expect(updated?.calendarEventId).toBe('gcal-id-1');
        expect(updated?.calendarIntegrationId).toBe('int-1');
        expect(updated?.calendarSyncConfigId).toBe('sync-config-1');
        expect(updated?.lastPushedToGCalTs).toBeTruthy();
        // htmlLink is captured from the insert response in the SAME write as the link fields — the
        // own-echo guard would suppress the inbound webhook report that otherwise carries it.
        expect(updated?.htmlLink).toBe('https://calendar.google.com/calendar/event?eid=backfill-1');
        // An operation must be recorded so other devices learn about the newly-linked event id.
        // Exactly ONE op — stamping htmlLink must not add a second write/echo.
        const recordedOps = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-backfill-1' });
        expect(recordedOps).toHaveLength(1);
        expect(recordedOps[0]!.snapshot).toMatchObject({
            calendarEventId: 'gcal-id-1',
            calendarIntegrationId: 'int-1',
            htmlLink: 'https://calendar.google.com/calendar/event?eid=backfill-1',
        });
    });

    it('links the item without htmlLink when the insert response omits it', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-backfill-nolink', title: 'No-link item' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'gcal-id-nolink' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await itemsDAO.findByOwnerAndId('item-backfill-nolink', userId);
        expect(updated?.calendarEventId).toBe('gcal-id-nolink');
        expect(updated?.htmlLink).toBeUndefined();
    });

    it('pushes unlinked calendar-type routines to GCal as part of Sync now', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // App-side routine creation never stamps calendarIntegrationId — the backfill should add it.
        const routine = makeRoutine(userId, { _id: 'routine-backfill-1', title: 'Backfilled routine' });
        await routinesDAO.insertOne(routine);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-recurring-1');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pushedRoutines: number };
        expect(body.pushedRoutines).toBe(1);

        expect(createSpy).toHaveBeenCalledOnce();
        const updated = await routinesDAO.findByOwnerAndId('routine-backfill-1', userId);
        expect(updated?.calendarEventId).toBe('gcal-recurring-1');
        expect(updated?.calendarIntegrationId).toBe('int-1');
        expect(updated?.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('skips items that are already linked (calendarEventId set)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-already', calendarEventId: 'evt-existing', calendarIntegrationId: 'int-1' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pushedItems: number };
        expect(body.pushedItems).toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips routine-generated items (routineId set)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // routineId set → represented by the routine's master event; no individual GCal event.
        await insertUnlinkedItem(userId, { _id: 'item-routine-instance', routineId: 'r-x' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pushedItems: number };
        expect(body.pushedItems).toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips inactive routines during backfill', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { _id: 'routine-inactive', active: false });
        await routinesDAO.insertOne(routine);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pushedRoutines: number };
        expect(body.pushedRoutines).toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips disconnect-kept routines (lastKnownCalendarEventId set) — never pushes them as a gtd* clone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // A routine unlinked by disconnect-with-keep: no calendarEventId, but a lastKnown* marker awaiting
        // inbound relink. The backfill must NOT push it — doing so mints a gtd* clone master on Google.
        await routinesDAO.insertOne(
            makeRoutine(userId, { _id: 'routine-kept', lastKnownCalendarEventId: 'gcal-master-real', lastKnownCalendarIntegrationId: 'int-OLD' }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pushedRoutines: number };
        expect(body.pushedRoutines).toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips disconnect-kept calendar items (lastKnownCalendarEventId set) during backfill', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-kept', lastKnownCalendarEventId: 'gcal-evt-real', lastKnownCalendarIntegrationId: 'int-OLD' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pushedItems: number };
        expect(body.pushedItems).toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
    });

    it('only backfills onto the default config when multiple configs exist', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Default config + a non-default config on the same integration. Item should land on the default.
        const { integration } = await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.insertOne(
            makeSyncConfig(userId, integration._id, { _id: 'sync-config-2', calendarId: 'work@group.calendar.google.com', isDefault: false }),
        );
        await insertUnlinkedItem(userId, { _id: 'item-default-only' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'gcal-default' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Item count == 1 even though 2 configs are synced inbound: backfill only runs against the default.
        expect(createSpy).toHaveBeenCalledOnce();
        // Argument 0 to createEvent is the calendarId — must be the default's, not the non-default's.
        const firstCall = createSpy.mock.calls[0]!;
        expect(firstCall[0]).toBe('primary');
    });

    it('paces backfill calls with sleeps to stay under GCal rate limits', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-pace-1', title: 'A' });
        await insertUnlinkedItem(userId, { _id: 'item-pace-2', title: 'B' });
        await insertUnlinkedItem(userId, { _id: 'item-pace-3', title: 'C' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        let n = 0;
        vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockImplementation(async () => ({ eventId: `gcal-${n++}` }));

        const start = Date.now();
        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        const elapsed = Date.now() - start;
        expect(res.status).toBe(200);
        // Three items → two inter-call sleeps of 150ms → ≥ 300ms minimum total.
        // Use a generous lower bound (250ms) to absorb scheduler jitter without rewarding regressions.
        expect(elapsed).toBeGreaterThanOrEqual(250);
    });

    it('notifies SSE and web push with backfill ops even if there are no inbound events', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-sse-backfill' });

        const sseSpy = vi.spyOn(sseConnections, 'notifyUserViaSse');
        const pushSpy = vi.spyOn(webPush, 'notifyViaWebPush').mockResolvedValue();
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        // Inbound is empty — only the backfill produces ops.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });
        vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'gcal-sse' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // SSE refreshes the calling client. Web push reaches devices without an open SSE channel —
        // backfill ops must reach both, otherwise closed-tab devices never learn the items got linked.
        expect(sseSpy).toHaveBeenCalledWith(userId, expect.objectContaining({ type: 'update' }));
        expect(pushSpy).toHaveBeenCalledOnce();
        const opsArg = pushSpy.mock.calls[0]![2];
        expect(opsArg).toHaveLength(1);
        expect(opsArg![0]).toMatchObject({
            entityType: 'item',
            entityId: 'item-sse-backfill',
            opType: 'update',
        });
    });

    it('running Sync now twice does not create duplicate GCal events for unlinked items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-idempotent-1' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        // Both calls go through the inbound pull first. Mock both list paths because the first
        // sync stores a syncToken which makes the second sync take the incremental path.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({ events: [], nextSyncToken: 'tok-2' });

        // First call: GCal accepts the create (returns the supplied id), but simulate a local DB
        // write failure so the item never gets `calendarEventId`. This is the exact failure mode
        // the deterministic-id design protects against — the next retry must NOT create a second
        // event on Google.
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockImplementation(async (_calId, _event, _tz, options) => {
            // Echo back the supplied id so we can assert it's deterministic across calls below.
            return { eventId: options?.id ?? 'gcal-fallback' };
        });
        // Force the first updateOne to fail mid-flight so the local link doesn't get written.
        const updateOneSpy = vi.spyOn(itemsDAO, 'updateOne').mockRejectedValueOnce(new Error('mongo blip'));

        const res1 = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res1.status).toBe(200);

        // After call #1: GCal got a create, but the item is still unlinked locally.
        expect(createSpy).toHaveBeenCalledOnce();
        // Compute the expected id directly from the helper so the assertion fails loudly if the
        // hashing scheme changes — a fragile mock-call-by-index lookup would silently pass.
        const expectedId = buildDeterministicGCalId('item-idempotent-1', 'int-1');
        const idAfterFirst = createSpy.mock.calls[0]![3]?.id;
        expect(idAfterFirst).toBe(expectedId);
        const itemAfterFirst = await itemsDAO.findByOwnerAndId('item-idempotent-1', userId);
        expect(itemAfterFirst?.calendarEventId).toBeUndefined();

        // Restore updateOne for the second pass; rig createEvent to throw 409 (the deterministic
        // id is already on Google's side), simulating the expected GCal response on retry.
        updateOneSpy.mockRestore();
        createSpy.mockReset();
        const conflictErr = Object.assign(new Error('Conflict'), { code: 409 });
        createSpy.mockRejectedValue(conflictErr);

        const res2 = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res2.status).toBe(200);

        // The retry must send the SAME deterministic id (proving idempotency) and treat 409 as
        // success-with-existing — the item is now linked locally with that id.
        expect(createSpy).toHaveBeenCalledOnce();
        expect(createSpy.mock.calls[0]![3]?.id).toBe(expectedId);

        const linked = await itemsDAO.findByOwnerAndId('item-idempotent-1', userId);
        expect(linked?.calendarEventId).toBe(expectedId);
        // 409-relink has no insert response to read htmlLink from (and we deliberately skip an
        // extra events.get on this rare retry path) — the link stays unset, as before.
        expect(linked?.htmlLink).toBeUndefined();
    });

    // ── Idempotent backfill: relink naked routines onto real twins instead of cloning ──────────
    // These exercise runOutboundBackfill's relink-first path (matchExistingMasterForRoutine). To
    // reproduce the production bug (the real master is NOT in the incremental delta but IS on the
    // calendar), the config carries a syncToken so inbound sync takes the incremental path
    // (listEventsIncremental → empty), while the matcher's full-master fetch (listEventsFull)
    // returns the live twin. A naked recurring master (rrule, BYDAY=MO, 09:00 Jerusalem/30min)
    // matches makeRoutine's default template.
    describe('relink-first (matchExistingMasterForRoutine)', () => {
        const masterStart = '2025-06-09T09:00:00+03:00'; // 09:00 Jerusalem / 30-min → makeRoutine default template
        const masterEnd = '2025-06-09T09:30:00+03:00';
        const masterUpdated = '2025-06-09T08:00:00.000Z';

        async function insertIntegrationWithSyncedConfig(userId: string) {
            const integration = makeIntegration(userId);
            await calendarIntegrationsDAO.insertEncrypted(integration);
            // syncToken present → inbound sync uses the incremental path, so the unmodified real master
            // never re-imports inbound (matching the disconnect/reconnect repro this fix targets).
            await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id, { syncToken: 'tok-existing' }));
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({ events: [], nextSyncToken: 'tok-next' });
        }

        function makeMaster(overrides: Partial<GCalEvent> = {}): GCalEvent {
            return {
                id: 'real-native-gcal-id',
                title: 'Standup',
                timeStart: masterStart,
                timeEnd: masterEnd,
                updated: masterUpdated,
                status: 'confirmed',
                recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                ...overrides,
            };
        }

        it('(i-a) empty master list → CREATE (genuine never-synced app routine)', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-create-1' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-full' });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-created-1');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.pushedRoutines).toBe(1);
            expect(body.relinkedRoutines).toBe(0);

            expect(createSpy).toHaveBeenCalledOnce();
            const updated = await routinesDAO.findByOwnerAndId('routine-create-1', userId);
            expect(updated?.calendarEventId).toBe('gcal-created-1');
            expect(updated?.calendarIntegrationId).toBe('int-1');
            expect(updated?.calendarSyncConfigId).toBe('sync-config-1');
        });

        it('(i-b) non-matching master present → CREATE', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-create-2' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            // Different title → not a twin.
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [makeMaster({ title: 'A different meeting' })],
                nextSyncToken: 'tok-full',
            });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-created-2');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.pushedRoutines).toBe(1);
            expect(body.relinkedRoutines).toBe(0);
            expect(createSpy).toHaveBeenCalledOnce();
        });

        it('(ii) matching native-id master → RELINK, no clone minted', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-relink-1' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [makeMaster()], nextSyncToken: 'tok-full' });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.pushedRoutines).toBe(0);
            expect(body.relinkedRoutines).toBe(1);

            // No clone master pushed to Google.
            expect(createSpy).not.toHaveBeenCalled();
            const relinked = await routinesDAO.findByOwnerAndId('routine-relink-1', userId);
            expect(relinked?.calendarEventId).toBe('real-native-gcal-id');
            expect(relinked?.calendarIntegrationId).toBe('int-1');
            expect(relinked?.calendarSyncConfigId).toBe('sync-config-1');
            // Exactly one routine on that event id — the active-partial unique index holds.
            const onEvent = await routinesDAO.findArray({ user: userId, calendarEventId: 'real-native-gcal-id' });
            expect(onEvent).toHaveLength(1);
            // One op recorded so other devices learn about the relink.
            const ops = await operationsDAO.findArray({ user: userId, entityType: 'routine', entityId: 'routine-relink-1' });
            expect(ops).toHaveLength(1);
            expect(ops[0]!.snapshot).toMatchObject({ calendarEventId: 'real-native-gcal-id' });
        });

        it('(ii-allday) all-day naked routine + all-day master → RELINK', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(
                makeRoutine(userId, { _id: 'routine-allday', title: 'OOO', calendarItemTemplate: { allDay: true }, rrule: 'FREQ=DAILY' }),
            );

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [
                    makeMaster({
                        id: 'real-allday-id',
                        title: 'OOO',
                        allDay: true,
                        timeStart: '2025-06-09',
                        timeEnd: '2025-06-10',
                        recurrence: ['RRULE:FREQ=DAILY'],
                    }),
                ],
                nextSyncToken: 'tok-full',
            });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { relinkedRoutines: number };
            expect(body.relinkedRoutines).toBe(1);
            expect(createSpy).not.toHaveBeenCalled();
            const relinked = await routinesDAO.findByOwnerAndId('routine-allday', userId);
            expect(relinked?.calendarEventId).toBe('real-allday-id');
        });

        it('(iii) capped-only master (UNTIL) → CREATE (B1 full-master fetch guarantees live twins are seen, so create is safe)', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-capped-create' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            // The only master with this title/template is capped (past UNTIL) → not a live twin → CREATE.
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [makeMaster({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250101T000000Z'] })],
                nextSyncToken: 'tok-full',
            });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-created-3');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.pushedRoutines).toBe(1);
            expect(body.relinkedRoutines).toBe(0);
            expect(createSpy).toHaveBeenCalledOnce();
        });

        it('skips a master already backing another routine (knownRoutineEventIds) → CREATE', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            // An existing linked routine already owns the only matching master. The naked routine must
            // NOT be relinked onto it (that would collide on the unique index / split pairs) → CREATE.
            await routinesDAO.insertOne(
                makeRoutine(userId, {
                    _id: 'routine-owner',
                    calendarEventId: 'real-native-gcal-id',
                    calendarIntegrationId: 'int-1',
                    calendarSyncConfigId: 'sync-config-1',
                }),
            );
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-naked-skip' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [makeMaster()], nextSyncToken: 'tok-full' });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-created-4');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.relinkedRoutines).toBe(0);
            expect(body.pushedRoutines).toBe(1);
            expect(createSpy).toHaveBeenCalledOnce();
        });

        it('(idempotency) sync twice with twin present → relink once, second run is a no-op', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-idem' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [makeMaster()], nextSyncToken: 'tok-full' });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

            const res1 = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res1.status).toBe(200);
            expect(((await res1.json()) as { relinkedRoutines: number }).relinkedRoutines).toBe(1);

            const res2 = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res2.status).toBe(200);
            // Second run: the routine is now linked, so the backfill query excludes it — nothing to do.
            const body2 = (await res2.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body2.relinkedRoutines).toBe(0);
            expect(body2.pushedRoutines).toBe(0);
            expect(createSpy).not.toHaveBeenCalled();
            const onEvent = await routinesDAO.findArray({ user: userId, calendarEventId: 'real-native-gcal-id' });
            expect(onEvent).toHaveLength(1);
        });

        it('(dangling integrationId) routine with calendarIntegrationId but no calendarEventId → NOT eligible → CREATE skipped (no clone)', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            // Eligibility requires BOTH calendarEventId and calendarIntegrationId absent (matching the
            // relink `$set` filter). A routine carrying a dangling integrationId must be excluded entirely
            // — neither relinked nor cloned — so it can't fall through to a `gtd*` create.
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-dangling', calendarIntegrationId: 'int-OLD' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [makeMaster()], nextSyncToken: 'tok-full' });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.relinkedRoutines).toBe(0);
            expect(body.pushedRoutines).toBe(0);
            expect(createSpy).not.toHaveBeenCalled();
            // Unchanged — still naked-but-dangling, awaiting the inbound restore path.
            const unchanged = await routinesDAO.findByOwnerAndId('routine-dangling', userId);
            expect(unchanged?.calendarEventId).toBeUndefined();
        });

        it('(rebased-suffix master) a `_R<anchor>` split successor is never a backfill twin → CREATE', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-rebased' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            // The only matching master carries an `_R<anchor>` rebased suffix — the live tail of a GCal
            // split, owned by the split path. The backfill matcher must skip it and CREATE instead.
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [makeMaster({ id: 'real-native-gcal-id_R20250609T060000Z' })],
                nextSyncToken: 'tok-full',
            });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-created-rebased');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.relinkedRoutines).toBe(0);
            expect(body.pushedRoutines).toBe(1);
            expect(createSpy).toHaveBeenCalledOnce();
        });

        it('(multiple twins) two matching open masters → relinks onto exactly one (first wins), no clone', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-multi' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            // Two distinct open masters share the same title/rrule/template. The matcher takes the first;
            // the contract is "relink onto one, never clone".
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [makeMaster({ id: 'twin-A' }), makeMaster({ id: 'twin-B' })],
                nextSyncToken: 'tok-full',
            });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { relinkedRoutines: number };
            expect(body.relinkedRoutines).toBe(1);
            expect(createSpy).not.toHaveBeenCalled();
            const relinked = await routinesDAO.findByOwnerAndId('routine-multi', userId);
            expect(relinked?.calendarEventId).toBe('twin-A');
        });
    });

    it('trashes an existing item when its GCal event is cancelled', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-1',
            user: userId,
            status: 'calendar',
            title: 'Old event',
            calendarEventId: 'evt-cancelled',
            calendarIntegrationId: 'int-1',
            createdTs: now,
            updatedTs: now,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-cancelled', title: 'Old event', timeStart: now, timeEnd: now, updated: now, status: 'cancelled' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-1' });
        expect(item?.status).toBe('trash');
    });
});

// ─── PATCH /calendar/integrations/:id ─────────────────────────────────────

describe('PATCH /calendar/integrations/:id', () => {
    it('returns 401 when not authenticated', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/calendar/integrations/int-1', { method: 'PATCH', body: JSON.stringify({ calendarId: 'cal-1' }) }),
        );
        expect(res.status).toBe(401);
    });

    it('returns 404 for an unknown integration', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/calendar/integrations/no-such-id',
            sessionCookie,
            body: { calendarId: 'cal-1' },
        });
        expect(res.status).toBe(404);
    });

    it('returns 400 when calendarId is missing', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const res = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/calendar/integrations/int-1',
            sessionCookie,
            body: {},
        });
        expect(res.status).toBe(400);
    });

    it('returns 400 when calendarId is an empty string', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const res = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/calendar/integrations/int-1',
            sessionCookie,
            body: { calendarId: '' },
        });
        expect(res.status).toBe(400);
    });

    it("returns 404 when patching another user's integration", async () => {
        const sessionCookie = await loginAsAlice();
        // Insert integration owned by a different user — Alice must not be able to modify it.
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration('other-user-id'));

        const res = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/calendar/integrations/int-1',
            sessionCookie,
            body: { calendarId: 'hacked-cal' },
        });
        expect(res.status).toBe(404);
    });

    it('persists the new calendarId', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const res = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/calendar/integrations/int-1',
            sessionCookie,
            body: { calendarId: 'my-cal@group.calendar.google.com' },
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true });

        const updated = await calendarIntegrationsDAO.findByOwnerAndId('int-1', userId);
        expect(updated?.calendarId).toBe('my-cal@group.calendar.google.com');
    });
});

// ─── GET /calendar/integrations — lazy migration ─────────────────────────────

describe('GET /calendar/integrations — lazy migration', () => {
    it('creates a default sync config for a legacy integration', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const res = await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations', sessionCookie });
        expect(res.status).toBe(200);

        const configs = await calendarSyncConfigsDAO.findByIntegration('int-1');
        expect(configs).toHaveLength(1);
        expect(configs[0]).toMatchObject({ integrationId: 'int-1', calendarId: 'primary', isDefault: true, enabled: true });
    });

    it('does not create a duplicate sync config on second call', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations', sessionCookie });
        await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations', sessionCookie });

        const configs = await calendarSyncConfigsDAO.findByIntegration('int-1');
        expect(configs).toHaveLength(1);
    });
});

// ─── Sync config CRUD ────────────────────────────────────────────────────────

describe('GET /calendar/integrations/:id/sync-configs', () => {
    it('returns 404 for unknown integration', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations/no-such/sync-configs', sessionCookie });
        expect(res.status).toBe(404);
    });

    it('returns sync configs for the integration', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const { config } = await insertIntegrationWithConfig(userId);

        const res = await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations/int-1/sync-configs', sessionCookie });
        expect(res.status).toBe(200);
        const configs = (await res.json()) as CalendarSyncConfigInterface[];
        expect(configs).toHaveLength(1);
        expect(configs[0]).toMatchObject({ _id: config._id, calendarId: 'primary' });
    });
});

describe('POST /calendar/integrations/:id/sync-configs', () => {
    it('creates a sync config and returns 201', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/sync-configs',
            sessionCookie,
            body: { calendarId: 'work@group.calendar.google.com', displayName: 'Work' },
        });
        expect(res.status).toBe(201);
        const created = (await res.json()) as CalendarSyncConfigInterface;
        expect(created.calendarId).toBe('work@group.calendar.google.com');
        expect(created.displayName).toBe('Work');
        expect(created.enabled).toBe(true);
    });

    it('promotes the first config to default even when isDefault is omitted', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/sync-configs',
            sessionCookie,
            body: { calendarId: 'primary' },
        });
        expect(res.status).toBe(201);

        const configs = await calendarSyncConfigsDAO.findByIntegration('int-1');
        expect(configs.filter((c) => c.isDefault)).toHaveLength(1);
        const [only] = configs;
        if (!only) throw new Error('expected one sync config');
        expect(only.isDefault).toBe(true);
    });

    it('does not steal default when a second config is added without isDefault', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId); // sync-config-1 (primary) is default

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/sync-configs',
            sessionCookie,
            body: { calendarId: 'work@group.calendar.google.com' },
        });
        expect(res.status).toBe(201);

        const configs = await calendarSyncConfigsDAO.findByIntegration('int-1');
        const defaults = configs.filter((c) => c.isDefault);
        expect(defaults).toHaveLength(1);
        const [def] = defaults;
        if (!def) throw new Error('expected one default config');
        expect(def.calendarId).toBe('primary');
    });

    it('returns 409 when calendarId already exists for this integration', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/sync-configs',
            sessionCookie,
            body: { calendarId: 'primary' },
        });
        expect(res.status).toBe(409);
    });

    it('returns 400 when calendarId is missing', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/sync-configs',
            sessionCookie,
            body: {},
        });
        expect(res.status).toBe(400);
    });

    it('returns 404 when integration not found', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/no-such/sync-configs',
            sessionCookie,
            body: { calendarId: 'cal-1' },
        });
        expect(res.status).toBe(404);
    });

    it('sets isDefault and clears other defaults when isDefault=true', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/sync-configs',
            sessionCookie,
            body: { calendarId: 'work@group.calendar.google.com', isDefault: true },
        });
        expect(res.status).toBe(201);

        const configs = await calendarSyncConfigsDAO.findByIntegration('int-1');
        const defaultConfigs = configs.filter((c) => c.isDefault);
        expect(defaultConfigs).toHaveLength(1);
        expect(defaultConfigs[0]!.calendarId).toBe('work@group.calendar.google.com');
    });
});

describe('PATCH /calendar/integrations/:integrationId/sync-configs/:configId', () => {
    it('returns 404 for unknown config', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const res = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/calendar/integrations/int-1/sync-configs/no-such',
            sessionCookie,
            body: { enabled: false },
        });
        expect(res.status).toBe(404);
    });

    it('toggles enabled and updates displayName', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const res = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
            sessionCookie,
            body: { enabled: false, displayName: 'Personal' },
        });
        expect(res.status).toBe(200);

        const updated = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
        expect(updated?.enabled).toBe(false);
        expect(updated?.displayName).toBe('Personal');
    });

    it('promotes another enabled config to default when the default is disabled', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const integration = makeIntegration(userId);
        await calendarIntegrationsDAO.insertEncrypted(integration);
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id)); // sync-config-1, default
        await calendarSyncConfigsDAO.insertOne(
            makeSyncConfig(userId, integration._id, { _id: 'sync-config-2', calendarId: 'work@group.calendar.google.com', isDefault: false }),
        );

        const res = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
            sessionCookie,
            body: { enabled: false },
        });
        expect(res.status).toBe(200);

        const configs = await calendarSyncConfigsDAO.findByIntegration('int-1');
        const defaults = configs.filter((c) => c.isDefault);
        expect(defaults).toHaveLength(1);
        const [def] = defaults;
        if (!def) throw new Error('expected one default config');
        expect(def._id).toBe('sync-config-2');
    });
});

describe('DELETE /calendar/integrations/:integrationId/sync-configs/:configId', () => {
    it('returns 404 for unknown config', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1/sync-configs/no-such',
            sessionCookie,
        });
        expect(res.status).toBe(404);
    });

    it('deletes the sync config and clears references on items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-ref',
            user: userId,
            status: 'calendar',
            title: 'Linked event',
            calendarSyncConfigId: 'sync-config-1',
            calendarIntegrationId: 'int-1',
            createdTs: now,
            updatedTs: now,
        });

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const configs = await calendarSyncConfigsDAO.findByIntegration('int-1');
        expect(configs).toHaveLength(0);

        const item = await itemsDAO.findOne({ _id: 'item-ref' });
        expect(item?.calendarSyncConfigId).toBeUndefined();
    });

    it('promotes a remaining enabled config to default when the default is deleted', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const integration = makeIntegration(userId);
        await calendarIntegrationsDAO.insertEncrypted(integration);
        // sync-config-1 is the default; sync-config-2 is a non-default sibling.
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id));
        await calendarSyncConfigsDAO.insertOne(
            makeSyncConfig(userId, integration._id, { _id: 'sync-config-2', calendarId: 'work@group.calendar.google.com', isDefault: false }),
        );

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const configs = await calendarSyncConfigsDAO.findByIntegration('int-1');
        const defaults = configs.filter((c) => c.isDefault);
        expect(defaults).toHaveLength(1);
        const [def] = defaults;
        if (!def) throw new Error('expected one default config');
        expect(def._id).toBe('sync-config-2');
    });

    it('leaves the existing default intact when a non-default config is deleted', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const integration = makeIntegration(userId);
        await calendarIntegrationsDAO.insertEncrypted(integration);
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id)); // sync-config-1, default
        await calendarSyncConfigsDAO.insertOne(
            makeSyncConfig(userId, integration._id, { _id: 'sync-config-2', calendarId: 'work@group.calendar.google.com', isDefault: false }),
        );

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1/sync-configs/sync-config-2',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const configs = await calendarSyncConfigsDAO.findByIntegration('int-1');
        const defaults = configs.filter((c) => c.isDefault);
        expect(defaults).toHaveLength(1);
        const [def] = defaults;
        if (!def) throw new Error('expected one default config');
        expect(def._id).toBe('sync-config-1');
    });

    it('does not promote any enabled config when the only config is disabled (no-op guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId); // sync-config-1, default + only config

        const res = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
            sessionCookie,
            body: { enabled: false },
        });
        expect(res.status).toBe(200);

        // ensureDefaultExists hits its empty-enabled guard and is a no-op: no enabled config is default.
        // (The disabled row keeps its isDefault flag — disabling never clears it — and is re-promoted only on re-enable.)
        const enabledDefaults = (await calendarSyncConfigsDAO.findByIntegration('int-1')).filter((c) => c.enabled && c.isDefault);
        expect(enabledDefaults).toHaveLength(0);
    });

    it('clears calendarSyncConfigId from routines when config is deleted', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await routinesDAO.insertOne(makeRoutine(userId, { calendarSyncConfigId: 'sync-config-1' }));

        await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
            sessionCookie,
        });

        const routine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(routine?.calendarSyncConfigId).toBeUndefined();
    });
});

// ─── syncToken behavior ──────────────────────────────────────────────────────

describe('POST /calendar/integrations/:id/sync — syncToken', () => {
    it('uses listEventsIncremental when syncToken exists', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Seed a syncToken on the config so the sync uses incremental mode.
        await calendarSyncConfigsDAO.upsertSyncToken('sync-config-1', 'existing-token', dayjs().toISOString());

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const incrementalSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({
            events: [],
            nextSyncToken: 'new-token',
        });
        const fullSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        expect(incrementalSpy).toHaveBeenCalledWith('primary', 'existing-token');
        expect(fullSpy).not.toHaveBeenCalled();

        const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
        expect(config?.syncToken).toBe('new-token');
    });

    it('falls back to listEventsFull when syncToken is expired (410 Gone)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertSyncToken('sync-config-1', 'stale-token', dayjs().toISOString());

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const { SyncTokenInvalidError } = await import('../calendarProviders/CalendarProvider.js');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockRejectedValue(new SyncTokenInvalidError());
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [],
            nextSyncToken: 'fresh-token',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
        expect(config?.syncToken).toBe('fresh-token');
    });

    it('persists nextSyncToken from a full sync', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [],
            nextSyncToken: 'initial-token',
        });

        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });

        const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
        expect(config?.syncToken).toBe('initial-token');
    });
});

// ─── upsertCalendarItem (via sync) ─────────────────────────────────────────

describe('POST /calendar/integrations/:id/sync — upsert paths', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('updates an existing item when GCal event is newer', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        const newUpdatedTs = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-upd',
            user: userId,
            status: 'calendar',
            title: 'Old title',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-upd',
            calendarIntegrationId: 'int-1',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-upd', title: 'New title', timeStart: futureTs, timeEnd: futureTs, updated: newUpdatedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-upd' });
        expect(item?.title).toBe('New title');
    });

    it('on a concurrent-create race for a new event, merges into the winner instead of duplicating (E11000 catch)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();
        const gcalUpdated = dayjs().toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-race', title: 'Raced event', timeStart: futureTs, timeEnd: futureTs, updated: gcalUpdated, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        // Simulate a rival inbound sync that wins the create: when createNewCalendarItem's insert fires,
        // first insert a live calendar item carrying the same calendarEventId, then run the real insert
        // (which now collides on uniq_calendar_item_per_event and throws E11000). The catch must
        // re-resolve to the rival's row and merge, leaving exactly one live item.
        const realInsertOne = itemsDAO.insertOne.bind(itemsDAO);
        let rivalInserted = false;
        vi.spyOn(itemsDAO, 'insertOne').mockImplementation(async (doc) => {
            const candidate = doc as ItemInterface;
            if (!rivalInserted && candidate.calendarEventId === 'evt-race' && candidate.status === 'calendar') {
                rivalInserted = true;
                await realInsertOne({ ...candidate, _id: 'item-race-rival' });
            }
            return realInsertOne(doc);
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const live = await itemsDAO.findArray({ user: userId, calendarEventId: 'evt-race', status: 'calendar' });
        expect(live).toHaveLength(1);
        const [winner] = live;
        if (!winner) throw new Error('expected the rival-bound item to survive');
        expect(winner._id).toBe('item-race-rival');
    });

    it('a trashed twin sharing the event id is revived in place — no duplicate live item, index stays buildable', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();
        const gcalUpdated = dayjs().toISOString();
        // A trashed twin (prior cancel) keeps its calendarEventId for revive — it sits OUTSIDE the
        // status:'calendar' unique index. When the event comes back, upsertCalendarItem must REVIVE that
        // row (status→calendar), not create a second live row. This is the scenario that proves the
        // status-scoped index design: a trashed twin and a live row can coexist without an E11000, and
        // the inbound event converges to exactly one live item.
        await itemsDAO.insertOne({
            _id: 'item-dead-twin',
            user: userId,
            status: 'trash',
            title: 'Old cancelled',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-twin',
            calendarIntegrationId: 'int-1',
            createdTs: gcalUpdated,
            updatedTs: dayjs().subtract(1, 'hour').toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-twin', title: 'Live again', timeStart: futureTs, timeEnd: futureTs, updated: gcalUpdated, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Exactly one live item, and it's the revived twin (not a fresh duplicate).
        const live = await itemsDAO.findArray({ user: userId, calendarEventId: 'evt-twin', status: 'calendar' });
        expect(live).toHaveLength(1);
        const [winner] = live;
        if (!winner) throw new Error('expected the revived twin to be live');
        expect(winner._id).toBe('item-dead-twin');
        expect(winner.title).toBe('Live again');
    });

    it('skips a new past event from Google (no local item created)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const pastTime = dayjs().subtract(2, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-past-new', title: 'Past meeting', timeStart: pastTime, timeEnd: pastTime, updated: pastTime, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ calendarEventId: 'evt-past-new' });
        expect(item).toBeNull();
    });

    it("syncs (not trashes) an existing 'calendar' item moved to a date before today", async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const createdTime = dayjs().subtract(2, 'day').toISOString();
        const futureTime = dayjs().add(1, 'day').toISOString();
        const pastTime = dayjs().subtract(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-moved-past',
            user: userId,
            status: 'calendar',
            title: 'Was future',
            timeStart: futureTime,
            timeEnd: futureTime,
            calendarEventId: 'evt-moved',
            calendarIntegrationId: 'int-1',
            createdTs: createdTime,
            updatedTs: createdTime,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-moved', title: 'Now past', timeStart: pastTime, timeEnd: pastTime, updated: dayjs().toISOString(), status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // An existing item rescheduled backwards is synced wherever it lands — kept live, new time + title applied.
        const item = await itemsDAO.findOne({ _id: 'item-moved-past' });
        expect(item?.status).toBe('calendar');
        expect(item?.title).toBe('Now past');
        expect(item?.timeStart).toBe(pastTime);
        // A user-driven backward drag must never masquerade as a GCal cancellation.
        expect(item?.cancelledByGCal).toBeUndefined();
    });

    it('applies a backward move even when the item carries a lastSyncedFromGCalTs anchor', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // The structurally-newer guard compares event.updated against the item's lastSyncedFromGCalTs.
        // A real inbound backward move carries an event.updated newer than the last applied payload —
        // assert that gate doesn't block the move when an anchor is present (regression for the
        // no-op-on-existing-anchor edge the past-event trash removal could otherwise hide).
        const anchorTs = dayjs().subtract(2, 'hour').toISOString();
        const eventUpdatedTs = dayjs().toISOString();
        const futureTime = dayjs().add(1, 'day').toISOString();
        const pastTime = dayjs().subtract(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-moved-past-anchored',
            user: userId,
            status: 'calendar',
            title: 'Was future',
            timeStart: futureTime,
            timeEnd: futureTime,
            calendarEventId: 'evt-moved-anchored',
            calendarIntegrationId: 'int-1',
            lastSyncedFromGCalTs: anchorTs,
            createdTs: anchorTs,
            updatedTs: anchorTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-moved-anchored', title: 'Now past', timeStart: pastTime, timeEnd: pastTime, updated: eventUpdatedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-moved-past-anchored' });
        expect(item?.status).toBe('calendar');
        expect(item?.title).toBe('Now past');
        expect(item?.timeStart).toBe(pastTime);
    });

    it('updates (not trashes) an in-progress event whose start is past but end is future', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const startTime = dayjs().subtract(1, 'hour').toISOString();
        const endTime = dayjs().add(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-in-progress',
            user: userId,
            status: 'calendar',
            title: 'In-progress meeting',
            timeStart: startTime,
            timeEnd: endTime,
            calendarEventId: 'evt-in-progress',
            calendarIntegrationId: 'int-1',
            createdTs: startTime,
            updatedTs: startTime,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-in-progress',
                    title: 'In-progress meeting (edited)',
                    timeStart: startTime,
                    timeEnd: endTime,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    description: 'new notes',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-in-progress' });
        expect(item?.status).toBe('calendar');
        expect(item?.title).toBe('In-progress meeting (edited)');
    });

    it('skips a routine-managed item when its GCal event is moved to the past', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTime = dayjs().add(1, 'day').toISOString();
        const pastTime = dayjs().subtract(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-routine-past',
            user: userId,
            status: 'calendar',
            title: 'Routine item',
            timeStart: futureTime,
            timeEnd: futureTime,
            calendarEventId: 'evt-routine-past',
            calendarIntegrationId: 'int-1',
            routineId: 'routine-1',
            createdTs: futureTime,
            updatedTs: futureTime,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-routine-past',
                    title: 'Routine item',
                    timeStart: pastTime,
                    timeEnd: pastTime,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-routine-past' });
        // Routine-managed items must not be trashed by the past-event filter.
        expect(item?.status).toBe('calendar');
    });

    it('creates a new item for an event earlier today', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // The seam under test: `isPastEvent` keys on timeEnd against start-of-today in the *config's*
        // tz (Asia/Jerusalem, per makeSyncConfig) — so an event that already ENDED must still import
        // as long as it ended after that cutoff. Pin the clock rather than deriving the window from
        // the runner's local start-of-day: that made this fail on a UTC runner between 21:00Z-23:59Z,
        // where JLM has rolled to tomorrow and the cutoff jumps forward to 21:00Z today.
        // Frozen at Apr 25 12:00 UTC = 15:00 JLM. Cutoff = Apr 24 21:00 UTC. Event 09:00-10:00 UTC:
        // ended, but comfortably after the cutoff.
        const baseDay = dayjs.utc('2026-04-25T00:00:00Z');
        vi.useFakeTimers();
        vi.setSystemTime(baseDay.add(12, 'hour').toDate());
        try {
            const earlierTodayStart = baseDay.add(9, 'hour').toISOString();
            const earlierTodayEnd = baseDay.add(10, 'hour').toISOString();
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [
                    {
                        id: 'evt-earlier-today',
                        title: 'Earlier today',
                        timeStart: earlierTodayStart,
                        timeEnd: earlierTodayEnd,
                        updated: dayjs().toISOString(),
                        status: 'confirmed',
                    },
                ],
                nextSyncToken: 'tok-1',
            });

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);

            const item = await itemsDAO.findOne({ calendarEventId: 'evt-earlier-today' });
            expect(item?.status).toBe('calendar');
            expect(item?.title).toBe('Earlier today');
            expect(item?.timeEnd).toBe(earlierTodayEnd); // proves the ended-today event imported intact
        } finally {
            vi.useRealTimers();
        }
    });

    it('updates an existing item moved from later today to earlier today', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Pin the clock: derived from the runner's local start-of-day, the "earlier" window landed
        // *past* the Asia/Jerusalem cutoff on a UTC runner at 21:00Z-23:59Z. That never failed —
        // `applyPastEventToExisting` funnels into the same `updateExistingCalendarItem` call as the
        // live branch, so the assertions held while the test silently exercised the moved-into-the-past
        // path instead of the intended one. Freezing "now" keeps it on the branch it names.
        // Frozen at Apr 25 12:00 UTC = 15:00 JLM; both windows below stay ahead of that.
        const baseDay = dayjs.utc('2026-04-25T00:00:00Z');
        vi.useFakeTimers();
        vi.setSystemTime(baseDay.add(12, 'hour').toDate());
        try {
            const laterTodayStart = baseDay.add(20, 'hour').toISOString();
            const laterTodayEnd = baseDay.add(21, 'hour').toISOString();
            const earlierTodayStart = baseDay.add(16, 'hour').toISOString();
            const earlierTodayEnd = baseDay.add(17, 'hour').toISOString();
            const createdTime = dayjs().subtract(2, 'day').toISOString();
            await itemsDAO.insertOne({
                _id: 'item-moved-earlier-today',
                user: userId,
                status: 'calendar',
                title: 'Late today',
                timeStart: laterTodayStart,
                timeEnd: laterTodayEnd,
                calendarEventId: 'evt-moved-earlier-today',
                calendarIntegrationId: 'int-1',
                createdTs: createdTime,
                updatedTs: createdTime,
            });

            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [
                    {
                        id: 'evt-moved-earlier-today',
                        title: 'Moved earlier',
                        timeStart: earlierTodayStart,
                        timeEnd: earlierTodayEnd,
                        updated: dayjs().toISOString(),
                        status: 'confirmed',
                    },
                ],
                nextSyncToken: 'tok-1',
            });

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);

            const item = await itemsDAO.findOne({ _id: 'item-moved-earlier-today' });
            expect(item?.status).toBe('calendar');
            expect(item?.title).toBe('Moved earlier');
            expect(item?.timeStart).toBe(earlierTodayStart);
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves an already-trashed item alone when event remains in past', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const trashedTs = dayjs().subtract(1, 'day').toISOString();
        const pastStart = dayjs().subtract(2, 'day').toISOString();
        const pastEnd = dayjs().subtract(2, 'day').add(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-already-trashed',
            user: userId,
            status: 'trash',
            title: 'Already trashed',
            timeStart: pastStart,
            timeEnd: pastEnd,
            calendarEventId: 'evt-already-trashed',
            calendarIntegrationId: 'int-1',
            createdTs: trashedTs,
            updatedTs: trashedTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-already-trashed', title: 'Still past', timeStart: pastStart, timeEnd: pastEnd, updated: trashedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-already-trashed' });
        expect(item?.status).toBe('trash');
        // updatedTs unchanged proves the trash branch short-circuited (no operation written).
        expect(item?.updatedTs).toBe(trashedTs);
    });

    it('honors calendar timeZone for the today cutoff', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // April 2026 is DST in Asia/Jerusalem (UTC+3). Freeze "now" at 22:30 UTC on April 25.
        // In JLM that's April 26 01:30 — already "tomorrow". start-of-today JLM = April 26 00:00 JLM = April 25 21:00 UTC.
        // start-of-today UTC = April 25 00:00 UTC. The cutoffs disagree by 21h.
        // An event ending at April 25 20:30 UTC is *before* the JLM cutoff (past in JLM)
        // but *after* the UTC cutoff (today in UTC). A *new* (no local item) past event is ignored,
        // so a TZ-aware sync creates nothing; a UTC-only sync would treat it as today and create the item.
        const baseDay = dayjs.utc('2026-04-25T00:00:00Z');
        vi.useFakeTimers();
        vi.setSystemTime(baseDay.add(22, 'hour').add(30, 'minute').toDate());
        try {
            const eventStart = baseDay.add(20, 'hour').toISOString();
            const eventEnd = baseDay.add(20, 'hour').add(30, 'minute').toISOString();

            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [
                    {
                        id: 'evt-tz-borderline',
                        title: 'Borderline',
                        timeStart: eventStart,
                        timeEnd: eventEnd,
                        updated: dayjs().toISOString(),
                        status: 'confirmed',
                    },
                ],
                nextSyncToken: 'tok-1',
            });

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);

            // The mock returns the event unconditionally (bypassing GCal's own timeMin), so this
            // asserts the in-process cutoff specifically: past in JLM → ignored, no item created.
            // A UTC-only cutoff would classify it as today and import it.
            const item = await itemsDAO.findOne({ calendarEventId: 'evt-tz-borderline' });
            expect(item).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('updates a reclassified nextAction item when its GCal event is moved to past', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // User reclassified the calendar item as a nextAction. Past-event branch must preserve it
        // (not trash it) and still apply title/time edits from GCal — otherwise users lose work.
        const createdTs = dayjs().subtract(2, 'day').toISOString();
        const futureTime = dayjs().add(1, 'day').toISOString();
        const pastTime = dayjs().subtract(2, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-reclassified-past',
            user: userId,
            status: 'nextAction',
            title: 'Original',
            timeStart: futureTime,
            timeEnd: futureTime,
            calendarEventId: 'evt-reclassified-past',
            calendarIntegrationId: 'int-1',
            createdTs,
            updatedTs: createdTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-reclassified-past',
                    title: 'Edited title',
                    timeStart: pastTime,
                    timeEnd: pastTime,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-reclassified-past' });
        expect(item?.status).toBe('nextAction');
        expect(item?.title).toBe('Edited title');
    });

    it('passes start-of-today (in calendar timeZone) as timeMin on full sync', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const fullSyncSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        expect(fullSyncSpy).toHaveBeenCalledTimes(1);
        const [, timeMinArg] = fullSyncSpy.mock.calls[0]!;
        // timeMin must be 00:00 (start of day) when projected into the calendar's TZ.
        expect(dayjs(timeMinArg).tz('Asia/Jerusalem').format('HH:mm:ss')).toBe('00:00:00');
    });

    it('skips update when local item is newer than the GCal event', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const localTs = dayjs().toISOString();
        const gcalTs = dayjs().subtract(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-stale',
            user: userId,
            status: 'calendar',
            title: 'Local edit',
            timeStart: localTs,
            timeEnd: localTs,
            calendarEventId: 'evt-stale',
            calendarIntegrationId: 'int-1',
            createdTs: gcalTs,
            updatedTs: localTs,
            // Anchor against which the inbound guard compares — without this the empty-string
            // fallback would let the older GCal payload through.
            lastSyncedFromGCalTs: localTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-stale', title: 'Overwritten title', timeStart: gcalTs, timeEnd: gcalTs, updated: gcalTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-stale' });
        // Local edit must be preserved — GCal event is older than local updatedTs.
        expect(item?.title).toBe('Local edit');
    });

    it('rejects an old GCal payload when lastSyncedFromGCalTs is set', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const t1 = dayjs().subtract(1, 'hour').toISOString(); // older inbound
        const t2 = dayjs().toISOString(); // last applied inbound
        await itemsDAO.insertOne({
            _id: 'item-stale-anchor',
            user: userId,
            status: 'calendar',
            title: 'Title from t2',
            timeStart: t2,
            timeEnd: t2,
            calendarEventId: 'evt-stale-anchor',
            calendarIntegrationId: 'int-1',
            createdTs: t1,
            // updatedTs older than t1 — proves the guard uses lastSyncedFromGCalTs, not updatedTs.
            updatedTs: dayjs().subtract(2, 'hour').toISOString(),
            lastSyncedFromGCalTs: t2,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-stale-anchor', title: 'Stale redelivery', timeStart: t1, timeEnd: t1, updated: t1, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-stale-anchor' });
        expect(item?.title).toBe('Title from t2');
    });

    it('advances the anchor without recording an op when GCal updated advances but content is identical', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Reproduces the staging notification storm: GCal bumps event.updated for a non-synced
        // reason (reminders/ACL/our own done-marker echo) while title/time are byte-identical.
        // Pre-fix this re-applied a full replaceById + op on every webhook fire → a web push each
        // time. Post-fix it advances lastSyncedFromGCalTs silently — no op, no updatedTs bump.
        const t1 = dayjs().subtract(1, 'hour').toISOString(); // last applied inbound (anchor)
        const t2 = dayjs().toISOString(); // newer event.updated, same content
        const start = dayjs().add(1, 'day').toISOString();
        const end = dayjs().add(1, 'day').add(30, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-noop',
            user: userId,
            status: 'calendar',
            title: 'Stable title',
            timeStart: start,
            timeEnd: end,
            calendarEventId: 'evt-noop',
            calendarIntegrationId: 'int-1',
            createdTs: t1,
            updatedTs: t1,
            lastSyncedFromGCalTs: t1,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            // Identical title/time/allDay; only `updated` advanced.
            events: [{ id: 'evt-noop', title: 'Stable title', timeStart: start, timeEnd: end, updated: t2, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-noop' });
        // Anchor advanced so the next fire short-circuits at the "not newer" guard.
        expect(item?.lastSyncedFromGCalTs).toBe(t2);
        // updatedTs (the LWW anchor) must NOT move — this is a silent re-anchor, not a user-visible edit.
        expect(item?.updatedTs).toBe(t1);
        // Crucially: no operation recorded → no web push fans out for a content no-op.
        const ops = await db.collection('operations').find({ user: userId, entityId: 'item-noop' }).toArray();
        expect(ops).toHaveLength(0);
    });

    it('still records an op when the GCal payload is newer AND a structural field changed', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Boundary opposite of the content-noop case: same advancing `updated`, but the title
        // actually changed. The noop short-circuit must NOT engage — a real edit has to apply,
        // record an op, and bump updatedTs so other devices and live tabs converge.
        const t1 = dayjs().subtract(1, 'hour').toISOString();
        const t2 = dayjs().toISOString();
        const start = dayjs().add(1, 'day').toISOString();
        const end = dayjs().add(1, 'day').add(30, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-real-edit',
            user: userId,
            status: 'calendar',
            title: 'Original title',
            timeStart: start,
            timeEnd: end,
            calendarEventId: 'evt-real-edit',
            calendarIntegrationId: 'int-1',
            createdTs: t1,
            updatedTs: t1,
            lastSyncedFromGCalTs: t1,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-real-edit', title: 'Renamed in GCal', timeStart: start, timeEnd: end, updated: t2, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-real-edit' });
        expect(item?.title).toBe('Renamed in GCal');
        expect(item?.lastSyncedFromGCalTs).toBe(t2);
        const ops = await db.collection('operations').find({ user: userId, entityId: 'item-real-edit' }).toArray();
        expect(ops).toHaveLength(1);
    });

    it('revives a trashed item when its GCal event becomes confirmed again', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Reproduces the bug: trashed by a prior disconnect, local updatedTs later than the
        // GCal event.updated. Pre-fix the structural-newer guard would skip; the revive branch
        // must restore to status: 'calendar' regardless.
        const eventUpdated = dayjs().subtract(1, 'hour').toISOString();
        const trashedTs = dayjs().toISOString();
        const futureStart = dayjs().add(1, 'day').toISOString();
        const futureEnd = dayjs().add(1, 'day').add(30, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-revive',
            user: userId,
            status: 'trash',
            title: 'Old title',
            timeStart: futureStart,
            timeEnd: futureStart,
            calendarEventId: 'evt-revive',
            calendarIntegrationId: 'int-1',
            createdTs: eventUpdated,
            updatedTs: trashedTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-revive',
                    title: 'Cross-account smoke (moved)',
                    timeStart: futureStart,
                    timeEnd: futureEnd,
                    updated: eventUpdated,
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-revive' });
        expect(item?.status).toBe('calendar');
        expect(item?.title).toBe('Cross-account smoke (moved)');
        expect(item?.timeEnd).toBe(futureEnd);
        expect(item?.lastSyncedFromGCalTs).toBe(eventUpdated);

        // An update operation must be recorded so other devices learn about the revive.
        const ops = await db.collection('operations').find({ user: userId, entityId: 'item-revive' }).toArray();
        const reviveOp = ops.find((o) => o.opType === 'update');
        expect(reviveOp).toBeDefined();
    });

    it('does not revive a trashed item if the resurrected event is in the past', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Past-event short-circuit must run before the revive branch.
        const eventUpdated = dayjs().subtract(1, 'hour').toISOString();
        const trashedTs = dayjs().toISOString();
        const pastStart = dayjs().subtract(2, 'day').toISOString();
        const pastEnd = dayjs().subtract(2, 'day').add(30, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-past-revive',
            user: userId,
            status: 'trash',
            title: 'Old title',
            timeStart: pastStart,
            timeEnd: pastStart,
            calendarEventId: 'evt-past-revive',
            calendarIntegrationId: 'int-1',
            createdTs: eventUpdated,
            updatedTs: trashedTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-past-revive', title: 'Past event', timeStart: pastStart, timeEnd: pastEnd, updated: eventUpdated, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-past-revive' });
        expect(item?.status).toBe('trash');
        expect(item?.title).toBe('Old title');
    });

    it('does not revive a routine-managed trashed item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const eventUpdated = dayjs().subtract(1, 'hour').toISOString();
        const trashedTs = dayjs().toISOString();
        const futureStart = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-routine-revive',
            user: userId,
            status: 'trash',
            title: 'Routine instance',
            routineId: 'routine-1',
            timeStart: futureStart,
            timeEnd: futureStart,
            calendarEventId: 'evt-routine-revive',
            calendarIntegrationId: 'int-1',
            createdTs: eventUpdated,
            updatedTs: trashedTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-routine-revive',
                    title: 'Should not revive',
                    timeStart: futureStart,
                    timeEnd: futureStart,
                    updated: eventUpdated,
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-routine-revive' });
        expect(item?.status).toBe('trash');
        expect(item?.title).toBe('Routine instance');
    });

    it('on revive, GCal description overwrites stale local notes (last-write-wins anchor on revive is epoch)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const eventUpdated = dayjs().subtract(1, 'hour').toISOString();
        const trashedTs = dayjs().toISOString();
        const futureStart = dayjs().add(1, 'day').toISOString();
        const futureEnd = dayjs().add(1, 'day').add(30, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-revive-notes',
            user: userId,
            status: 'trash',
            title: 'Old title',
            timeStart: futureStart,
            timeEnd: futureStart,
            calendarEventId: 'evt-revive-notes',
            calendarIntegrationId: 'int-1',
            notes: 'old notes',
            lastSyncedNotes: '<p>old notes</p>',
            createdTs: eventUpdated,
            // Trash stamp later than event.updated — pre-fix this would have made GCal lose
            // the last-write-wins comparison via `dayjs('').unix() === NaN` (which always
            // returns false). Anchored at epoch on revive, GCal correctly wins.
            updatedTs: trashedTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-revive-notes',
                    title: 'Revived',
                    timeStart: futureStart,
                    timeEnd: futureEnd,
                    updated: eventUpdated,
                    status: 'confirmed',
                    description: '<p>fresh notes from gcal</p>',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-revive-notes' });
        expect(item?.status).toBe('calendar');
        expect(item?.notes).toBe('fresh notes from gcal');
        expect(item?.lastSyncedNotes).toBe('<p>fresh notes from gcal</p>');
    });

    it('does not regress lastSyncedFromGCalTs on a notes-only update from an out-of-order webhook', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Existing item with anchor T3 but a much older local updatedTs T1. An out-of-order
        // webhook arrives with event.updated = T2 (between T1 and T3) and a changed description:
        //   - Notes guard (`resolveInboundNotes` compares gcalUpdated vs updatedTs): T2 > T1 → notes apply.
        //   - Structural-newer guard (compares gcalUpdated vs lastSyncedFromGCalTs): T2 < T3 → no structural change.
        //   - Anchor must stay at T3 — bumping to T2 would let an even-older payload pass the guard later.
        const t1 = dayjs().subtract(2, 'hour').toISOString();
        const t2 = dayjs().subtract(1, 'hour').toISOString();
        const t3 = dayjs().toISOString();
        const futureStart = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-anchor-no-regress',
            user: userId,
            status: 'calendar',
            title: 'Title at T3',
            timeStart: futureStart,
            timeEnd: futureStart,
            calendarEventId: 'evt-anchor-no-regress',
            calendarIntegrationId: 'int-1',
            lastSyncedNotes: '<p>old desc</p>',
            createdTs: t1,
            updatedTs: t1,
            lastSyncedFromGCalTs: t3,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-anchor-no-regress',
                    title: 'Stale title (should be ignored)',
                    timeStart: futureStart,
                    timeEnd: futureStart,
                    updated: t2,
                    status: 'confirmed',
                    description: '<p>new desc</p>',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-anchor-no-regress' });
        // Notes update applied (GCal changed the description), structural fields stayed put.
        expect(item?.title).toBe('Title at T3');
        expect(item?.notes).toBe('new desc');
        // Anchor must NOT regress to T2 — that would let an even-older T1 payload pass the guard.
        expect(item?.lastSyncedFromGCalTs).toBe(t3);
    });

    it('strips leading "✓ " from inbound title when local item is already done', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        const newUpdatedTs = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-done-strip',
            user: userId,
            status: 'done',
            title: 'Verify done sync',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-done-strip',
            calendarIntegrationId: 'int-1',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-done-strip', title: '✓ Foo', timeStart: futureTs, timeEnd: futureTs, updated: newUpdatedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-done-strip' });
        expect(item?.title).toBe('Foo');
    });

    it('preserves a literal "✓ " prefix in inbound title when local item is open (status: calendar)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        const newUpdatedTs = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-open-keep',
            user: userId,
            status: 'calendar',
            title: 'Original',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-open-keep',
            calendarIntegrationId: 'int-1',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-open-keep', title: '✓ Foo', timeStart: futureTs, timeEnd: futureTs, updated: newUpdatedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-open-keep' });
        expect(item?.title).toBe('✓ Foo');
    });
});

// ─── Full-sync reconciliation sweep (self-healing of missed deletions) ──────
//
// A single (non-recurring) GCal event that is hard-deleted while sync is down (expired syncToken,
// disconnected integration, or the event aged past timeMin before a post-deletion delta arrived)
// never delivers a `cancelled` tombstone — so the reactive trash path in upsertCalendarItem can
// never fire. The full-sync reconciliation sweep heals this: it trashes any in-window calendar item
// whose calendarEventId is absent from the authoritative full-sync snapshot. The sweep MUST run only
// on full syncs (incremental deltas are not snapshots), must stay window-bounded, and must shield
// items whose create/update may still be propagating to GCal's index.
describe('POST /calendar/integrations/:id/sync — full-sync reconciliation sweep', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    /** Seeds a future, already-synced (so past the reconcile grace window) calendar item linked to sync-config-1. */
    async function seedLinkedFutureItem(userId: string, id: string, eventId: string, overrides: Partial<ItemInterface> = {}) {
        const futureTs = dayjs().add(2, 'day').toISOString();
        const oldTs = dayjs().subtract(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: id,
            user: userId,
            status: 'calendar',
            title: id,
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: eventId,
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: oldTs,
            updatedTs: oldTs,
            ...overrides,
        });
        return futureTs;
    }

    it('trashes an orphaned future item when its event is absent from the full-sync snapshot', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await seedLinkedFutureItem(userId, 'item-vanished', 'evt-gone');

        // Full sync returns NO events — the linked event has been deleted on GCal.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-vanished' });
        expect(item?.status).toBe('trash');
        // Stamped like a reactive cancellation so the trash view shows the "Cancelled in Calendar" badge.
        expect(item?.cancelledByGCal).toBe(true);

        // An operation must be recorded so other devices converge on the trash on their next pull.
        const ops = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-vanished' });
        const [trashOp] = ops;
        if (!trashOp) throw new Error('expected a recorded trash operation for the reconciled item');
        expect(trashOp.snapshot?.status).toBe('trash');
    });

    it('trashes a vanished ALL-DAY item (timeStart is YYYY-MM-DD, not an ISO datetime)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // All-day item dated two days out — `timeStart`/`timeEnd` are bare `YYYY-MM-DD`. This is the
        // case a lexicographic Mongo `$gte` against the ISO-datetime `timeMin` would mishandle; the
        // dayjs window filter must still place it inside the window and trash it.
        const futureDate = dayjs().add(2, 'day').format('YYYY-MM-DD');
        await seedLinkedFutureItem(userId, 'item-allday', 'evt-allday-gone', { timeStart: futureDate, timeEnd: futureDate, allDay: true });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-allday' });
        expect(item?.status).toBe('trash');
    });

    it('shields a just-created item with no lastPushedToGCalTs via the updatedTs grace fallback', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Item created in-app seconds ago that has NOT yet been pushed to GCal (no lastPushedToGCalTs).
        // The grace guard falls back to `updatedTs`, so the freshly-created item is shielded from a
        // false trash while its push to GCal is still in flight.
        await seedLinkedFutureItem(userId, 'item-fresh-noPush', 'evt-fresh-noPush', { updatedTs: dayjs().toISOString() });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-fresh-noPush' });
        expect(item?.status).toBe('calendar');
    });

    it('does NOT trash a non-routine item whose calendarEventId is in instance form (can never match the master-only snapshot)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // A non-routine item carrying an instance-form id (`<master>_<YYYYMMDDTHHMMSSZ>`).
        // `listEventsFull` is master-only and `normalizeMasterEventId` doesn't strip the instance
        // suffix, so this id could never appear in the snapshot — trashing on its absence would be a
        // false positive. The bare-master-form guard must exclude it.
        await seedLinkedFutureItem(userId, 'item-instanceform', 'mastermtg_20260620T120000Z');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-instanceform' });
        expect(item?.status).toBe('calendar');
    });

    it('does NOT trash a non-routine item whose calendarEventId is in ALL-DAY instance form (_YYYYMMDD, no T)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // All-day instance suffix has no `T<time>Z` component — exercises the regex's optional group.
        await seedLinkedFutureItem(userId, 'item-instanceform-allday', 'mastermtg_20260620');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-instanceform-allday' });
        expect(item?.status).toBe('calendar');
    });

    it('does NOT trash an item whose event is still present in the snapshot', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const futureTs = await seedLinkedFutureItem(userId, 'item-present', 'evt-live');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-live',
                    title: 'item-present',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().subtract(1, 'day').toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-present' });
        expect(item?.status).toBe('calendar');
    });

    it('does NOT run the sweep on an incremental sync (a delta is not an authoritative snapshot)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const { config } = await insertIntegrationWithConfig(userId);
        // A stored syncToken forces the incremental path.
        await calendarSyncConfigsDAO.upsertSyncToken(config._id, 'tok-existing', dayjs().subtract(1, 'hour').toISOString());
        await seedLinkedFutureItem(userId, 'item-incr', 'evt-incr');

        // Incremental returns an empty delta — nothing changed. The orphan must survive: an empty
        // delta means "no changes seen", not "the event is gone".
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({ events: [], nextSyncToken: 'tok-incr-next' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-incr' });
        expect(item?.status).toBe('calendar');
    });

    it('runs the sweep on the 410-fallback full sync after an expired syncToken', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const { config } = await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertSyncToken(config._id, 'tok-stale', dayjs().subtract(1, 'hour').toISOString());
        await seedLinkedFutureItem(userId, 'item-410', 'evt-410-gone');

        // Incremental throws 410 → falls back to a full sync, which returns no events. The orphan
        // strands forever today (the new token is minted post-deletion); the sweep is the only heal.
        const { SyncTokenInvalidError } = await import('../calendarProviders/CalendarProvider.js');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockRejectedValue(new SyncTokenInvalidError());
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-410-next' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-410' });
        expect(item?.status).toBe('trash');
        expect(item?.cancelledByGCal).toBe(true);
    });

    it('leaves items outside the snapshot window untouched (past timeStart, routine-managed, other config)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const oldTs = dayjs().subtract(1, 'day').toISOString();
        const pastTs = dayjs().subtract(2, 'day').toISOString();

        // Past item: before timeMin, so outside the [timeMin, ∞) snapshot — the full sync never
        // claimed authority over it.
        await itemsDAO.insertOne({
            _id: 'item-past',
            user: userId,
            status: 'calendar',
            title: 'past',
            timeStart: pastTs,
            timeEnd: pastTs,
            calendarEventId: 'evt-past',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: pastTs,
            updatedTs: oldTs,
        });
        // Routine-managed future item: lifecycle owned by the routine path, never the standalone sweep.
        await itemsDAO.insertOne({
            _id: 'item-routine',
            user: userId,
            status: 'calendar',
            title: 'routine occ',
            timeStart: dayjs().add(2, 'day').toISOString(),
            timeEnd: dayjs().add(2, 'day').toISOString(),
            calendarEventId: 'evt-routine',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            routineId: 'routine-1',
            createdTs: oldTs,
            updatedTs: oldTs,
        });
        // Future item on a DIFFERENT sync config: not part of this config's snapshot.
        await itemsDAO.insertOne({
            _id: 'item-othercfg',
            user: userId,
            status: 'calendar',
            title: 'other cfg',
            timeStart: dayjs().add(2, 'day').toISOString(),
            timeEnd: dayjs().add(2, 'day').toISOString(),
            calendarEventId: 'evt-othercfg',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-OTHER',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        expect((await itemsDAO.findOne({ _id: 'item-past' }))?.status).toBe('calendar');
        expect((await itemsDAO.findOne({ _id: 'item-routine' }))?.status).toBe('calendar');
        expect((await itemsDAO.findOne({ _id: 'item-othercfg' }))?.status).toBe('calendar');
    });

    it('shields a just-pushed item from a false trash while its create propagates to GCal', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Item pushed to GCal seconds ago — its create may not be in GCal's list index yet. Trashing
        // it now would be a false positive; the grace window protects it.
        await seedLinkedFutureItem(userId, 'item-fresh', 'evt-fresh', { lastPushedToGCalTs: dayjs().toISOString() });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-fresh' });
        expect(item?.status).toBe('calendar');
    });
});

// ─── Phase 1c: GCal-owned field-level merge + all-day + cancelledByGCal ───
//
// Covers the inbound paths in routes/calendar.ts: createNewCalendarItem (all-day inbound),
// updateExistingCalendarItem (GCal-newer + GCal-older field-level merge, attendee-clear), the
// cancelled branch (cancelledByGCal stamp), and createRoutineFromGCal (all-day routine template).

describe('POST /calendar/integrations/:id/sync — Phase 1c field-level merge', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('inbound GCal-newer event overwrites the local title AND the attendees array (basic merge)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const localAnchor = dayjs().subtract(1, 'hour').toISOString();
        const eventUpdated = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-merge-newer',
            user: userId,
            status: 'calendar',
            title: 'Local title',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-merge-newer',
            calendarIntegrationId: 'int-1',
            attendees: [{ email: 'old@example.com', responseStatus: 'needsAction' }],
            createdTs: localAnchor,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-merge-newer',
                    title: 'GCal title',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: eventUpdated,
                    status: 'confirmed',
                    attendees: [
                        { email: 'a@example.com', responseStatus: 'accepted' },
                        { email: 'b@example.com', responseStatus: 'declined' },
                    ],
                    organizer: { email: 'a@example.com' },
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-merge-newer' });
        // Structural overwrite when GCal is newer: title updated.
        expect(item?.title).toBe('GCal title');
        // GCal-owned overwrite: attendees + organizer mirror the inbound payload exactly.
        expect(item?.attendees).toEqual([
            { email: 'a@example.com', responseStatus: 'accepted' },
            { email: 'b@example.com', responseStatus: 'declined' },
        ]);
        expect(item?.organizer).toEqual({ email: 'a@example.com' });
    });

    it('inbound GCal-older event preserves the local title BUT still overwrites attendees (GCal-owned policy)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // localAnchor newer than eventUpdated → structurallyNewer = false → title stays local.
        const eventUpdated = dayjs().subtract(2, 'hour').toISOString();
        const localAnchor = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-merge-older',
            user: userId,
            status: 'calendar',
            title: 'Local title wins',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-merge-older',
            calendarIntegrationId: 'int-1',
            attendees: [{ email: 'stale@example.com', responseStatus: 'needsAction' }],
            createdTs: eventUpdated,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-merge-older',
                    title: 'GCal stale title (should not win)',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: eventUpdated,
                    status: 'confirmed',
                    attendees: [{ email: 'fresh@example.com', responseStatus: 'accepted' }],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-merge-older' });
        // Title is structural and gated — local wins because GCal is older.
        expect(item?.title).toBe('Local title wins');
        // Attendees are GCal-owned — always overwritten, even when GCal is older.
        expect(item?.attendees).toEqual([{ email: 'fresh@example.com', responseStatus: 'accepted' }]);
    });

    it('inbound event without attendees clears the local stale attendees (GCal-owned absent ⇒ delete)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const localAnchor = dayjs().subtract(1, 'hour').toISOString();
        const eventUpdated = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-attendees-clear',
            user: userId,
            status: 'calendar',
            title: 'Stale attendees',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-attendees-clear',
            calendarIntegrationId: 'int-1',
            attendees: [{ email: 'leaving@example.com', responseStatus: 'declined' }],
            organizer: { email: 'leaving@example.com' },
            createdTs: localAnchor,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        // Inbound event omits attendees entirely (GCal returned an empty array → parser drops to undefined).
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-attendees-clear',
                    title: 'Stale attendees',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: eventUpdated,
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-attendees-clear' });
        // Both GCal-owned fields cleared — neither attendees nor organizer survives the replace.
        expect(item?.attendees).toBeUndefined();
        expect(item?.organizer).toBeUndefined();
    });

    it('inbound event writes meetingLink/location/htmlLink onto an existing item (GCal-owned merge)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const localAnchor = dayjs().subtract(1, 'hour').toISOString();
        const eventUpdated = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-links-write',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-links-write',
            calendarIntegrationId: 'int-1',
            createdTs: localAnchor,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-links-write',
                    title: 'Standup',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: eventUpdated,
                    status: 'confirmed',
                    meetingLink: 'https://meet.google.com/abc-defg-hij',
                    location: 'Room 4B',
                    htmlLink: 'https://calendar.google.com/event?eid=links-write',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-links-write' });
        expect(item?.meetingLink).toBe('https://meet.google.com/abc-defg-hij');
        expect(item?.location).toBe('Room 4B');
        expect(item?.htmlLink).toBe('https://calendar.google.com/event?eid=links-write');
    });

    it('inbound event without a meeting link clears a stale local meetingLink (GCal-owned absent ⇒ delete)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const localAnchor = dayjs().subtract(1, 'hour').toISOString();
        const eventUpdated = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-links-clear',
            user: userId,
            status: 'calendar',
            title: 'Meeting unscheduled',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-links-clear',
            calendarIntegrationId: 'int-1',
            meetingLink: 'https://meet.google.com/gone',
            location: 'Old Room',
            createdTs: localAnchor,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        // Meeting removed on GCal: the event no longer carries hangoutLink/conferenceData/location.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-links-clear',
                    title: 'Meeting unscheduled',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: eventUpdated,
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-links-clear' });
        expect(item?.meetingLink).toBeUndefined();
        expect(item?.location).toBeUndefined();
    });

    it('cancelled inbound event trashes the item AND stamps cancelledByGCal: true', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-cancelled-flag',
            user: userId,
            status: 'calendar',
            title: 'About to be cancelled',
            timeStart: now,
            timeEnd: now,
            calendarEventId: 'evt-cancelled-flag',
            calendarIntegrationId: 'int-1',
            createdTs: now,
            updatedTs: now,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-cancelled-flag', title: 'About to be cancelled', timeStart: now, timeEnd: now, updated: now, status: 'cancelled' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-cancelled-flag' });
        expect(item?.status).toBe('trash');
        expect(item?.cancelledByGCal).toBe(true);
    });

    it('all-day inbound event creates an item with allDay: true and YYYY-MM-DD time fields', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // GCal exclusive-end: a single-day all-day event on May 27 stores end = May 28.
        const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const endDate = dayjs().add(2, 'day').format('YYYY-MM-DD');
        const updated = dayjs().toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-allday-new',
                    title: 'Holiday',
                    timeStart: startDate,
                    timeEnd: endDate,
                    updated,
                    status: 'confirmed',
                    allDay: true,
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ calendarEventId: 'evt-allday-new' });
        expect(item).not.toBeNull();
        expect(item?.allDay).toBe(true);
        expect(item?.timeStart).toBe(startDate);
        expect(item?.timeEnd).toBe(endDate);
        expect(item?.status).toBe('calendar');
    });

    it('createRoutineFromGCal mirrors the master organizer/attendees/eventType onto the routine doc, and generated items inherit them', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        const tomorrowAt10 = dayjs().add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-with-attendees',
                    title: 'Yuval <> Gilad',
                    timeStart: tomorrowAt9,
                    timeEnd: tomorrowAt10,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                    organizer: { email: 'yuval@example.com', displayName: 'Yuval' },
                    creator: { email: 'yuval@example.com' },
                    attendees: [
                        { email: 'gilad@example.com', responseStatus: 'accepted' },
                        { email: 'yuval@example.com', responseStatus: 'accepted', self: true },
                    ],
                    responseStatus: 'accepted',
                    eventType: 'default',
                },
            ],
            nextSyncToken: 'tok-attendees',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'gcal-master-with-attendees' });
        expect(routine).not.toBeNull();
        // Routine doc now carries the master attendee list verbatim.
        expect(routine?.attendees).toHaveLength(2);
        expect(routine?.organizer?.email).toBe('yuval@example.com');
        expect(routine?.eventType).toBe('default');

        // Every generated item carries the same attendees mirrored from the master.
        const items = await itemsDAO.findArray({ user: userId, routineId: routine?._id ?? '' });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.attendees).toHaveLength(2);
            expect(item.organizer?.email).toBe('yuval@example.com');
            expect(item.eventType).toBe('default');
        }
    });

    it('createRoutineFromGCal mirrors the master meetingLink/location/htmlLink onto the routine doc and every generated item', async () => {
        // The weekly-standup-with-a-fixed-Meet-link case: recurring instances are managed by the
        // routine surface, so the conferencing link must thread master → routine → generated items.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        const tomorrowAt10 = dayjs().add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-with-meet',
                    title: 'Weekly standup',
                    timeStart: tomorrowAt9,
                    timeEnd: tomorrowAt10,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                    meetingLink: 'https://meet.google.com/standup-link',
                    location: 'HQ Room 4B',
                    htmlLink: 'https://calendar.google.com/event?eid=standup',
                },
            ],
            nextSyncToken: 'tok-meet',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'gcal-master-with-meet' });
        expect(routine?.meetingLink).toBe('https://meet.google.com/standup-link');
        expect(routine?.location).toBe('HQ Room 4B');
        expect(routine?.htmlLink).toBe('https://calendar.google.com/event?eid=standup');

        const items = await itemsDAO.findArray({ user: userId, routineId: routine?._id ?? '' });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.meetingLink).toBe('https://meet.google.com/standup-link');
            expect(item.location).toBe('HQ Room 4B');
            expect(item.htmlLink).toBe('https://calendar.google.com/event?eid=standup');
        }
    });

    it('createRoutineFromGCal with an all-day recurring master builds template = { allDay: true } and generates all-day items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // GCal recurring all-day master: start/end are YYYY-MM-DD strings, allDay: true.
        const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const endDate = dayjs().add(2, 'day').format('YYYY-MM-DD');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-allday-master',
                    title: 'Daily walk',
                    timeStart: startDate,
                    timeEnd: endDate,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    allDay: true,
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        // Phase 8: the all-day routine path now generates items end-to-end. Sync must succeed
        // (200) and the resulting items must carry allDay=true with YYYY-MM-DD time strings.
        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-allday-master' });
        expect(routine).not.toBeNull();
        expect(routine?.calendarItemTemplate).toEqual({ allDay: true });
        expect(routine?.title).toBe('Daily walk');
        expect(routine?.rrule).toBe('FREQ=DAILY');

        const items = await itemsDAO.findArray({ user: userId, routineId: routine?._id ?? '' });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.allDay).toBe(true);
            expect(item.timeStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(item.timeEnd).toBe(dayjs(item.timeStart).add(1, 'day').format('YYYY-MM-DD'));
        }
    });

    // Regression: updateRoutineFromGCal previously recomputed `calendarItemTemplate` as
    // `{ timeOfDay, duration }` unconditionally, so a structurally-newer all-day master clobbered the
    // routine's `{ allDay: true }` template — for an all-day event timeStart is a YYYY-MM-DD string, so
    // extractLocalTime/diff produce junk (timeOfDay '03:00', duration 1440), and the banner renders
    // as 03:00–03:00. The update path now mirrors the create path's all-day branch.
    it('updateRoutineFromGCal keeps template = { allDay: true } when a newer all-day master arrives (no clobber to timed)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const endDate = dayjs().add(2, 'day').format('YYYY-MM-DD');

        // Existing all-day routine with a STALE GCal-truth anchor so the inbound master is structurally newer.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-allday',
                calendarEventId: 'recurring-allday-master',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'cfg-1',
                rrule: 'FREQ=DAILY',
                calendarItemTemplate: { allDay: true },
                lastSyncedFromGCalTs: '2020-01-01T00:00:00.000Z',
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-allday-master',
                    title: 'Daily walk (renamed)',
                    timeStart: startDate,
                    timeEnd: endDate,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    allDay: true,
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        // Seed an existing future all-day item so propagateMasterScheduleChanges has a target — the
        // assertion loop below is then non-vacuous.
        await itemsDAO.insertOne({
            _id: 'item-allday-future',
            user: userId,
            status: 'calendar',
            title: 'Daily walk',
            routineId: 'routine-allday',
            calendarInstanceEventId: `recurring-allday-master_${startDate.replace(/-/g, '')}`,
            allDay: true,
            timeStart: startDate,
            timeEnd: endDate,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-allday-master' });
        expect(routine?.title).toBe('Daily walk (renamed)');
        // The structural update applied (title changed) but the template stayed all-day — not { timeOfDay, duration }.
        // Pre-fix this would have been { timeOfDay: '03:00', duration: 1440 } (junk from parsing a YYYY-MM-DD string).
        expect(routine?.calendarItemTemplate).toEqual({ allDay: true });

        // Existing future items keep date-only time strings (never 03:00 datetimes) after propagation.
        const items = await itemsDAO.findArray({ user: userId, routineId: routine?._id ?? '' });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.allDay).toBe(true);
            expect(item.timeStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });

    // Replacement (not merge) semantics: a routine previously TIMED that becomes all-day on GCal must
    // have its `{ timeOfDay, duration }` fully replaced by `{ allDay: true }` — no stale timed fields left.
    it('updateRoutineFromGCal replaces a timed template with { allDay: true } on a timed→all-day transition', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const endDate = dayjs().add(2, 'day').format('YYYY-MM-DD');

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-was-timed',
                calendarEventId: 'master-timed-to-allday',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'cfg-1',
                rrule: 'FREQ=DAILY',
                calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
                lastSyncedFromGCalTs: '2020-01-01T00:00:00.000Z',
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-timed-to-allday',
                    title: 'Now all-day',
                    timeStart: startDate,
                    timeEnd: endDate,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    allDay: true,
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'master-timed-to-allday' });
        // Whole object replaced — timeOfDay/duration are gone, not merged alongside allDay.
        expect(routine?.calendarItemTemplate).toEqual({ allDay: true });
        expect(routine?.calendarItemTemplate?.timeOfDay).toBeUndefined();
        expect(routine?.calendarItemTemplate?.duration).toBeUndefined();
    });

    // Companion to the write-path fix: findExistingRoutineForEvent must relink a NAKED all-day routine
    // to its re-imported all-day master. Pre-fix the naked query matched on timeOfDay/duration derived
    // from a YYYY-MM-DD string, which a { allDay: true } routine lacks → zero match → duplicate routine.
    it('findExistingRoutineForEvent relinks a naked all-day routine instead of creating a duplicate', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const endDate = dayjs().add(2, 'day').format('YYYY-MM-DD');

        // Naked all-day routine: no calendarEventId/calendarIntegrationId (link dropped on disconnect-with-keep).
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-naked-allday',
                title: 'Anniversary',
                rrule: 'FREQ=YEARLY',
                calendarItemTemplate: { allDay: true },
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-naked-allday',
                    title: 'Anniversary',
                    timeStart: startDate,
                    timeEnd: endDate,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    allDay: true,
                    recurrence: ['RRULE:FREQ=YEARLY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Exactly one routine for this title — the naked one was relinked, not duplicated.
        const matching = await routinesDAO.findArray({ user: userId, title: 'Anniversary' });
        expect(matching).toHaveLength(1);
        const [relinked] = matching;
        if (!relinked) throw new Error('expected the naked routine to survive');
        expect(relinked._id).toBe('routine-naked-allday');
        expect(relinked.calendarEventId).toBe('master-naked-allday');
        expect(relinked.calendarItemTemplate).toEqual({ allDay: true });
    });

    // Regression: pre-fix, GCal returning a rebased-master id (`<master>_R<YYYYMMDDTHHmmss>`) led to
    // a doubly-suffixed `calendarInstanceEventId` on every generated item, causing reconcile to
    // orphan-create a duplicate item per occurrence. The import path now normalizes `event.id` at
    // its boundary; this test pins the contract that a bare-stored routine + suffixed inbound id
    // → exactly one routine (not two), and stored `calendarEventId` stays bare.
    it('importRecurringEventAsRoutine normalizes a suffixed _R<…> master id and matches a bare-stored routine (no duplicate)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareMasterId = 'mleem99efhim4a0tsh3s86797o';
        const suffixedMasterId = `${bareMasterId}_R20260519T123000`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-bare',
                calendarEventId: bareMasterId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'cfg-1',
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: suffixedMasterId,
                    title: 'Standup',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-rebased',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routines = await routinesDAO.findArray({ user: userId });
        // Exactly the one pre-existing routine — no duplicate created by the suffixed inbound id.
        expect(routines).toHaveLength(1);
        const [routine] = routines;
        if (!routine) throw new Error('expected one routine');
        expect(routine._id).toBe('routine-bare');
        expect(routine.calendarEventId).toBe(bareMasterId);
    });

    // Regression: a "this and following" split makes GCal report the series as TWO masters sharing one
    // bare id — the capped base `<id>` (UNTIL) and the open successor `<id>_R<anchor>`. Re-reporting that
    // pair every webhook fire used to mint a NEW successor routine each cycle (phase-1 capped the live
    // successor, phase-2 couldn't find an active routine on the bare id → created another), growing an
    // unbounded routine chain on RSVP-churny series. The fix keys split-successor onboarding on the stable
    // raw `_R` id (calendarRebasedEventId): the same successor re-arriving updates the SAME routine and
    // reactivates it if phase-1 wrongly capped it. This test re-delivers the split batch twice and asserts
    // the routine set never grows past the original base + successor.
    it('re-importing a split (capped base + open _R successor) converges — no new successor routine per sync', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'split-converge-master';
        const rebasedId = `${bareId}_R20260604T060000Z`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        // Pre-existing state: a capped base routine (the historical segment) + an active open successor
        // already onboarded and keyed on the raw rebased id.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: rebasedId,
                splitFromRoutineId: 'routine-base',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        // GCal re-reports BOTH masters in one batch (the recurring shape, not single instances). Mock both
        // full and incremental fetch so cycle 2 (which runs incrementally once cycle 1 stored a syncToken)
        // re-delivers the same pair. Stub watchEvents so webhook renewal doesn't hit the unmocked OAuth path.
        const splitBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z'],
                },
                {
                    id: rebasedId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-converge',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        // Two sync cycles — the chain must not grow on either.
        for (let cycle = 0; cycle < 2; cycle++) {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        }

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: bareId });
        // Exactly the two we started with — no fresh successor minted per cycle.
        expect(routines.map((r) => r._id).sort()).toEqual(['routine-base', 'routine-successor']);
        const successor = routines.find((r) => r._id === 'routine-successor');
        if (!successor) throw new Error('expected the successor to survive');
        // The successor stays active (reactivated if a same-batch base import capped it) and open.
        expect(successor.active).toBe(true);
        expect(successor.rrule).not.toContain('UNTIL=');
        // The base stays capped+inactive — never two active rows on the bare id (would violate the
        // uniq_active_routine_per_gcal_series partial index).
        expect(routines.find((r) => r._id === 'routine-base')?.active).toBe(false);
    });

    // Regression (Engineering-2 duplicate): a self-referential split (capped base + live successor on one
    // bare id) made the BARE master resolve to the live successor in phase 1 — rewriting it with the base's
    // capped rrule — while phase 2 reactivated it via the rebased id. The rrule oscillated bare↔UNTIL every
    // webhook fire, tripping `scheduleChanged` so `regenerateFutureRoutineItems` trashed+recreated ALL the
    // successor's future items each sync (the user saw stale duplicate rows + a web-push storm). The fix:
    // (1) phase 1 excludes the successor (bare master lands on the base only), and (2) regen reconciles by
    // occurrence date so an unchanged schedule is a no-op. Assert the successor's items are STABLE across
    // cycles — same ids, no fresh trash generation.
    it('a self-referential split does not churn the successor items across syncs', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'self-ref-split-master';
        const rebasedId = `${bareId}_R20260604T060000Z`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-sr',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-sr',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: rebasedId,
                splitFromRoutineId: 'routine-base-sr',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        const splitBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z'],
                },
                {
                    id: rebasedId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-self-ref',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        // Seed the successor's future items the way onboarding would, then capture their ids. Pre-inserted
        // routines carry no items, so without this the churn (which trashes EXISTING items) has nothing to act on.
        const successor = await routinesDAO.findByOwnerAndId('routine-successor-sr', userId);
        if (!successor) throw new Error('expected the seeded successor routine');
        await regenerateFutureRoutineItems(successor, userId, dayjs().toISOString(), 'Asia/Jerusalem');
        const seeded = await itemsDAO.findArray({ user: userId, routineId: 'routine-successor-sr', status: 'calendar' });
        expect(seeded.length).toBeGreaterThan(0);
        const seededIds = seeded.map((i) => i._id).sort();

        // Two sync cycles re-deliver the identical split batch — must NOT churn the seeded items.
        for (let cycle = 0; cycle < 2; cycle++) {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        }

        const liveAfter = await itemsDAO.findArray({ user: userId, routineId: 'routine-successor-sr', status: 'calendar' });
        // Same exact item ids — not trashed and recreated with fresh uuids each sync.
        expect(liveAfter.map((i) => i._id).sort()).toEqual(seededIds);
        // No trash generation produced for the successor's items across either cycle.
        const trashed = await itemsDAO.findArray({ user: userId, routineId: 'routine-successor-sr', status: 'trash' });
        expect(trashed).toHaveLength(0);
    });

    // Backfilling `calendarRebasedEventId` onto a pre-rollout successor (what the heal pass does for the
    // existing chain) makes it converge exactly like a natively-onboarded one. (An un-backfilled legacy
    // successor now ALSO self-heals — phase 2's active-series fallback re-keys it in place, see the
    // dedicated test below — but the heal-pass backfill remains the supported bulk remediation.)
    it('a backfilled calendarRebasedEventId makes a legacy successor converge', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'split-backfill-master';
        const rebasedId = `${bareId}_R20260604T060000Z`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-bf',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        // Legacy successor AFTER backfill: the heal pass has written calendarRebasedEventId onto it.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-bf',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: rebasedId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        const splitBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z'],
                },
                {
                    id: rebasedId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-backfill',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        for (let cycle = 0; cycle < 2; cycle++) {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        }

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: bareId });
        expect(routines.map((r) => r._id).sort()).toEqual(['routine-base-bf', 'routine-successor-bf']);
        expect(routines.find((r) => r._id === 'routine-successor-bf')?.active).toBe(true);
    });

    // Regression (staging 2026-07-21, the E11000 sync jam): applying "this and all following" AGAIN to an
    // already-split series makes GCal report the open tail with a NEW `_R<anchor>` suffix. The stored
    // `calendarRebasedEventId` (previous anchor) never matches, the legacy fallback can't see the
    // still-active old successor (findExistingRoutineForEvent hides successors), so the import fell
    // through to create → E11000 against the old successor → recovery re-resolved to the inactive BASE,
    // reactivated it via `newlyLosesUntil` → unguarded E11000 #2 killed the whole sync. The sync token
    // never advanced, so every retry died at the same spot and one-off events were never imported.
    // The fix re-anchors the existing successor to the incoming rebased id and updates it in place.
    it('a re-split series (new _R anchor) re-anchors the existing successor — sync survives and one-offs import', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'resplit-master';
        const oldRebasedId = `${bareId}_R20260608T073000Z`;
        const newRebasedId = `${bareId}_R20260721T073000Z`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. See the convergence test above.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        // Pre-existing split pair: capped inactive base + active successor keyed on the OLD anchor.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-rs',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260607T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-rs',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: oldRebasedId,
                splitFromRoutineId: 'routine-base-rs',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        // GCal reports the re-split: capped base (UNTIL moved forward) + the NEW `_R` open tail — plus a
        // one-off event that must still import (pre-fix, the sync died before reaching one-offs).
        const resplitBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Daily - Team Leaders',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260720T205959Z'],
                },
                {
                    id: newRebasedId,
                    title: 'Daily - Team Leaders',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'],
                },
                {
                    id: 'oneoff-after-resplit',
                    title: 'triage-agent',
                    timeStart: dayjs(tomorrowAt9).add(2, 'hour').toISOString(),
                    timeEnd: dayjs(tomorrowAt9).add(3, 'hour').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                },
            ],
            nextSyncToken: 'tok-resplit',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(resplitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(resplitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        // Two cycles: the first must survive (pre-fix it 502'd), the second must converge without growth.
        for (let cycle = 0; cycle < 2; cycle++) {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        }

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: bareId });
        // No third routine minted — the old successor was re-anchored, not duplicated.
        expect(routines.map((r) => r._id).sort()).toEqual(['routine-base-rs', 'routine-successor-rs']);
        const successor = routines.find((r) => r._id === 'routine-successor-rs');
        if (!successor) throw new Error('expected the successor to survive');
        expect(successor.calendarRebasedEventId).toBe(newRebasedId);
        expect(successor.active).toBe(true);
        expect(successor.rrule).toBe('FREQ=WEEKLY;BYDAY=WE');
        const base = routines.find((r) => r._id === 'routine-base-rs');
        expect(base?.active).toBe(false);
        // The bare master's moved-forward UNTIL landed on the BASE (not the successor) — proving the
        // base update ran and stayed correctly targeted alongside the successor re-anchor.
        expect(base?.rrule).toContain('UNTIL=20260720');
        // The one-off after the recurring masters imported — the sync no longer dies mid-batch.
        const oneOff = await itemsDAO.findArray({ user: userId, calendarEventId: 'oneoff-after-resplit' });
        expect(oneOff).toHaveLength(1);
    });

    // Selection regression: when SEVERAL stale successors linger on one bare id (leftovers of the
    // pre-convergence chain bug) and none is active, the re-anchor must target exactly the
    // most-recently-updated one and mint nothing new. Locks in reanchorResplitSuccessor's
    // prefer-active-then-most-recent pick.
    it('re-anchoring with multiple lingering capped successors picks the most recent and mints nothing', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'multi-successor-master';
        const newRebasedId = `${bareId}_R20260721T073000Z`;
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-ms',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260601T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        // Two capped, inactive stale successors with different old anchors; the second is fresher.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-old',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260610T205959Z',
                calendarEventId: bareId,
                calendarRebasedEventId: `${bareId}_R20260602T073000Z`,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: dayjs().subtract(10, 'day').toISOString(),
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-recent',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260620T205959Z',
                calendarEventId: bareId,
                calendarRebasedEventId: `${bareId}_R20260611T073000Z`,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: dayjs().subtract(1, 'day').toISOString(),
            }),
        );

        const batch = {
            events: [
                {
                    id: newRebasedId,
                    title: 'Standup',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-multi',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(batch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(batch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: bareId });
        // Nothing minted — still exactly the base + the two successors.
        expect(routines.map((r) => r._id).sort()).toEqual(['routine-base-ms', 'routine-successor-old', 'routine-successor-recent']);
        const recent = routines.find((r) => r._id === 'routine-successor-recent');
        // The fresher successor was re-anchored, uncapped, and reactivated (slot was free).
        expect(recent?.calendarRebasedEventId).toBe(newRebasedId);
        expect(recent?.active).toBe(true);
        expect(recent?.rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
        // The stale one is untouched.
        const old = routines.find((r) => r._id === 'routine-successor-old');
        expect(old?.calendarRebasedEventId).toBe(`${bareId}_R20260602T073000Z`);
        expect(old?.active).toBe(false);
    });

    // Regression for the replaceRoutineGuardingActiveSlot retry branch: the slot check and the
    // replaceById are not atomic, so a concurrent sync can claim the active slot in between. Simulate
    // that TOCTOU window by making the slot-check query (distinguished by its `_id: { $ne: … }`
    // exclusion) see a stale "slot free" state while the write hits the REAL unique index — the write
    // must retry keeping the routine inactive instead of aborting the whole sync with E11000.
    it('a reactivation losing the active-slot race keeps the routine inactive and the sync alive', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'slot-race-master';
        const rebasedId = `${bareId}_R20260604T060000Z`;
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-race',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-race',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: rebasedId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        const uncappedBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Standup',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-slot-race',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(uncappedBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(uncappedBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        // Blind ONLY the slot-check query — it's the sole routinesDAO.findArray filter carrying an
        // `_id` exclusion. Every other query passes through, so the write below hits the real
        // uniq_active_routine_per_gcal_series index and throws a genuine E11000.
        const realFindArray = routinesDAO.findArray.bind(routinesDAO);
        vi.spyOn(routinesDAO, 'findArray').mockImplementation(async (filter = {}, options = {}) => {
            if ('_id' in filter && filter._id !== null && typeof filter._id === 'object') {
                return [];
            }
            return realFindArray(filter, options);
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const base = await routinesDAO.findByOwnerAndId('routine-base-race', userId);
        if (!base) throw new Error('expected the base routine to survive');
        // The open rrule landed but the retry kept the routine inactive — the successor holds the slot.
        expect(base.rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
        expect(base.active).toBe(false);
        expect((await routinesDAO.findByOwnerAndId('routine-successor-race', userId))?.active).toBe(true);
    });

    // Regression: `newlyLosesUntil` reactivation must not collide with a live split successor. When GCal
    // uncaps the BARE master while a successor still holds the active slot on the same series key, the
    // pre-fix code flipped the capped base back to active → E11000 on replaceById → whole sync aborted.
    // The slot check keeps the base paused; the successor remains the live series.
    it('uncapping the bare master while a successor holds the active slot keeps the base inactive (no E11000 abort)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'uncap-race-master';
        const rebasedId = `${bareId}_R20260604T060000Z`;
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-uc',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-uc',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: rebasedId,
                splitFromRoutineId: 'routine-base-uc',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        // GCal reports ONLY the bare master, now uncapped (no UNTIL) — e.g. the user undid the split on
        // Google's side without the successor's tombstone arriving in the same delta.
        const uncappedBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Standup',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-uncap',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(uncappedBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(uncappedBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const base = await routinesDAO.findByOwnerAndId('routine-base-uc', userId);
        if (!base) throw new Error('expected the base routine to survive');
        // The open rrule was applied but the base was NOT reactivated into the occupied slot.
        expect(base.rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
        expect(base.active).toBe(false);
        const successor = await routinesDAO.findByOwnerAndId('routine-successor-uc', userId);
        expect(successor?.active).toBe(true);
    });

    // Regression (staging sync jam, 2026-07-19): a series split a SECOND time reports an open `_R` master
    // whose anchor differs from the successor routine's stored `calendarRebasedEventId`. The rebased-id
    // lookup misses; the old `existing?.active` fallback was dead code (findExistingRoutineForEvent's
    // base-only preference always returned the capped base) → phase 2 inserted a colliding twin →
    // E11000 → recovery picked the base and reactivated it into a SECOND E11000 → the whole sync died
    // every retry, blocking unrelated cancellation tombstones for days. The fix resolves the ACTIVE
    // routine on the bare id, updates it, and re-keys its rebased id to the new anchor.
    it('a re-split with a new _R anchor re-keys the existing successor instead of wedging the sync', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'resplit-master';
        const staleRebasedId = `${bareId}_R20260608T074500`;
        const newRebasedId = `${bareId}_R20260721T074500`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) so extractLocalTime
        // round-trips to makeRoutine's timeOfDay "09:00" — see the convergence tests above.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-rs',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260720T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        // Live successor from the FIRST split — keyed on the now-stale anchor.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-rs',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: staleRebasedId,
                splitFromRoutineId: 'routine-base-rs',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        // GCal reports the capped base + the SECOND split's open successor (new anchor).
        const splitBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260720T205959Z'],
                },
                {
                    id: newRebasedId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-resplit',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        for (let cycle = 0; cycle < 2; cycle++) {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        }

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: bareId });
        // No colliding twin minted — still exactly base + successor.
        expect(routines.map((r) => r._id).sort()).toEqual(['routine-base-rs', 'routine-successor-rs']);
        const successor = routines.find((r) => r._id === 'routine-successor-rs');
        if (!successor) throw new Error('expected the successor to survive');
        expect(successor.active).toBe(true);
        expect(successor.rrule).not.toContain('UNTIL=');
        // Re-keyed onto the new anchor, so the next sync resolves it via findSplitSuccessorByRebasedId.
        expect(successor.calendarRebasedEventId).toBe(newRebasedId);
        expect(routines.find((r) => r._id === 'routine-base-rs')?.active).toBe(false);
    });

    // Regression: a LEGACY successor (pre-rebased-id rollout, no calendarRebasedEventId) used to be
    // unreachable in phase 2 — the base-only preference in findExistingRoutineForEvent made the old
    // `existing?.active` fallback dead code, so a re-reported split minted a colliding twin (E11000).
    // The active-series fallback now updates it in place AND backfills the rebased id.
    it('an un-backfilled legacy successor self-heals: updated in place and re-keyed', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'legacy-successor-master';
        const rebasedId = `${bareId}_R20260604T060000Z`;
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-lg',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        // Legacy successor: NO calendarRebasedEventId.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-lg',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                splitFromRoutineId: 'routine-base-lg',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        const splitBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z'],
                },
                {
                    id: rebasedId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-legacy-heal',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        for (let cycle = 0; cycle < 2; cycle++) {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        }

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: bareId });
        expect(routines.map((r) => r._id).sort()).toEqual(['routine-base-lg', 'routine-successor-lg']);
        const successor = routines.find((r) => r._id === 'routine-successor-lg');
        if (!successor) throw new Error('expected the successor to survive');
        expect(successor.active).toBe(true);
        // Backfilled in place — the legacy row is now keyed like a natively-onboarded successor.
        expect(successor.calendarRebasedEventId).toBe(rebasedId);
    });

    // Fault-isolation regression: one broken recurring series must not abort the whole sync. This
    // mirrors the real incident — the routine-import crash ran BEFORE plain-event upserts, so a
    // cancellation tombstone for an unrelated item was never applied and the item stayed live for days.
    it('a failing recurring-series import does not block cancellation tombstones for other items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-blocked-tombstone',
            user: userId,
            status: 'calendar',
            title: 'Cancelled on GCal during the jam',
            timeStart: now,
            timeEnd: now,
            calendarEventId: 'evt-blocked-tombstone',
            calendarIntegrationId: 'int-1',
            createdTs: now,
            updatedTs: now,
        });

        // The recurring master's routine insert blows up (any per-series failure — E11000, provider
        // hiccup). The batch also carries the unrelated cancelled tombstone.
        const insertSpy = vi.spyOn(routinesDAO, 'insertOne').mockImplementation(async (routine) => {
            throw new Error(`simulated per-series failure for ${routine.calendarEventId}`);
        });
        try {
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [
                    {
                        id: 'boom-series',
                        title: 'Broken series',
                        timeStart: now,
                        timeEnd: dayjs(now).add(30, 'minute').toISOString(),
                        updated: now,
                        status: 'confirmed' as const,
                        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                    },
                    {
                        id: 'evt-blocked-tombstone',
                        title: 'Cancelled on GCal during the jam',
                        timeStart: now,
                        timeEnd: now,
                        updated: now,
                        status: 'cancelled' as const,
                    },
                ],
                nextSyncToken: 'tok-isolated',
            });
            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
                resourceId: 'res-1',
                expiration: dayjs().add(7, 'day').toISOString(),
            });

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        } finally {
            insertSpy.mockRestore();
        }

        // The tombstone landed despite the broken series.
        const item = await itemsDAO.findOne({ _id: 'item-blocked-tombstone' });
        expect(item?.status).toBe('trash');
        expect(item?.cancelledByGCal).toBe(true);
        // And the broken series was skipped, not half-imported.
        const boomRoutines = await routinesDAO.findArray({ user: userId, calendarEventId: 'boom-series' });
        expect(boomRoutines).toHaveLength(0);
    });

    // Fix A regression: when duplicate routines linger on the same (user, calendarEventId, integration)
    // triple, an inbound master update must resolve to the LIVE routine — never a dead duplicate. Pre-fix,
    // findExistingRoutineForEvent returned the first arbitrary match, so the update could land on a
    // paused/replaced routine while the active one drifted out of sync.
    it('findExistingRoutineForEvent prefers the active routine when a dead duplicate shares the series', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const sharedEventId = 'shared-master-event';
        const longAgo = dayjs().subtract(30, 'day').toISOString();
        // Dead duplicate: more recently updated than the live one, so a naive "first/most-recent" pick
        // would wrongly choose it. The active filter must override recency.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-dead',
                title: 'Old name',
                active: false,
                calendarEventId: sharedEventId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: dayjs().subtract(1, 'day').toISOString(),
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-live',
                title: 'Old name',
                active: true,
                calendarEventId: sharedEventId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: longAgo,
            }),
        );

        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: sharedEventId,
                    title: 'New name',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-fixA-1',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // The inbound rename landed on the live routine; the dead duplicate is untouched.
        const live = await routinesDAO.findByOwnerAndId('routine-live', userId);
        const dead = await routinesDAO.findByOwnerAndId('routine-dead', userId);
        expect(live?.title).toBe('New name');
        expect(dead?.title).toBe('Old name');
    });

    it('findExistingRoutineForEvent falls back to most-recently-updated when every match is inactive', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const sharedEventId = 'all-dead-master-event';
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-older',
                title: 'Old name',
                active: false,
                calendarEventId: sharedEventId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: dayjs().subtract(10, 'day').toISOString(),
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-newer',
                title: 'Old name',
                active: false,
                calendarEventId: sharedEventId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: dayjs().subtract(2, 'day').toISOString(),
            }),
        );

        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: sharedEventId,
                    title: 'New name',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-fixA-2',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // No active routine exists → deterministic fallback to the most-recently-updated dead one.
        const newer = await routinesDAO.findByOwnerAndId('routine-newer', userId);
        const older = await routinesDAO.findByOwnerAndId('routine-older', userId);
        expect(newer?.title).toBe('New name');
        expect(older?.title).toBe('Old name');
        // No third routine was created — the existing match absorbed the update.
        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: sharedEventId });
        expect(routines).toHaveLength(2);
    });

    it('findExistingRoutineForEvent resolves a single matching routine unchanged (regression guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const sharedEventId = 'single-master-event';
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-only',
                title: 'Old name',
                active: true,
                calendarEventId: sharedEventId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: dayjs().subtract(30, 'day').toISOString(),
            }),
        );

        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: sharedEventId,
                    title: 'New name',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-fixA-3',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: sharedEventId });
        expect(routines).toHaveLength(1);
        const only = await routinesDAO.findByOwnerAndId('routine-only', userId);
        expect(only?.title).toBe('New name');
    });

    // Fix B2 regression: createRoutineFromGCal races a concurrent webhook that already created the live
    // routine. The unique partial index makes our insert E11000. Pre-fix that threw out of the whole
    // sync; now we re-resolve via findExistingRoutineForEvent and update the race winner — no duplicate,
    // no throw. Mirrors the item-side naked-relink race test above.
    it('createRoutineFromGCal that races an E11000 re-resolves and updates the existing routine (no duplicate, 200)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const sharedEventId = 'race-master-event';
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        // Simulate the concurrent winner: the first time our insert runs for a routine bound to this
        // series, slip a rival active routine into the DB first (so the real insert collides on the
        // uniq_active_routine_per_gcal_series index), then forward to the real insertOne.
        const realInsertOne = routinesDAO.insertOne.bind(routinesDAO);
        let rivalInjected = false;
        vi.spyOn(routinesDAO, 'insertOne').mockImplementation(async (doc, options) => {
            const incoming = doc as Partial<RoutineInterface>;
            if (!rivalInjected && incoming.calendarEventId === sharedEventId && incoming._id !== 'routine-rival') {
                rivalInjected = true;
                await realInsertOne(
                    makeRoutine(userId, {
                        _id: 'routine-rival',
                        title: 'Rival winner',
                        active: true,
                        calendarEventId: sharedEventId,
                        calendarIntegrationId: 'int-1',
                        calendarSyncConfigId: 'sync-config-1',
                        updatedTs: dayjs().subtract(1, 'hour').toISOString(),
                    }),
                );
            }
            return await realInsertOne(doc, options);
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: sharedEventId,
                    title: 'Inbound name',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-race-routine',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const warnSpy = vi.spyOn(console, 'warn');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        // Sync survives the collision — no E11000 escapes.
        expect(res.status).toBe(200);

        // The E11000 catch path actually fired (guards against the test passing for the wrong reason,
        // e.g. if Fix A resolved the rival before reaching createRoutineFromGCal).
        expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('createRoutineFromGCal raced E11000'))).toBe(true);

        // Exactly one routine on the series: the rival winner, updated to the inbound name (not duplicated).
        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: sharedEventId });
        expect(routines).toHaveLength(1);
        const [routine] = routines;
        if (!routine) throw new Error('expected one routine');
        expect(routine._id).toBe('routine-rival');
        expect(routine.title).toBe('Inbound name');
    });

    // Fix B2 safety: a NON-duplicate error from the routine insert must NOT be swallowed by the E11000
    // catch — createRoutineFromGCal re-throws it, so the series is skipped cleanly (no half-import, no
    // silent "recovered" update). Since the per-series isolation wrapper, the throw no longer fails the
    // whole sync (pre-isolation this test asserted a 502): it is logged and the sync completes.
    it('createRoutineFromGCal re-throws a non-duplicate insert error — series skipped, sync completes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        // Non-E11000 failure on the create insert.
        vi.spyOn(routinesDAO, 'insertOne').mockRejectedValueOnce(new Error('mongo blip — not a duplicate key'));

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'non-dup-error-event',
                    title: 'Will fail',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-nondup',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        // The non-duplicate error escapes createRoutineFromGCal (NOT swallowed by the E11000-only
        // catch — no bogus "recovered" update ran) and is contained by the per-series isolation
        // wrapper: logged, series skipped, sync completes.
        const errorSpy = vi.spyOn(console, 'error');
        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('recurring-master import failed'))).toBe(true);
        // Nothing half-imported for the failed series.
        const failedSeriesRoutines = await routinesDAO.findArray({ user: userId, calendarEventId: 'non-dup-error-event' });
        expect(failedSeriesRoutines).toHaveLength(0);
    });

    it('importCalendarEvents normalizes a suffixed recurringEventId on an instance so it is filtered as a series instance (not upserted as a standalone item)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareMasterId = 'mleem99efhim4a0tsh3s86797o';
        const suffixedMasterId = `${bareMasterId}_R20260519T123000`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        const tomorrowAt930 = dayjs(tomorrowAt9).add(30, 'minute').toISOString();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-bare-2',
                calendarEventId: bareMasterId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'cfg-1',
            }),
        );

        // Inbound: one instance event whose recurringEventId carries the rebased-master suffix.
        // Pre-fix, this was treated as a standalone event (not a series instance) and upserted as
        // a duplicate item alongside the routine-generated one.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: `${bareMasterId}_20260518T060000Z`,
                    title: 'Standup',
                    timeStart: tomorrowAt9,
                    timeEnd: tomorrowAt930,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurringEventId: suffixedMasterId,
                },
            ],
            nextSyncToken: 'tok-instance',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // No standalone item should be upserted — the routine generator owns the series instances.
        const standaloneItems = await itemsDAO.findArray({ user: userId, calendarEventId: `${bareMasterId}_20260518T060000Z` } as never);
        expect(standaloneItems).toHaveLength(0);
    });

    it('revive clears a prior cancelledByGCal: true (restored item carries no phantom badge)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const past = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        // Item was previously cancelled by GCal — trashed locally and stamped.
        await itemsDAO.insertOne({
            _id: 'item-revive-clear-flag',
            user: userId,
            status: 'trash',
            title: 'Was cancelled',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-revive-clear-flag',
            calendarIntegrationId: 'int-1',
            cancelledByGCal: true,
            createdTs: past,
            updatedTs: past,
            lastSyncedFromGCalTs: past,
        });

        // GCal re-emits the event as confirmed (e.g. user un-cancelled it on the GCal side).
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-revive-clear-flag',
                    title: 'Was cancelled',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-revive-clear-flag' });
        expect(item?.status).toBe('calendar');
        expect(item?.cancelledByGCal).toBeUndefined();
    });

    it('allDay: true → false transition strips the stale flag from the local item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const localAnchor = dayjs().subtract(1, 'hour').toISOString();
        const eventUpdated = dayjs().toISOString();
        const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const endDate = dayjs().add(2, 'day').format('YYYY-MM-DD');
        // Local item was previously all-day.
        await itemsDAO.insertOne({
            _id: 'item-allday-flip',
            user: userId,
            status: 'calendar',
            title: 'Was all day',
            allDay: true,
            timeStart: startDate,
            timeEnd: endDate,
            calendarEventId: 'evt-allday-flip',
            calendarIntegrationId: 'int-1',
            createdTs: localAnchor,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        // GCal now returns the event as timed (allDay: false / absent).
        const timedStart = dayjs().add(1, 'day').toISOString();
        const timedEnd = dayjs(timedStart).add(1, 'hour').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-allday-flip',
                    title: 'Now timed',
                    timeStart: timedStart,
                    timeEnd: timedEnd,
                    updated: eventUpdated,
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-allday-flip' });
        expect(item?.allDay).toBeUndefined();
        expect(item?.timeStart).toBe(timedStart);
        expect(item?.timeEnd).toBe(timedEnd);
    });

    it('GCal-older payload changing only responseStatus still falls through and overwrites', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const eventUpdated = dayjs().subtract(2, 'hour').toISOString();
        const localAnchor = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-responsestatus-only',
            user: userId,
            status: 'calendar',
            title: 'Meeting',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-responsestatus-only',
            calendarIntegrationId: 'int-1',
            attendees: [{ email: 'alice@example.com', responseStatus: 'needsAction', self: true }],
            responseStatus: 'needsAction',
            createdTs: eventUpdated,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        // GCal payload is older but reports a fresher RSVP on the self attendee.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-responsestatus-only',
                    title: 'Meeting',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: eventUpdated,
                    status: 'confirmed',
                    attendees: [{ email: 'alice@example.com', responseStatus: 'accepted', self: true }],
                    responseStatus: 'accepted',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-responsestatus-only' });
        // Title (structural, older payload) preserved; responseStatus (GCal-owned) overwritten.
        expect(item?.title).toBe('Meeting');
        expect(item?.responseStatus).toBe('accepted');
        const acceptedAttendee = item?.attendees?.find((a) => a.self);
        expect(acceptedAttendee?.responseStatus).toBe('accepted');
    });

    it('GCal-owned routine delta from an older webhook stamps updatedTs at sync time, not the backwards event.updated', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Routine last synced from GCal at gcalAnchor; local updatedTs is newer (T2). The webhook
        // replays an OLDER master (event.updated < gcalAnchor) carrying only an attendee delta →
        // the GCal-owned-only fast-path. Pre-fix it stamped `updatedTs: event.updated` — a
        // backwards move that every other device's `<=` LWW gate rejects, so the fanned-out op
        // silently diverged. The row must instead advance to the sync clock.
        const olderEventUpdated = '2025-12-31T00:00:00.000Z';
        const gcalAnchor = '2026-01-01T00:00:00.000Z';
        const localUpdatedTs = '2026-02-01T00:00:00.000Z';
        // 09:00 Jerusalem / 30-minute duration → matches makeRoutine's default template (no structural diff).
        const masterTimeStart = '2025-06-09T09:00:00+03:00';
        const masterTimeEnd = '2025-06-09T09:30:00+03:00';
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-gcal-owned-delta',
                calendarEventId: 'gcal-master-owned-delta',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                lastSyncedFromGCalTs: gcalAnchor,
                updatedTs: localUpdatedTs,
                attendees: [{ email: 'stale@example.com', responseStatus: 'needsAction' }],
            }),
        );

        const masterEvent = {
            id: 'gcal-master-owned-delta',
            title: 'Standup',
            timeStart: masterTimeStart,
            timeEnd: masterTimeEnd,
            updated: olderEventUpdated,
            status: 'confirmed' as const,
            recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
            attendees: [{ email: 'fresh@example.com', responseStatus: 'accepted' }],
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [masterEvent], nextSyncToken: 'tok-owned-delta' });

        const beforeSync = dayjs().toISOString();
        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findByOwnerAndId('routine-gcal-owned-delta', userId);
        // GCal-owned delta applied…
        expect(routine?.attendees).toEqual([{ email: 'fresh@example.com', responseStatus: 'accepted' }]);
        // …with updatedTs advanced to the sync clock — never moved backwards to event.updated.
        // (This is the one assertion that discriminates the fix; the rest of the test is a
        // forward-guard on surrounding invariants.)
        expect(dayjs(routine?.updatedTs).isBefore(beforeSync)).toBe(false);
        // The GCal-side anchor is untouched by this fast-path.
        expect(routine?.lastSyncedFromGCalTs).toBe(gcalAnchor);
        // The fanned-out op snapshot matches the stored row, so other devices' LWW gates accept it.
        const ops = await operationsDAO.findArray({ entityId: 'routine-gcal-owned-delta', entityType: 'routine' });
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one routine op');
        expect((op.snapshot as RoutineInterface).updatedTs).toBe(routine?.updatedTs);

        // No lock-out (forward-guard, invariant under the stamp change): a later structural
        // webhook whose event.updated is newer than the anchor (but older than the ctx.now just
        // stamped) still applies, because the structural gate compares against
        // lastSyncedFromGCalTs, not updatedTs.
        const structuralEventUpdated = '2026-03-01T00:00:00.000Z';
        // The first sync stored a syncToken, so the second sync takes the incremental path.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({
            events: [{ ...masterEvent, title: 'Standup renamed', updated: structuralEventUpdated }],
            nextSyncToken: 'tok-owned-delta-2',
        });
        const res2 = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res2.status).toBe(200);
        const renamed = await routinesDAO.findByOwnerAndId('routine-gcal-owned-delta', userId);
        expect(renamed?.title).toBe('Standup renamed');
    });
});

// ─── POST /calendar/integrations/:id/link-routine/:routineId ─────────────

describe('POST /calendar/integrations/:id/link-routine/:routineId', () => {
    it('returns 404 when integration not found', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await routinesDAO.insertOne(makeRoutine(userId));

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/no-such-id/link-routine/routine-1',
            sessionCookie,
        });
        expect(res.status).toBe(404);
    });

    it('returns 404 when routine not found', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/link-routine/no-such-routine',
            sessionCookie,
        });
        expect(res.status).toBe(404);
    });

    it('returns 400 when routine is not a calendar routine', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        await routinesDAO.insertOne({ ...makeRoutine(userId), routineType: 'fixedSchedule' } as never);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/link-routine/routine-1',
            sessionCookie,
        });
        expect(res.status).toBe(400);
    });

    it('creates a GCal event, stores calendarEventId on the routine, and records an operation', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        await routinesDAO.insertOne(makeRoutine(userId));

        vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-new-event-id');

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/link-routine/routine-1',
            sessionCookie,
        });
        expect(res.status).toBe(201);
        expect(await res.json()).toMatchObject({ calendarEventId: 'gcal-new-event-id' });

        const routine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(routine?.calendarEventId).toBe('gcal-new-event-id');
        expect(routine?.calendarIntegrationId).toBe('int-1');

        const ops = await db.collection('operations').find({ entityId: 'routine-1' }).toArray();
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ opType: 'update', entityType: 'routine' });
    });

    it("uses the integration's default sync config calendarId when integration.calendarId is undefined (Step 2+ rows)", async () => {
        // New (Step 2+) integrations carry no calendarId field — only sync configs do. Verify the
        // resolveDefaultCalendarId fallback picks the default config's calendarId.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const integration = makeIntegration(userId);
        delete integration.calendarId; // simulate Step 2+ shape
        await calendarIntegrationsDAO.insertEncrypted(integration);
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, 'int-1', { calendarId: 'work@group.calendar.google.com', isDefault: true }));
        await routinesDAO.insertOne(makeRoutine(userId));

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-new-id');

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/link-routine/routine-1',
            sessionCookie,
        });
        expect(res.status).toBe(201);
        // The default sync config's calendarId must be passed to provider.createRecurringEvent.
        expect(createSpy).toHaveBeenCalledWith(expect.anything(), 'work@group.calendar.google.com', expect.any(String));
    });

    it('returns 400 when integration has no calendarId AND no sync configs', async () => {
        // Defensive: a Step 2+ integration where the user dismissed the post-OAuth dialog has no
        // configs. resolveDefaultCalendarId returns null → route returns 400.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const integration = makeIntegration(userId);
        delete integration.calendarId;
        await calendarIntegrationsDAO.insertEncrypted(integration);
        await routinesDAO.insertOne(makeRoutine(userId));

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/link-routine/routine-1',
            sessionCookie,
        });
        expect(res.status).toBe(400);
    });
});

// ─── DELETE /calendar/integrations/:id ────────────────────────────────────

describe('DELETE /calendar/integrations/:id', () => {
    it('returns 404 for an unknown integration', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, { method: 'DELETE', path: '/calendar/integrations/bad-id', sessionCookie });
        expect(res.status).toBe(404);
    });

    it('removes the integration with action=keepLinkedEntities and never touches GCal', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);
        expect(await calendarIntegrationsDAO.findByOwnerAndIdDecrypted('int-1', userId)).toBeNull();
        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('clears calendar links on items + routines with action=keepLinkedEntities, preserving status', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-keep', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-keep',
            user: userId,
            status: 'calendar',
            title: 'Coffee chat',
            calendarEventId: 'gcal-evt-keep-item',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: now,
            updatedTs: now,
        });

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        // Item retains status but loses its calendar links.
        const item = await itemsDAO.findOne({ _id: 'item-keep' });
        expect(item?.status).toBe('calendar');
        expect(item?.calendarEventId).toBeUndefined();
        expect(item?.calendarIntegrationId).toBeUndefined();
        expect(item?.calendarSyncConfigId).toBeUndefined();

        // Routine retains its row but loses its calendar links.
        const updatedRoutine = await routinesDAO.findOne({ _id: 'routine-1' });
        expect(updatedRoutine?.calendarEventId).toBeUndefined();
        expect(updatedRoutine?.calendarIntegrationId).toBeUndefined();

        // Disconnect must never call GCal.
        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('trashes items + routines with action=removeLinkedEntities and never touches GCal', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        const now = dayjs().toISOString();
        // Routine-generated calendar item — cascaded by trashRoutinesForIntegration via pushRoutineDeletion.
        await itemsDAO.insertOne({
            _id: 'item-r1',
            user: userId,
            status: 'calendar',
            title: 'Standup Mon',
            routineId: 'routine-1',
            createdTs: now,
            updatedTs: now,
        });
        // Standalone calendar item linked to the integration directly — trashed by trashItemsForIntegration.
        await itemsDAO.insertOne({
            _id: 'item-direct',
            user: userId,
            status: 'calendar',
            title: 'One-off meeting',
            calendarEventId: 'gcal-evt-direct',
            calendarIntegrationId: 'int-1',
            createdTs: now,
            updatedTs: now,
        });

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=removeLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const generatedItem = await itemsDAO.findOne({ _id: 'item-r1' });
        expect(generatedItem?.status).toBe('trash');
        const directItem = await itemsDAO.findOne({ _id: 'item-direct' });
        expect(directItem?.status).toBe('trash');

        const ops = await operationsDAO.findArray({ entityId: 'item-r1' });
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ opType: 'update', snapshot: expect.objectContaining({ status: 'trash' }) });

        // Disconnect must never call GCal — even when the routine has a calendarEventId.
        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('cascade-deletes sync configs when integration is removed', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        expect(await calendarSyncConfigsDAO.findByIntegration('int-1')).toHaveLength(1);

        vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        expect(await calendarSyncConfigsDAO.findByIntegration('int-1')).toHaveLength(0);
    });

    it('rejects unknown action values with 400', async () => {
        // parseUnlinkAction must reject any value other than the two allowed verbs so a typo
        // never silently falls through to the default branch.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=deleteEverything',
            sessionCookie,
        });
        expect(res.status).toBe(400);
        // Integration must remain so the user can retry with a valid action.
        expect(await calendarIntegrationsDAO.findByOwnerAndIdDecrypted('int-1', userId)).not.toBeNull();
    });

    it('defaults to keepLinkedEntities when no action query param is provided', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-default',
            user: userId,
            status: 'calendar',
            title: 'Coffee',
            calendarEventId: 'gcal-evt-1',
            calendarIntegrationId: 'int-1',
            createdTs: now,
            updatedTs: now,
        });

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1', // no ?action=
            sessionCookie,
        });
        expect(res.status).toBe(200);

        // Default = keepLinkedEntities → status preserved, links cleared.
        const item = await itemsDAO.findOne({ _id: 'item-default' });
        expect(item?.status).toBe('calendar');
        expect(item?.calendarIntegrationId).toBeUndefined();
    });

    it('does not affect items whose calendarIntegrationId points elsewhere', async () => {
        // The (user, provider) unique index allows only one google integration per user, so we
        // simulate "another integration" with a phantom id on the items themselves. unlinkItems'
        // filter `calendarIntegrationId === <this>` must skip the phantom rows.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-int-1',
            user: userId,
            status: 'calendar',
            title: 'In int-1',
            calendarEventId: 'gcal-1',
            calendarIntegrationId: 'int-1',
            createdTs: now,
            updatedTs: now,
        });
        await itemsDAO.insertOne({
            _id: 'item-other',
            user: userId,
            status: 'calendar',
            title: 'In other integration',
            calendarEventId: 'gcal-other',
            calendarIntegrationId: 'int-other-phantom',
            createdTs: now,
            updatedTs: now,
        });

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const itemInt1 = await itemsDAO.findOne({ _id: 'item-int-1' });
        const itemOther = await itemsDAO.findOne({ _id: 'item-other' });
        // int-1's link cleared; the other-integration item's link preserved verbatim.
        expect(itemInt1?.calendarIntegrationId).toBeUndefined();
        expect(itemOther?.calendarIntegrationId).toBe('int-other-phantom');
        expect(itemOther?.calendarEventId).toBe('gcal-other');
    });

    it('records an op for every unlinked item with cleared link fields in the snapshot', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-op',
            user: userId,
            status: 'calendar',
            title: 'Track me',
            calendarEventId: 'gcal-op',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-X',
            createdTs: now,
            updatedTs: now,
        });

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const ops = await operationsDAO.findArray({ entityId: 'item-op' });
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ opType: 'update', entityType: 'item' });
        const snapshot = ops[0]!.snapshot as ItemInterface;
        expect(snapshot.calendarEventId).toBeUndefined();
        expect(snapshot.calendarIntegrationId).toBeUndefined();
        expect(snapshot.calendarSyncConfigId).toBeUndefined();
        // Status untouched in keepLinkedEntities.
        expect(snapshot.status).toBe('calendar');
    });

    it('removeLinkedEntities cascades routine-generated items to trash without ever calling provider.deleteRecurringEvent', async () => {
        // skipGCalDelete: pushRoutineDeletion must short-circuit so a fake-tokens integration
        // never triggers a real GCal API call. Asserts the call count is zero — the strongest
        // signal that disconnect can never reach Google.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        await routinesDAO.insertOne(makeRoutine(userId, { calendarEventId: 'gcal-master', calendarIntegrationId: 'int-1' }));

        const now = dayjs().toISOString();
        // Three generated items so the cascade path has real work to do.
        for (let i = 0; i < 3; i++) {
            await itemsDAO.insertOne({
                _id: `item-gen-${i}`,
                user: userId,
                status: 'calendar',
                title: `Standup #${i}`,
                routineId: 'routine-1',
                calendarEventId: `gcal-evt-${i}`,
                calendarIntegrationId: 'int-1',
                createdTs: now,
                updatedTs: now,
            });
        }

        const deleteRecurringSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);
        const deleteEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=removeLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        for (let i = 0; i < 3; i++) {
            const it = await itemsDAO.findOne({ _id: `item-gen-${i}` });
            expect(it?.status).toBe('trash');
        }
        const routine = await routinesDAO.findOne({ _id: 'routine-1' });
        expect(routine?.active).toBe(false);

        // Critical: GCal must not be touched even though the routine had a calendarEventId.
        expect(deleteRecurringSpy).not.toHaveBeenCalled();
        expect(deleteEventSpy).not.toHaveBeenCalled();
    });
});

// ─── Disconnect/reconnect idempotency ──────────────────────────────────────

describe('disconnect/reconnect — idempotency and done preservation', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('removeLinkedEntities leaves done items as done (only unlinks them)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-done',
            user: userId,
            status: 'done',
            title: 'Already done',
            calendarEventId: 'gcal-done',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: now,
            updatedTs: now,
        });
        await itemsDAO.insertOne({
            _id: 'item-open',
            user: userId,
            status: 'calendar',
            title: 'Open one',
            calendarEventId: 'gcal-open',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: now,
            updatedTs: now,
        });

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=removeLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const done = await itemsDAO.findOne({ _id: 'item-done' });
        expect(done?.status).toBe('done');
        expect(done?.calendarEventId).toBeUndefined();
        expect(done?.calendarIntegrationId).toBeUndefined();
        expect(done?.calendarSyncConfigId).toBeUndefined();

        const open = await itemsDAO.findOne({ _id: 'item-open' });
        expect(open?.status).toBe('trash');
    });

    it('relinks a naked calendar item to the same GCal event on reconnect (no duplicate)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureStart = dayjs().add(1, 'day').startOf('hour').toISOString();
        const futureEnd = dayjs(futureStart).add(1, 'hour').toISOString();
        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        // Naked item: previously linked, link cleared by disconnect, status preserved.
        await itemsDAO.insertOne({
            _id: 'item-naked',
            user: userId,
            status: 'calendar',
            title: 'C2',
            timeStart: futureStart,
            timeEnd: futureEnd,
            createdTs: oldTs,
            updatedTs: oldTs,
            lastSyncedFromGCalTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-c2-new',
                    title: 'C2',
                    timeStart: futureStart,
                    timeEnd: futureEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const all = await itemsDAO.findArray({ user: userId, title: 'C2' });
        expect(all).toHaveLength(1);
        expect(all[0]!._id).toBe('item-naked');
        expect(all[0]!.calendarEventId).toBe('gcal-c2-new');
        expect(all[0]!.calendarIntegrationId).toBe('int-1');
        expect(all[0]!.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('does not relink a naked item with the same title but different time (creates a new item)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const nakedStart = dayjs().add(1, 'day').startOf('hour').toISOString();
        const nakedEnd = dayjs(nakedStart).add(1, 'hour').toISOString();
        const eventStart = dayjs(nakedStart).add(2, 'hour').toISOString();
        const eventEnd = dayjs(eventStart).add(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-naked-other-time',
            user: userId,
            status: 'calendar',
            title: 'Same title',
            timeStart: nakedStart,
            timeEnd: nakedEnd,
            createdTs: nakedStart,
            updatedTs: nakedStart,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-other',
                    title: 'Same title',
                    timeStart: eventStart,
                    timeEnd: eventEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const all = await itemsDAO.findArray({ user: userId, title: 'Same title' });
        expect(all).toHaveLength(2);
        // Naked one untouched.
        const naked = all.find((i) => i._id === 'item-naked-other-time');
        expect(naked?.calendarEventId).toBeUndefined();
        // New one was created with the link.
        const created = all.find((i) => i._id !== 'item-naked-other-time');
        expect(created?.calendarEventId).toBe('gcal-other');
    });

    it('relinks the most recently updated naked candidate when several match', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const start = dayjs().add(1, 'day').startOf('hour').toISOString();
        const end = dayjs(start).add(1, 'hour').toISOString();
        const olderTs = dayjs().subtract(2, 'hour').toISOString();
        const newerTs = dayjs().subtract(1, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-naked-old',
            user: userId,
            status: 'calendar',
            title: 'Dup',
            timeStart: start,
            timeEnd: end,
            createdTs: olderTs,
            updatedTs: olderTs,
        });
        await itemsDAO.insertOne({
            _id: 'item-naked-new',
            user: userId,
            status: 'calendar',
            title: 'Dup',
            timeStart: start,
            timeEnd: end,
            createdTs: newerTs,
            updatedTs: newerTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-dup',
                    title: 'Dup',
                    timeStart: start,
                    timeEnd: end,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const newer = await itemsDAO.findOne({ _id: 'item-naked-new' });
        expect(newer?.calendarEventId).toBe('gcal-dup');
        const older = await itemsDAO.findOne({ _id: 'item-naked-old' });
        expect(older?.calendarEventId).toBeUndefined();
    });

    it('preserves done status when a trashed item with "✓ " title prefix would otherwise be revived', async () => {
        // This codifies the belt-and-braces guard in reviveTrashedCalendarItem: even if a future
        // path trashes a done item, the inbound GCal event must not resurrect it as 'calendar'.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const start = dayjs().add(1, 'day').startOf('hour').toISOString();
        const end = dayjs(start).add(1, 'hour').toISOString();
        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-trashed-done',
            user: userId,
            status: 'trash',
            title: '✓ Was done',
            timeStart: start,
            timeEnd: end,
            calendarEventId: 'gcal-was-done',
            calendarIntegrationId: 'int-1',
            createdTs: oldTs,
            updatedTs: oldTs,
            lastSyncedFromGCalTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-was-done',
                    title: '✓ Was done',
                    timeStart: start,
                    timeEnd: end,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-trashed-done' });
        expect(item?.status).toBe('done');
        expect(item?.title).toBe('Was done');
        expect(item?.calendarEventId).toBe('gcal-was-done');
    });

    it('relinks a naked DONE item whose GCal event title still has the "✓ " marker', async () => {
        // Realistic done-item flow: the app stores done titles unprefixed but pushes them prefixed
        // to GCal. After removeLinkedEntities (which now unlinks done items rather than trashing
        // them), reconnect must match the stored unprefixed title against the GCal-prefixed title
        // and relink the same row — not create a duplicate live `calendar` item.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const start = dayjs().add(1, 'day').startOf('hour').toISOString();
        const end = dayjs(start).add(1, 'hour').toISOString();
        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        // Naked done item: status preserved, link fields cleared. Title stored without "✓ ".
        await itemsDAO.insertOne({
            _id: 'item-done-naked',
            user: userId,
            status: 'done',
            title: 'Pay rent',
            timeStart: start,
            timeEnd: end,
            createdTs: oldTs,
            updatedTs: oldTs,
            lastSyncedFromGCalTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-pay-rent',
                    title: '✓ Pay rent', // GCal still carries the prefix from before disconnect.
                    timeStart: start,
                    timeEnd: end,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const all = await itemsDAO.findArray({ user: userId, title: { $in: ['Pay rent', '✓ Pay rent'] } });
        expect(all).toHaveLength(1);
        expect(all[0]!._id).toBe('item-done-naked');
        expect(all[0]!.status).toBe('done');
        expect(all[0]!.title).toBe('Pay rent'); // marker stripped because item is done
        expect(all[0]!.calendarEventId).toBe('gcal-pay-rent');
        expect(all[0]!.calendarIntegrationId).toBe('int-1');
    });

    it('matches a naked candidate whose timeStart/timeEnd ISO offset differs from the inbound event', async () => {
        // GCal can echo back times with a different offset string than what the app stored locally
        // (DST roundtrip, calendar-tz reformatting). The naked-lookup uses a ±1-minute window per
        // bound rather than string equality so these legitimate roundtrip variants still match.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        // Stored in +03:00 (Asia/Jerusalem standard time); inbound presented in UTC for the same instant.
        const storedStart = dayjs.tz(`${futureDate}T15:00:00`, 'Asia/Jerusalem').format();
        const storedEnd = dayjs.tz(`${futureDate}T16:00:00`, 'Asia/Jerusalem').format();
        const inboundStart = dayjs(storedStart).utc().format();
        const inboundEnd = dayjs(storedEnd).utc().format();
        expect(inboundStart).not.toBe(storedStart); // sanity — strings differ
        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-naked-tz',
            user: userId,
            status: 'calendar',
            title: 'Tz event',
            timeStart: storedStart,
            timeEnd: storedEnd,
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-tz',
                    title: 'Tz event',
                    timeStart: inboundStart,
                    timeEnd: inboundEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const all = await itemsDAO.findArray({ user: userId, title: 'Tz event' });
        expect(all).toHaveLength(1);
        expect(all[0]!._id).toBe('item-naked-tz');
        expect(all[0]!.calendarEventId).toBe('gcal-tz');
    });

    it('does not relink a naked candidate when the inbound event is in the past (no spurious op)', async () => {
        // Past-event short-circuit must run before the relink so we don't churn the op log
        // for an event that won't produce a live local item.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const pastStart = dayjs().subtract(2, 'day').toISOString();
        const pastEnd = dayjs(pastStart).add(1, 'hour').toISOString();
        const oldTs = dayjs().subtract(3, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-naked-past',
            user: userId,
            status: 'calendar',
            title: 'Old past',
            timeStart: pastStart,
            timeEnd: pastEnd,
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-past',
                    title: 'Old past',
                    timeStart: pastStart,
                    timeEnd: pastEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // No relink op was recorded — the past-event guard fired first.
        const ops = await operationsDAO.findArray({ entityId: 'item-naked-past' });
        expect(ops).toHaveLength(0);
        // Naked item is unchanged.
        const item = await itemsDAO.findOne({ _id: 'item-naked-past' });
        expect(item?.calendarEventId).toBeUndefined();
    });

    it('relink is conditional — a concurrent claim on the same naked candidate yields a fresh item, not a clobber', async () => {
        // Simulates the TOCTOU window: another writer atomically attaches link fields between
        // our findArray and our updateOne. Conditional update matches 0 docs → caller falls
        // through to createNewCalendarItem with the inbound event's id. Result: two items, no
        // silent overwrite of the prior claim. Better duplicate than data loss.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const start = dayjs().add(1, 'day').startOf('hour').toISOString();
        const end = dayjs(start).add(1, 'hour').toISOString();
        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-naked-race',
            user: userId,
            status: 'calendar',
            title: 'Race',
            timeStart: start,
            timeEnd: end,
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        // Simulate a concurrent winner: another webhook claimed the candidate between our
        // findArray (which returns the still-naked snapshot) and our conditional updateOne (which
        // refuses to write because the link fields are now present). We model this by directly
        // poisoning the row in the DB so our conditional updateOne matches 0 docs.
        const realUpdateOne = itemsDAO.updateOne.bind(itemsDAO);
        vi.spyOn(itemsDAO, 'updateOne').mockImplementation(async (filter, update, options) => {
            // Trigger the race exactly once: when the relink's conditional updateOne runs (it has
            // the calendarEventId-$exists-false guard in the filter). Apply the rival's claim
            // first, then forward to the real updateOne — which now matches 0 docs.
            type FilterShape = { calendarEventId?: { $exists?: boolean } };
            const guard = (filter as FilterShape).calendarEventId;
            if (guard && guard.$exists === false) {
                await realUpdateOne(
                    { _id: 'item-naked-race', user: userId },
                    { $set: { calendarEventId: 'gcal-other-winner', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' } },
                );
            }
            return await realUpdateOne(filter, update, options);
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-race',
                    title: 'Race',
                    timeStart: start,
                    timeEnd: end,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const all = await itemsDAO.findArray({ user: userId, title: 'Race' });
        expect(all).toHaveLength(2);
        // Original candidate remains attached to the racing winner (we didn't clobber it).
        const racer = all.find((i) => i._id === 'item-naked-race');
        expect(racer?.calendarEventId).toBe('gcal-other-winner');
        // A fresh item was created for our event.
        const fresh = all.find((i) => i._id !== 'item-naked-race');
        expect(fresh?.calendarEventId).toBe('gcal-race');
    });

    it('relinks a naked active routine to the same GCal master event on reconnect', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        // Anchor the GCal event in Asia/Jerusalem (the sync config's tz) so `extractLocalTime`
        // produces '09:00' regardless of the machine's local tz — without `dayjs.tz` the timeOfDay
        // would shift by the host UTC offset and the naked match would silently miss on CI.
        const futureDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const futureStart = dayjs.tz(`${futureDate}T09:00:00`, 'Asia/Jerusalem').format();
        const futureEnd = dayjs.tz(`${futureDate}T09:30:00`, 'Asia/Jerusalem').format();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-naked',
                title: 'Standup',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
                updatedTs: oldTs,
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-standup-new',
                    title: 'Standup',
                    timeStart: futureStart,
                    timeEnd: futureEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const all = await routinesDAO.findArray({ user: userId, title: 'Standup' });
        expect(all).toHaveLength(1);
        expect(all[0]!._id).toBe('routine-naked');
        expect(all[0]!.calendarEventId).toBe('gcal-standup-new');
        expect(all[0]!.calendarIntegrationId).toBe('int-1');
        expect(all[0]!.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('reconnect sync is idempotent — running it twice does not create a second item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const start = dayjs().add(1, 'day').startOf('hour').toISOString();
        const end = dayjs(start).add(1, 'hour').toISOString();
        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-naked-idem',
            user: userId,
            status: 'calendar',
            title: 'Idem',
            timeStart: start,
            timeEnd: end,
            createdTs: oldTs,
            updatedTs: oldTs,
            lastSyncedFromGCalTs: oldTs,
        });

        const eventUpdated = dayjs().toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-idem',
                    title: 'Idem',
                    timeStart: start,
                    timeEnd: end,
                    updated: eventUpdated,
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });

        const all = await itemsDAO.findArray({ user: userId, title: 'Idem' });
        expect(all).toHaveLength(1);
        expect(all[0]!._id).toBe('item-naked-idem');
        expect(all[0]!.calendarEventId).toBe('gcal-idem');
    });
});

// ─── GoogleCalendarProvider token refresh callback ────────────────────────

describe('GoogleCalendarProvider token refresh callback', () => {
    // googleapis OAuth2 extends EventEmitter — cast to access emit() for testing.
    function getAuth(provider: GoogleCalendarProvider): { emit: (event: string, data: unknown) => boolean } {
        return (provider as unknown as { auth: { emit: (event: string, data: unknown) => boolean } }).auth;
    }

    it('calls onTokenRefresh when googleapis emits a tokens event', async () => {
        const onTokenRefresh = vi.fn().mockResolvedValue(undefined);
        const provider = new GoogleCalendarProvider(makeIntegration('user-1'), onTokenRefresh);
        const expiryMs = dayjs().add(1, 'hour').valueOf();

        getAuth(provider).emit('tokens', { access_token: 'new-at', refresh_token: 'new-rt', expiry_date: expiryMs });

        await vi.waitFor(() => expect(onTokenRefresh).toHaveBeenCalledOnce());
        expect(onTokenRefresh).toHaveBeenCalledWith('new-at', 'new-rt', dayjs(expiryMs).toISOString());
    });

    it('does not call onTokenRefresh when tokens event has no access_token', async () => {
        const onTokenRefresh = vi.fn();
        const provider = new GoogleCalendarProvider(makeIntegration('user-1'), onTokenRefresh);

        getAuth(provider).emit('tokens', { refresh_token: 'new-rt' });
        // Flush microtasks to ensure any async path would have resolved.
        await new Promise((r) => setTimeout(r, 0));

        expect(onTokenRefresh).not.toHaveBeenCalled();
    });

    it('carries the latest refresh token forward when a subsequent tokens event omits refresh_token', async () => {
        const onTokenRefresh = vi.fn().mockResolvedValue(undefined);
        const provider = new GoogleCalendarProvider(makeIntegration('user-1'), onTokenRefresh);
        const expiryMs = dayjs().add(1, 'hour').valueOf();

        getAuth(provider).emit('tokens', { access_token: 'at-1', refresh_token: 'rt-updated', expiry_date: expiryMs });
        getAuth(provider).emit('tokens', { access_token: 'at-2', expiry_date: expiryMs });

        await vi.waitFor(() => expect(onTokenRefresh).toHaveBeenCalledTimes(2));
        // Second call must use the refresh token received in the first event, not the stale original.
        expect(onTokenRefresh).toHaveBeenNthCalledWith(2, 'at-2', 'rt-updated', expect.any(String));
    });

    it('falls back to the previous tokenExpiry when tokens event omits expiry_date', async () => {
        const integration = makeIntegration('user-1');
        const onTokenRefresh = vi.fn().mockResolvedValue(undefined);
        const provider = new GoogleCalendarProvider(integration, onTokenRefresh);

        getAuth(provider).emit('tokens', { access_token: 'new-at' }); // no expiry_date

        await vi.waitFor(() => expect(onTokenRefresh).toHaveBeenCalledOnce());
        // Should fall back to the tokenExpiry captured at construction time.
        expect(onTokenRefresh).toHaveBeenCalledWith('new-at', integration.refreshToken, integration.tokenExpiry);
    });

    it('does not attach a tokens listener when no callback is provided', () => {
        const provider = new GoogleCalendarProvider(makeIntegration('user-1'));
        // Emitting should not throw even with no listener registered.
        expect(() => getAuth(provider).emit('tokens', { access_token: 'at' })).not.toThrow();
    });
});

// Regression: post-fix, stored `calendarEventId` is always the bare master id, but GCal may still
// emit instances whose `recurringEventId` carries the `_R<YYYYMMDDTHHmmss>` rebased-master suffix.
// `getExceptions` filters instances by `recurringEventId !== eventId`; without normalization on
// both sides, every exception is silently dropped → modified/deleted GCal instances never reach
// the items table. This test pins the contract by running `getExceptions` end-to-end against a
// mocked `cal.events.list` and asserting the mismatched-form pair is treated as the same series.
describe('GoogleCalendarProvider.getExceptions — rebased-master id normalization', () => {
    it('matches an instance whose recurringEventId carries the _R<…> suffix against a bare master eventId', async () => {
        const bareMasterId = 'mleem99efhim4a0tsh3s86797o';
        const suffixedMasterId = `${bareMasterId}_R20260519T123000`;
        // Spy on the prototype so `getExceptions`'s internal `cal.events.list` call hits our mock.
        const eventsProto = Object.getPrototypeOf(google.calendar({ version: 'v3' }).events) as Record<string, unknown>;
        type ListCall = (params: unknown) => Promise<{ data: { items?: unknown[] } }>;
        const listSpy = vi.spyOn(eventsProto, 'list' as keyof typeof eventsProto) as unknown as ReturnType<typeof vi.fn<ListCall>>;
        listSpy.mockResolvedValue({
            data: {
                items: [
                    {
                        id: `${bareMasterId}_20260526T123000Z`,
                        recurringEventId: suffixedMasterId,
                        originalStartTime: { dateTime: '2026-05-26T12:30:00Z' },
                        status: 'cancelled',
                    },
                ],
            },
        });

        const provider = new GoogleCalendarProvider(makeIntegration('user-1'));
        const exceptions = await provider.getExceptions(bareMasterId, 'cal-1', '2026-01-01T00:00:00Z');

        // Pre-fix this would be `[]` (silent drop). Post-fix, the deleted instance surfaces as
        // a `type: 'deleted'` exception with the inbound googleEventId.
        expect(exceptions).toHaveLength(1);
        const [ex] = exceptions;
        if (!ex) throw new Error('expected one exception');
        expect(ex.type).toBe('deleted');
        expect(ex.originalDate).toBe('2026-05-26');
    });

    it('still matches when both sides are bare master ids — guards against a future regex tweak silently breaking the common case', async () => {
        const bareMasterId = 'bare-no-suffix-anywhere';
        const eventsProto = Object.getPrototypeOf(google.calendar({ version: 'v3' }).events) as Record<string, unknown>;
        type ListCall = (params: unknown) => Promise<{ data: { items?: unknown[] } }>;
        const listSpy = vi.spyOn(eventsProto, 'list' as keyof typeof eventsProto) as unknown as ReturnType<typeof vi.fn<ListCall>>;
        listSpy.mockResolvedValue({
            data: {
                items: [
                    {
                        id: `${bareMasterId}_20260526T123000Z`,
                        recurringEventId: bareMasterId,
                        originalStartTime: { dateTime: '2026-05-26T12:30:00Z' },
                        status: 'cancelled',
                    },
                ],
            },
        });

        const provider = new GoogleCalendarProvider(makeIntegration('user-1'));
        const exceptions = await provider.getExceptions(bareMasterId, 'cal-1', '2026-01-01T00:00:00Z');
        expect(exceptions).toHaveLength(1);
    });
});

// Belt-and-suspenders for the past-cutoff fix: the provider also clamps `timeMin` so a fresh
// reconnect with `since` defaulted to epoch doesn't drag back every modified instance since 1970.
// The consumer-side guard in `applyExceptionToItems` would still catch ancient orphans, but the
// clamp keeps the GCal API payload bounded.
describe('GoogleCalendarProvider.getExceptions — timeMin clamping', () => {
    function spyOnEventsList() {
        const eventsProto = Object.getPrototypeOf(google.calendar({ version: 'v3' }).events) as Record<string, unknown>;
        type ListCall = (params: unknown) => Promise<{ data: { items?: unknown[] } }>;
        const listSpy = vi.spyOn(eventsProto, 'list' as keyof typeof eventsProto) as unknown as ReturnType<typeof vi.fn<ListCall>>;
        listSpy.mockResolvedValue({ data: { items: [] } });
        return listSpy;
    }

    it('clamps `since = epoch` up to ~30 days before now (fresh reconnect path)', async () => {
        const listSpy = spyOnEventsList();
        const provider = new GoogleCalendarProvider(makeIntegration('user-1'));
        await provider.getExceptions('master-1', 'cal-1', dayjs(0).toISOString());

        expect(listSpy).toHaveBeenCalledTimes(1);
        const callArg = listSpy.mock.calls[0]?.[0] as { timeMin: string };
        const expectedFloor = dayjs().subtract(30, 'day');
        // Within a couple seconds tolerance to absorb test runtime between the call and our assertion.
        expect(dayjs(callArg.timeMin).diff(expectedFloor, 'second')).toBeGreaterThanOrEqual(-2);
        expect(dayjs(callArg.timeMin).diff(expectedFloor, 'second')).toBeLessThanOrEqual(2);
    });

    it('preserves a recent `since` (within the 30-day window) — no clamping', async () => {
        const listSpy = spyOnEventsList();
        const provider = new GoogleCalendarProvider(makeIntegration('user-1'));
        const recent = dayjs().subtract(7, 'day').toISOString();
        await provider.getExceptions('master-1', 'cal-1', recent);

        const callArg = listSpy.mock.calls[0]?.[0] as { timeMin: string };
        expect(callArg.timeMin).toBe(recent);
    });

    it('clamps a `since` just past the 30-day floor — guards against off-by-one regressions in the comparison direction', async () => {
        const listSpy = spyOnEventsList();
        const provider = new GoogleCalendarProvider(makeIntegration('user-1'));
        const justOverFloor = dayjs().subtract(31, 'day').toISOString();
        await provider.getExceptions('master-1', 'cal-1', justOverFloor);

        const callArg = listSpy.mock.calls[0]?.[0] as { timeMin: string };
        expect(callArg.timeMin).not.toBe(justOverFloor);
        const expectedFloor = dayjs().subtract(30, 'day');
        expect(Math.abs(dayjs(callArg.timeMin).diff(expectedFloor, 'second'))).toBeLessThanOrEqual(2);
    });
});

// ─── updateTokens ──────────────────────────────────────────────────────────

describe('calendarIntegrationsDAO.updateTokens', () => {
    it('persists encrypted tokens when the integration exists', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        await calendarIntegrationsDAO.updateTokens({
            id: 'int-1',
            userId,
            accessToken: 'new-at',
            refreshToken: 'new-rt',
            tokenExpiry: dayjs().add(1, 'hour').toISOString(),
        });

        const updated = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted('int-1', userId);
        expect(updated?.accessToken).toBe('new-at');
        expect(updated?.refreshToken).toBe('new-rt');
    });

    it('logs a warning when no integration matches the given id/userId', async () => {
        const warnSpy = vi.spyOn(console, 'warn');
        await calendarIntegrationsDAO.updateTokens({
            id: 'nonexistent',
            userId: 'user-x',
            accessToken: 'at',
            refreshToken: 'rt',
            tokenExpiry: dayjs().toISOString(),
        });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no integration matched'));
    });
});

// ─── upsertEncrypted (reconnect) ───────────────────────────────────────────

describe('calendarIntegrationsDAO.upsertEncrypted', () => {
    it('preserves createdTs on reconnect (second upsert)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const firstNow = dayjs().subtract(1, 'day').toISOString();

        await calendarIntegrationsDAO.upsertEncrypted(makeIntegration(userId, { createdTs: firstNow, updatedTs: firstNow }));

        const laterNow = dayjs().toISOString();
        // Simulate reconnect: same user+provider, new tokens, new timestamps.
        await calendarIntegrationsDAO.upsertEncrypted(makeIntegration(userId, { _id: 'int-new', createdTs: laterNow, updatedTs: laterNow }));

        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        expect(integrations).toHaveLength(1);
        // createdTs must remain the original value — not overwritten by the reconnect.
        expect(integrations[0]!.createdTs).toBe(firstNow);
        // updatedTs should reflect the reconnect.
        expect(integrations[0]!.updatedTs).toBe(laterNow);
    });

    it('returns the persisted _id — the new id on insert, the surviving id on reconnect', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        // First connect: inserts, so the returned id is the one we supplied.
        const insertedId = await calendarIntegrationsDAO.upsertEncrypted(makeIntegration(userId, { _id: 'int-first' }));
        expect(insertedId).toBe('int-first');

        // Reconnect supplies a fresh phantom id, but the (user, provider) row already exists, so the
        // upsert keeps the original _id — and upsertEncrypted must hand that surviving id back, not the
        // phantom. This is what lets the OAuth callback redirect with an id the client can actually use.
        const reconnectId = await calendarIntegrationsDAO.upsertEncrypted(makeIntegration(userId, { _id: 'int-phantom' }));
        expect(reconnectId).toBe('int-first');

        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        expect(integrations).toHaveLength(1);
        const [persisted] = integrations;
        if (!persisted) throw new Error('expected one integration');
        expect(persisted._id).toBe('int-first');
    });
});

// ─── Webhook receiver ──────────────────────────────────────────────────────

describe('POST /calendar/webhooks/google', () => {
    it('returns 400 when required headers are missing', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/calendar/webhooks/google', { method: 'POST' }));
        expect(res.status).toBe(400);
    });

    it('returns 200 on sync handshake (resource-state: sync)', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/calendar/webhooks/google', {
                method: 'POST',
                headers: { 'x-goog-channel-id': 'ch-1', 'x-goog-resource-id': 'res-1', 'x-goog-resource-state': 'sync' },
            }),
        );
        expect(res.status).toBe(200);
    });

    it('returns 404 for unknown channel ID', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/calendar/webhooks/google', {
                method: 'POST',
                headers: { 'x-goog-channel-id': 'unknown', 'x-goog-resource-id': 'res-1', 'x-goog-resource-state': 'exists' },
            }),
        );
        expect(res.status).toBe(404);
    });

    it('returns 404 when resourceId does not match', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-99', 'res-correct', dayjs().add(7, 'day').toISOString());

        const res = await app.fetch(
            new Request('http://localhost:4000/calendar/webhooks/google', {
                method: 'POST',
                headers: { 'x-goog-channel-id': 'ch-99', 'x-goog-resource-id': 'res-wrong', 'x-goog-resource-state': 'exists' },
            }),
        );
        expect(res.status).toBe(404);
    });

    it('triggers sync and returns 200 for a valid notification', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-valid', 'res-valid', dayjs().add(7, 'day').toISOString());

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-wh' });

        const res = await app.fetch(
            new Request('http://localhost:4000/calendar/webhooks/google', {
                method: 'POST',
                headers: { 'x-goog-channel-id': 'ch-valid', 'x-goog-resource-id': 'res-valid', 'x-goog-resource-state': 'exists' },
            }),
        );
        expect(res.status).toBe(200);

        // Give the fire-and-forget sync a moment to complete.
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify the syncToken was persisted by the webhook-triggered sync.
        const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
        expect(config!.syncToken).toBe('tok-wh');
    });

    it('releases the channel lock when the sync throws, so the next webhook is not coalesced forever', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-throw', 'res-throw', dayjs().add(7, 'day').toISOString());

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        // First webhook delivery: listEventsFull throws — this used to leak the in-memory channel lock
        // (channelStates stuck at 'running'), permanently jamming the channel until process restart.
        const listEventsSpy = vi
            .spyOn(GoogleCalendarProvider.prototype, 'listEventsFull')
            .mockRejectedValueOnce(new Error('boom — simulated MongoDB E11000 inside sync'))
            .mockResolvedValueOnce({ events: [], nextSyncToken: 'tok-after-throw' });

        const makeWebhookRequest = () =>
            app.fetch(
                new Request('http://localhost:4000/calendar/webhooks/google', {
                    method: 'POST',
                    headers: { 'x-goog-channel-id': 'ch-throw', 'x-goog-resource-id': 'res-throw', 'x-goog-resource-state': 'exists' },
                }),
            );

        const res1 = await makeWebhookRequest();
        expect(res1.status).toBe(200);

        // Wait for the first (throwing) sync to settle and release the lock.
        await new Promise((resolve) => setTimeout(resolve, 100));

        const res2 = await makeWebhookRequest();
        expect(res2.status).toBe(200);

        // Wait for the second sync to complete.
        await new Promise((resolve) => setTimeout(resolve, 200));

        // The second webhook must have started a fresh sync (not been coalesced) — proving the lock was
        // released even though the first sync threw. Both calls land on listEventsFull.
        expect(listEventsSpy).toHaveBeenCalledTimes(2);

        // And the second sync's syncToken was persisted, confirming end-to-end recovery.
        const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
        expect(config!.syncToken).toBe('tok-after-throw');
    });

    it('releases the channel lock even when a delivery was queued during the throwing sync', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-throw-q', 'res-throw-q', dayjs().add(7, 'day').toISOString());

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        // First listEventsFull: slow + throws. The second webhook arrives while this one is in flight,
        // so the lock transitions running → queued before the throw. Naive cleanup (finishWebhookSync
        // in the catch) would leave state at 'running' with no runner, jamming the channel until a
        // second post-error delivery arrives. delete()-based cleanup recovers on the very next delivery.
        const listEventsSpy = vi
            .spyOn(GoogleCalendarProvider.prototype, 'listEventsFull')
            .mockImplementationOnce(async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
                throw new Error('boom — simulated MongoDB E11000 inside sync');
            })
            .mockResolvedValueOnce({ events: [], nextSyncToken: 'tok-after-throw-q' });

        const makeWebhookRequest = () =>
            app.fetch(
                new Request('http://localhost:4000/calendar/webhooks/google', {
                    method: 'POST',
                    headers: { 'x-goog-channel-id': 'ch-throw-q', 'x-goog-resource-id': 'res-throw-q', 'x-goog-resource-state': 'exists' },
                }),
            );

        // Fire deliveries 1 and 2 back-to-back so #2 arrives while #1's sync is still running.
        const res1 = await makeWebhookRequest();
        const res2 = await makeWebhookRequest();
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);

        // Wait for the first (throwing) sync to settle and clear the lock.
        await new Promise((resolve) => setTimeout(resolve, 250));

        // Now fire delivery 3 — it must start a fresh sync, not be coalesced into a phantom queue.
        const res3 = await makeWebhookRequest();
        expect(res3.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Two spy calls: the throwing one (delivery 1) and the recovery one (delivery 3). Delivery 2
        // is correctly dropped — its queued re-run never runs because we don't drain queues on error.
        expect(listEventsSpy).toHaveBeenCalledTimes(2);

        // Delivery 3 persisted its syncToken — end-to-end recovery confirmed.
        const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
        expect(config!.syncToken).toBe('tok-after-throw-q');
    });

    it('coalesces concurrent notifications into one in-flight sync plus one queued re-run', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-coalesce', 'res-coalesce', dayjs().add(7, 'day').toISOString());

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        // Make listEventsFull slow enough that the second webhook arrives while the first sync is still running.
        const listEventsSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { events: [], nextSyncToken: 'tok-coalesce' };
        });

        const makeWebhookRequest = () =>
            app.fetch(
                new Request('http://localhost:4000/calendar/webhooks/google', {
                    method: 'POST',
                    headers: { 'x-goog-channel-id': 'ch-coalesce', 'x-goog-resource-id': 'res-coalesce', 'x-goog-resource-state': 'exists' },
                }),
            );

        // Three rapid-fire deliveries: the first starts a sync, the next two coalesce into one queued re-run.
        const res1 = await makeWebhookRequest();
        const res2 = await makeWebhookRequest();
        const res3 = await makeWebhookRequest();
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(res3.status).toBe(200);

        // Wait long enough for both the in-flight sync and the queued re-run to complete (50ms each + buffer).
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Two syncs total: the immediate one and one coalesced re-run covering deliveries 2 and 3.
        expect(listEventsSpy).toHaveBeenCalledTimes(2);
    });
});

// ─── Webhook renewal ───────────────────────────────────────────────────────

describe('POST /calendar/webhooks/renew', () => {
    it('returns 401 without the cron secret', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/calendar/webhooks/renew', { method: 'POST' }));
        expect(res.status).toBe(401);
    });

    it('returns 401 with wrong cron secret', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/calendar/webhooks/renew', {
                method: 'POST',
                headers: { 'x-webhook-cron-secret': 'wrong-secret' },
            }),
        );
        expect(res.status).toBe(401);
    });

    it('renews expiring webhook channels', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Set webhook fields with an expiry within the 1-day renewal horizon.
        const soonExpiry = dayjs().add(6, 'hour').toISOString();
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-old', 'res-old', soonExpiry);

        vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-new',
            expiration: dayjs().add(7, 'day').toISOString(),
        });

        const secret = 'test-cron-secret';
        process.env.CALENDAR_WEBHOOK_CRON_SECRET = secret;
        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';

        try {
            const res = await app.fetch(
                new Request('http://localhost:4000/calendar/webhooks/renew', {
                    method: 'POST',
                    headers: { 'x-webhook-cron-secret': secret },
                }),
            );
            expect(res.status).toBe(200);
            const body = (await res.json()) as { renewed: number; failed: number };
            expect(body.renewed).toBe(1);
            expect(body.failed).toBe(0);

            // Verify the new webhook fields were persisted.
            const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
            expect(config!.webhookResourceId).toBe('res-new');
        } finally {
            delete process.env.CALENDAR_WEBHOOK_CRON_SECRET;
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });
});

// ─── Watch setup/teardown on sync config CRUD ──────────────────────────────

describe('webhook watch lifecycle', () => {
    it('sets up a watch when creating a sync config', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const integration = makeIntegration(userId);
        await calendarIntegrationsDAO.insertEncrypted(integration);
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id));

        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-created',
            expiration: dayjs().add(7, 'day').toISOString(),
        });

        try {
            const res = await authenticatedRequest(app, {
                method: 'POST',
                path: '/calendar/integrations/int-1/sync-configs',
                sessionCookie,
                body: { calendarId: 'work' },
            });
            expect(res.status).toBe(201);
            expect(watchSpy).toHaveBeenCalledOnce();
        } finally {
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });

    it('tears down watch when deleting a sync config', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-del', 'res-del', dayjs().add(7, 'day').toISOString());

        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
            sessionCookie,
        });
        expect(res.status).toBe(200);
        expect(stopSpy).toHaveBeenCalledWith('ch-del', 'res-del');
    });

    it('tears down watch when disabling a sync config', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-dis', 'res-dis', dayjs().add(7, 'day').toISOString());

        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
            sessionCookie,
            body: { enabled: false },
        });
        expect(res.status).toBe(200);
        expect(stopSpy).toHaveBeenCalledWith('ch-dis', 'res-dis');
    });

    it('renews expired webhook during manual sync', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Set webhook as expired (in the past).
        const expiredExpiry = dayjs().subtract(1, 'hour').toISOString();
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-expired', 'res-expired', expiredExpiry);

        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';
        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-renewed',
            expiration: dayjs().add(7, 'day').toISOString(),
        });
        // setupWatch now stops the stale channel itself, so renew no longer tears down (which would
        // clear the fields) before re-registering — pin that "one fewer DB write" simplification.
        const clearSpy = vi.spyOn(calendarSyncConfigsDAO, 'clearWebhookFields');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok' });

        try {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            // Old channel should be stopped and new one created — without clearing fields mid-renew.
            expect(stopSpy).toHaveBeenCalledWith('ch-expired', 'res-expired');
            expect(watchSpy).toHaveBeenCalledOnce();
            expect(clearSpy).not.toHaveBeenCalled();
            const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
            expect(config?.webhookResourceId).toBe('res-renewed');
        } finally {
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });

    it('sets up webhook during manual sync when config has no webhook fields', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Config has no webhook fields at all — simulates initial setup or cleared state.

        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';
        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-fresh',
            expiration: dayjs().add(7, 'day').toISOString(),
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok' });

        try {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            // Should set up without tearing down (no existing channel).
            expect(stopSpy).not.toHaveBeenCalled();
            expect(watchSpy).toHaveBeenCalledOnce();
            const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
            expect(config!.webhookResourceId).toBe('res-fresh');
        } finally {
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });

    it('skips webhook renewal when not expiring', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Set webhook with a far-future expiry.
        const farExpiry = dayjs().add(6, 'day').toISOString();
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-ok', 'res-ok', farExpiry);

        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';
        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-new',
            expiration: dayjs().add(7, 'day').toISOString(),
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok' });

        try {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            // Webhook is still valid — no renewal should happen.
            expect(stopSpy).not.toHaveBeenCalled();
            expect(watchSpy).not.toHaveBeenCalled();
        } finally {
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });

    it('sets up watch when re-enabling a sync config', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Start with config disabled.
        await calendarSyncConfigsDAO.updateOne({ _id: 'sync-config-1' } as never, { $set: { enabled: false } });

        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-reenable',
            expiration: dayjs().add(7, 'day').toISOString(),
        });

        try {
            const res = await authenticatedRequest(app, {
                method: 'PATCH',
                path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
                sessionCookie,
                body: { enabled: true },
            });
            expect(res.status).toBe(200);
            expect(watchSpy).toHaveBeenCalledOnce();
        } finally {
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });

    it('stops a stale channel before re-registering when a re-enabled config still carries webhook fields', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Disabled config that STILL carries webhook fields from a prior enable cycle (or a config
        // row that survived a disconnect+reconnect). Pre-fix, re-enabling minted a fresh channel
        // and left 'ch-stale' live on Google → an orphan that kept firing (the storm's leak).
        await calendarSyncConfigsDAO.updateOne({ _id: 'sync-config-1' } as never, { $set: { enabled: false } });
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-stale', 'res-stale', dayjs().add(7, 'day').toISOString());

        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';
        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-fresh',
            expiration: dayjs().add(7, 'day').toISOString(),
        });

        try {
            const res = await authenticatedRequest(app, {
                method: 'PATCH',
                path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
                sessionCookie,
                body: { enabled: true },
            });
            expect(res.status).toBe(200);
            // The stale channel must be stopped on Google's side before the new one is registered.
            expect(stopSpy).toHaveBeenCalledWith('ch-stale', 'res-stale');
            expect(watchSpy).toHaveBeenCalledOnce();
            const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
            expect(config?.webhookChannelId).not.toBe('ch-stale');
            expect(config?.webhookResourceId).toBe('res-fresh');
        } finally {
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });

    it('tears down all watches when deleting an integration', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-int-del', 'res-int-del', dayjs().add(7, 'day').toISOString());

        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1',
            sessionCookie,
        });
        expect(res.status).toBe(200);
        expect(stopSpy).toHaveBeenCalledWith('ch-int-del', 'res-int-del');
    });
});

// ─── Calendar push-back ────────────────────────────────────────────────────

function mockBuildProvider(): (integration: CalendarIntegrationInterface, userId: string) => GoogleCalendarProvider {
    // Return a typed mock factory — the actual provider methods are spied on via prototype.
    return (integration, _userId) => new GoogleCalendarProvider(integration);
}

function makeOp(userId: string, overrides: Partial<OperationInterface>): OperationInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'op-1',
        user: userId,
        deviceId: 'device-1',
        ts: now,
        entityType: 'item',
        entityId: 'item-1',
        opType: 'update',
        snapshot: null,
        ...overrides,
    };
}

function makeItem(userId: string, overrides: Partial<ItemInterface> = {}): ItemInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'item-push-1',
        user: userId,
        status: 'calendar',
        title: 'Meeting',
        timeStart: dayjs().add(1, 'day').toISOString(),
        timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

describe('calendar push-back — existing items', () => {
    it('deletes GCal event when item is trashed', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-ev-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);
        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(deleteSpy).toHaveBeenCalledWith('primary', 'gcal-ev-1');
        // Trash branch must not also fall through to updateEvent — splitting the prior trash||done
        // branch must keep these mutually exclusive.
        expect(updateSpy).not.toHaveBeenCalled();
        // Verify lastPushedToGCalTs was stamped.
        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('updates GCal event when item title/time changes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-ev-2',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            title: 'Updated Meeting',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        expect(updateSpy.mock.calls[0]![1]).toBe('gcal-ev-2');
    });

    it('marks GCal event with "✓ " prefix and sage colorId when item is done (does not delete)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-ev-done',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            title: 'Verify done sync',
            status: 'done',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);
        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(deleteSpy).not.toHaveBeenCalled();
        expect(updateSpy).toHaveBeenCalledOnce();
        const [calendarId, eventId, updates] = updateSpy.mock.calls[0]!;
        expect(calendarId).toBe('primary');
        expect(eventId).toBe('gcal-ev-done');
        expect(updates).toMatchObject({ title: '✓ Verify done sync', colorId: '2' });

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        // Stored title stays clean — marker lives only in GCal.
        expect(updated!.title).toBe('Verify done sync');
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('clears done marker (clean title + colorId: null) when item is reopened to calendar', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-ev-reopen',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            title: 'Verify done sync',
            status: 'calendar',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        const updates = updateSpy.mock.calls[0]![2];
        expect(updates).toMatchObject({ title: 'Verify done sync', colorId: null });
    });
});

describe('calendar push-back — new items', () => {
    it('creates GCal event for app-created calendar item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId);
        await itemsDAO.insertOne(item);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'new-gcal-id' });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(createSpy).toHaveBeenCalledOnce();
        // Verify the item was linked to the new GCal event.
        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.calendarEventId).toBe('new-gcal-id');
        expect(updated!.calendarIntegrationId).toBe('int-1');
        expect(updated!.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('skips items without timeStart/timeEnd', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { timeStart: undefined, timeEnd: undefined });

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'new-id' });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips item creation when DB already has calendarEventId (concurrent push-back guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Snapshot passed in the op lacks calendarEventId (captured at queue-time).
        const snapshotWithoutLink = makeItem(userId);

        // But the DB record already has it — a concurrent push-back linked it first.
        const itemInDb = makeItem(userId, {
            calendarEventId: 'already-linked',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await itemsDAO.insertOne(itemInDb);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'duplicate-id' });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: snapshotWithoutLink._id!, snapshot: snapshotWithoutLink }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });

    it('does not use the single-event create path for routine-managed calendar items', async () => {
        // Routine-managed items don't get their own GCal event — they're represented by the routine's
        // master recurring event, with per-instance overrides when edited.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { routineId: 'routine-1' });

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'new-id' });
        // Without a routine in the DB, pushRoutineInstanceOverride also no-ops — so neither
        // path touches GCal. Both are exclusive: createEvent is not called, and the override
        // path exits early because the routine can't be resolved.

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });
});

describe('calendar push-back — routine instance overrides', () => {
    async function setupRoutineWithEvent(userId: string, routineOverrides: Partial<RoutineInterface> = {}) {
        const routine = makeRoutine(userId, {
            calendarEventId: 'recurring-master-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            ...routineOverrides,
        });
        await routinesDAO.insertOne(routine);
        return routine;
    }

    it('pushes a single-instance override when a routine-generated item is edited', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-inst-1',
            routineId: 'routine-1',
            title: 'Moved standup',
            timeStart: '2026-05-04T11:00:00.000Z',
            timeEnd: '2026-05-04T11:30:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const spy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]![0]).toBe('recurring-master-1');
        expect(spy.mock.calls[0]![1]).toBe('2026-05-04'); // originalDate derived from timeStart
        expect(spy.mock.calls[0]![2]).toMatchObject({ title: 'Moved standup', timeStart: '2026-05-04T11:00:00.000Z', timeEnd: '2026-05-04T11:30:00.000Z' });
        expect(spy.mock.calls[0]![3]).toBe('primary'); // calendarId
        expect(spy.mock.calls[0]![4]).toBe('Asia/Jerusalem'); // timeZone

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('uses the routine exception date as originalDate when the item was previously moved', async () => {
        // Regression: on a subsequent edit, snapshot.timeStart is the MOVED date. The rrule
        // occurrence date lives only on the routine's `modified` exception. Look it up.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId, {
            routineExceptions: [
                {
                    date: '2026-05-04', // original rrule date
                    type: 'modified' as const,
                    itemId: 'item-inst-2',
                    newTimeStart: '2026-05-05T09:00:00.000Z',
                    newTimeEnd: '2026-05-05T09:30:00.000Z',
                },
            ],
        });

        const item = makeItem(userId, {
            _id: 'item-inst-2',
            routineId: 'routine-1',
            title: 'Re-edited',
            // This is the MOVED date from the prior edit — NOT the original rrule date.
            timeStart: '2026-05-05T09:00:00.000Z',
            timeEnd: '2026-05-05T09:30:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const spy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]![1]).toBe('2026-05-04'); // original rrule date recovered from exception
    });

    it('no-ops when the routine is not linked to a GCal recurring event', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Routine exists but has no calendarEventId — can't push an override.
        const unlinkedRoutine = makeRoutine(userId, { _id: 'routine-unlinked' });
        await routinesDAO.insertOne(unlinkedRoutine);

        const item = makeItem(userId, {
            _id: 'item-no-link',
            routineId: 'routine-unlinked',
        });
        await itemsDAO.insertOne(item);

        const spy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(spy).not.toHaveBeenCalled();
    });

    it('no-ops when the routine cannot be found (orphaned routineId)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // No routine inserted.

        const item = makeItem(userId, {
            _id: 'item-orphan',
            routineId: 'routine-missing',
        });
        await itemsDAO.insertOne(item);

        const spy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(spy).not.toHaveBeenCalled();
    });

    it('no-ops when the snapshot has no timeStart', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        // Items without timeStart can't have a rrule date — skip gracefully.
        const item = makeItem(userId, { _id: 'item-no-ts', routineId: 'routine-1', timeStart: undefined, timeEnd: undefined });

        const spy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(spy).not.toHaveBeenCalled();
    });

    it('cancels the GCal instance when a routine-generated item is trashed (skipped exception)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-trash-1',
            routineId: 'routine-1',
            status: 'trash',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);
        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).toHaveBeenCalledOnce();
        // 4th arg is the instance-id option (undefined here — legacy item without calendarInstanceEventId).
        expect(cancelSpy).toHaveBeenCalledWith('recurring-master-1', '2026-04-27', 'primary', undefined);
        expect(updateSpy).not.toHaveBeenCalled();

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('marks the GCal instance with ✓ prefix and sage colorId when a routine-generated item is done (does not cancel)', async () => {
        // Matrix A8: completion is GTD-local — the GCal occurrence must remain so other calendars
        // / attendees still see the event. Cancelling on done would also round-trip a `deleted`
        // exception back via GCal sync and flip the app-side item from `done` to `trash`. Instead,
        // a single-instance override applies the ✓ title prefix + sage colorId to that occurrence.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-done-1',
            routineId: 'routine-1',
            status: 'done',
            title: 'Standup',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);
        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).not.toHaveBeenCalled();
        expect(updateSpy).toHaveBeenCalledOnce();
        expect(updateSpy.mock.calls[0]![0]).toBe('recurring-master-1');
        expect(updateSpy.mock.calls[0]![1]).toBe('2026-04-27');
        expect(updateSpy.mock.calls[0]![2]).toMatchObject({ title: '✓ Standup', colorId: '2' });

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        // Stored title stays clean — marker lives only in GCal.
        expect(updated!.title).toBe('Standup');
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('patches the known calendarInstanceEventId directly on done, without an events.instances lookup', async () => {
        // Regression: routine-generated `done` markers never reached GCal because the override path
        // re-resolved the instance via a date-window events.instances query, which silently misses
        // already-modified instances (the prod failure on item 9a19f9ab…). When the item carries
        // its `calendarInstanceEventId` — exactly what GCal returns as event.id for the instance —
        // we must patch that id directly and skip the lookup. Drives the REAL updateRecurringInstance
        // (only events.instances/patch are stubbed) so the resolution path is exercised, not mocked.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-done-cieid',
            routineId: 'routine-1',
            status: 'done',
            title: 'Standup',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
            calendarInstanceEventId: 'recurring-master-1_20260427T060000Z',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy, instancesSpy } = spyOnGCalEventsApi();
        // Simulate the prod failure: the date-window lookup returns NO matching instance. With the fix
        // the patch must still land, because resolution comes from calendarInstanceEventId, not this call.
        instancesSpy.mockResolvedValue({ data: { items: [] } });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(instancesSpy).not.toHaveBeenCalled();
        const params = getPatchRequestBody(patchSpy);
        expect((params as { eventId?: string }).eventId).toBe('recurring-master-1_20260427T060000Z');
        expect(params.requestBody).toMatchObject({ summary: '✓ Standup', colorId: '2' });
    });

    it('swallows a 404 (drifted instance id) as a skip rather than throwing', async () => {
        // A caller-supplied instanceEventId can drift from what GCal actually materialized (tz /
        // timeOfDay reconstruction). The patch then 404s — we want the same warn-and-skip as a missed
        // findInstanceId lookup, not a raw error bubbling up through the fire-and-forget pushback caller.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-done-404',
            routineId: 'routine-1',
            status: 'done',
            title: 'Standup',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
            calendarInstanceEventId: 'recurring-master-1_20260427T060000Z',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();
        const notFound = Object.assign(new Error('Not Found'), { code: 404 });
        patchSpy.mockRejectedValue(notFound);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // maybePushToGCal must resolve (not reject) — the 404 is swallowed inside the provider.
        await expect(
            maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider()),
        ).resolves.toBeUndefined();
        expect(patchSpy).toHaveBeenCalledOnce();
        // Log parity: the drift case warns just like a missed findInstanceId lookup.
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no longer exists (404) — skipping'));
    });

    it('patches the known calendarInstanceEventId directly on trash (cancellation), without an events.instances lookup', async () => {
        // Symmetric to the done case: single-instance trash cancels via the known instance id when
        // present, so a previously-moved instance still cancels the correct occurrence.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-trash-cieid',
            routineId: 'routine-1',
            status: 'trash',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
            calendarInstanceEventId: 'recurring-master-1_20260427T060000Z',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy, instancesSpy } = spyOnGCalEventsApi();
        instancesSpy.mockResolvedValue({ data: { items: [] } });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(instancesSpy).not.toHaveBeenCalled();
        const params = getPatchRequestBody(patchSpy);
        expect((params as { eventId?: string }).eventId).toBe('recurring-master-1_20260427T060000Z');
        expect(params.requestBody).toMatchObject({ status: 'cancelled' });
    });

    it('falls back to the events.instances lookup when a legacy item has no calendarInstanceEventId', async () => {
        // Items generated before calendarInstanceEventId existed must still resolve via the date window.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-done-legacy',
            routineId: 'routine-1',
            status: 'done',
            title: 'Standup',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
            // no calendarInstanceEventId
        });
        await itemsDAO.insertOne(item);

        const { patchSpy, instancesSpy } = spyOnGCalEventsApi();
        instancesSpy.mockResolvedValue({
            data: { items: [{ id: 'resolved-by-date', originalStartTime: { dateTime: '2026-04-27T09:00:00.000Z' } }] },
        });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(instancesSpy).toHaveBeenCalledOnce();
        const params = getPatchRequestBody(patchSpy);
        expect((params as { eventId?: string }).eventId).toBe('resolved-by-date');
    });

    it('clears the done marker on the GCal instance when a routine-generated item is reopened to calendar', async () => {
        // Reopen path: status flips back to 'calendar'. The single-instance override must send
        // the clean title and colorId: null so the instance reverts to the master's defaults.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-reopen-1',
            routineId: 'routine-1',
            status: 'calendar',
            title: 'Standup',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        expect(updateSpy.mock.calls[0]![2]).toMatchObject({ title: 'Standup', colorId: null });
    });

    it('uses the prior modified exception date when trashing a previously-moved instance', async () => {
        // Edit-then-trash: snapshot.timeStart is the MOVED date, but the rrule's originalDate
        // lives only on the routine's `modified` exception. The cancellation must target the
        // original rrule date, not the moved one.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId, {
            routineExceptions: [
                {
                    date: '2026-04-27', // original rrule date
                    type: 'modified' as const,
                    itemId: 'item-trash-moved',
                    newTimeStart: '2026-04-28T09:00:00.000Z',
                    newTimeEnd: '2026-04-28T10:00:00.000Z',
                },
            ],
        });

        const item = makeItem(userId, {
            _id: 'item-trash-moved',
            routineId: 'routine-1',
            status: 'trash',
            // Moved date — NOT the original rrule date.
            timeStart: '2026-04-28T09:00:00.000Z',
            timeEnd: '2026-04-28T10:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).toHaveBeenCalledOnce();
        expect(cancelSpy.mock.calls[0]![1]).toBe('2026-04-27'); // original rrule date, recovered from modified exception
    });

    it('no-ops cancellation when the routine is not linked to a GCal recurring event', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const unlinkedRoutine = makeRoutine(userId, { _id: 'routine-unlinked-cancel' });
        await routinesDAO.insertOne(unlinkedRoutine);

        const item = makeItem(userId, {
            _id: 'item-trash-no-link',
            routineId: 'routine-unlinked-cancel',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('no-ops cancellation when routineId is orphaned (routine missing from DB)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-trash-orphan',
            routineId: 'routine-missing',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('no-ops cancellation when the snapshot has no timeStart', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        // Without timeStart the helper can't derive an original rrule date — skip gracefully.
        const item = makeItem(userId, {
            _id: 'item-trash-no-ts',
            routineId: 'routine-1',
            status: 'trash',
            timeStart: undefined,
            timeEnd: undefined,
        });

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('skips per-instance override for a fromGmail routine-generated item', async () => {
        // Defensive: routine masters from Gmail don't exist in practice, but if eventType ever
        // mirrors through the GCal-owned routine keys, we don't want a 400 from GCal.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-inst-fromgmail',
            routineId: 'routine-1',
            title: 'Gmail mirror instance',
            timeStart: '2026-05-04T11:00:00.000Z',
            timeEnd: '2026-05-04T11:30:00.000Z',
            eventType: 'fromGmail',
            status: 'done',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).not.toHaveBeenCalled();
    });

    it('skips per-instance cancellation for a fromGmail routine-generated item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-cancel-fromgmail',
            routineId: 'routine-1',
            title: 'Gmail mirror cancel',
            timeStart: '2026-05-04T11:00:00.000Z',
            timeEnd: '2026-05-04T11:30:00.000Z',
            eventType: 'fromGmail',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).not.toHaveBeenCalled();
    });
});

describe('calendar push-back — failure surfacing (ops marked syncFailed)', () => {
    // Regression suite for the 2026-08-19 incident: a 9-item burst-trash hit Google's short-window
    // rate limit on 2 of the 9 instance-cancellation PATCHes, and the failures vanished into the
    // fire-and-forget console log — no syncFailed op, no SyncIssuesPanel row, no retry path. Every
    // GCal-mutating branch (not just the create paths) must now surface a provider failure onto
    // the driving op.

    function gcalRateLimitError() {
        // Gaxios shape of Google's short-window per-user write quota: HTTP 403 (not 429).
        return Object.assign(new Error('Rate Limit Exceeded'), {
            code: 403,
            errors: [{ message: 'Rate Limit Exceeded', domain: 'usageLimits', reason: 'rateLimitExceeded' }],
        });
    }

    function gcalServerError() {
        return Object.assign(new Error('Backend Error'), { code: 500 });
    }

    async function insertLinkedRoutine(userId: string, overrides: Partial<RoutineInterface> = {}) {
        const routine = makeRoutine(userId, {
            calendarEventId: 'recurring-master-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            ...overrides,
        });
        await routinesDAO.insertOne(routine);
        return routine;
    }

    /** Persists the op first (markOpFailed updates the row in place), pushes, and returns the post-push row. */
    async function pushPersistedOp(userId: string, overrides: Partial<OperationInterface>) {
        const op = makeOp(userId, overrides);
        await operationsDAO.insertOne(op);
        await maybePushToGCal(op, mockBuildProvider());
        return (await operationsDAO.findOne({ _id: op._id }))!;
    }

    it('marks the op transient_exhausted when a routine-instance cancellation is rate-limited (the silent-drop incident)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedRoutine(userId);

        const item = makeItem(userId, {
            _id: 'item-cancel-ratelimited',
            routineId: 'routine-1',
            status: 'trash',
            timeStart: '2026-08-25T06:45:00.000Z',
            timeEnd: '2026-08-25T07:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockRejectedValue(gcalRateLimitError());

        const failed = await pushPersistedOp(userId, { _id: 'op-cancel-rl', entityType: 'item', entityId: item._id!, snapshot: item });

        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
        expect(failed.failureDetail).toContain('Rate Limit Exceeded');
        expect(failed.failedTs).toBeTruthy();
    });

    it('leaves the op unmarked when the cancellation succeeds', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedRoutine(userId);

        const item = makeItem(userId, {
            _id: 'item-cancel-ok',
            routineId: 'routine-1',
            status: 'trash',
            timeStart: '2026-08-25T06:45:00.000Z',
            timeEnd: '2026-08-25T07:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        const pushed = await pushPersistedOp(userId, { _id: 'op-cancel-ok', entityType: 'item', entityId: item._id!, snapshot: item });

        expect(pushed.syncFailed).toBeUndefined();
        expect(pushed.failureReason).toBeUndefined();
    });

    it('marks the op when a routine-instance override push fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedRoutine(userId);

        const item = makeItem(userId, {
            _id: 'item-override-500',
            routineId: 'routine-1',
            status: 'calendar',
            timeStart: '2026-08-25T06:45:00.000Z',
            timeEnd: '2026-08-25T07:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockRejectedValue(gcalServerError());

        const failed = await pushPersistedOp(userId, { _id: 'op-override-500', entityType: 'item', entityId: item._id!, snapshot: item });

        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
    });

    it('marks the op when a standalone linked-item update fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-update-500',
            calendarEventId: 'gcal-ev-500',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockRejectedValue(gcalServerError());

        const failed = await pushPersistedOp(userId, { _id: 'op-update-500', entityType: 'item', entityId: item._id!, snapshot: item });

        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
    });

    it('marks the op when the GCal cleanup for a hard-deleted linked item fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Hydrated delete snapshot — the pre-delete row shape maybePushToGCal receives.
        const snapshot = makeItem(userId, {
            _id: 'item-hard-deleted',
            calendarEventId: 'gcal-ev-deleted',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockRejectedValue(gcalRateLimitError());

        const failed = await pushPersistedOp(userId, { _id: 'op-delete-rl', entityType: 'item', entityId: snapshot._id!, opType: 'delete', snapshot });

        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
    });

    it('marks the op when the GCal removal for a calendar-detached item fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const detachedCalendar = makeItem(userId, {
            _id: 'item-detached',
            calendarEventId: 'gcal-ev-detached',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        // Post-detach snapshot: active status, GCal linkage stripped by the status matrix.
        const snapshot = makeItem(userId, { _id: 'item-detached', status: 'nextAction', timeStart: undefined, timeEnd: undefined });

        vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockRejectedValue(gcalServerError());

        const failed = await pushPersistedOp(userId, { _id: 'op-detach-500', entityType: 'item', entityId: 'item-detached', snapshot, detachedCalendar });

        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
    });

    it('marks the op when the pause cap fails, after the local item trash has already run', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = await insertLinkedRoutine(userId, { active: false });

        // Future generated occurrence the pause must trash regardless of the GCal outcome.
        const futureItem = makeItem(userId, {
            _id: 'item-pause-future',
            routineId: routine._id,
            status: 'calendar',
            timeStart: dayjs().add(7, 'day').toISOString(),
            timeEnd: dayjs().add(7, 'day').add(30, 'minute').toISOString(),
        });
        await itemsDAO.insertOne(futureItem);

        // Prior op with active:true so readPriorActiveFlag sees a pause transition.
        const priorTs = dayjs().subtract(1, 'minute').toISOString();
        await operationsDAO.insertOne(
            makeOp(userId, { _id: 'op-pause-prior', ts: priorTs, entityType: 'routine', entityId: routine._id, snapshot: { ...routine, active: true } }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockRejectedValue(gcalRateLimitError());

        const failed = await pushPersistedOp(userId, { _id: 'op-pause-cap', entityType: 'routine', entityId: routine._id, snapshot: routine });

        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
        // The cap failure must not have blocked the local trash cascade that ran before it.
        const trashed = await itemsDAO.findByOwnerAndId(futureItem._id!, userId);
        expect(trashed!.status).toBe('trash');
    });

    it('marks the op when the resume series push fails, and still regenerates local items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = await insertLinkedRoutine(userId, { active: true });

        // Prior op with active:false so readPriorActiveFlag sees a resume transition.
        const priorTs = dayjs().subtract(1, 'minute').toISOString();
        await operationsDAO.insertOne(
            makeOp(userId, { _id: 'op-resume-prior', ts: priorTs, entityType: 'routine', entityId: routine._id, snapshot: { ...routine, active: false } }),
        );

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringEvent').mockRejectedValue(gcalServerError());

        const failed = await pushPersistedOp(userId, { _id: 'op-resume-500', entityType: 'routine', entityId: routine._id, snapshot: routine });

        expect(updateSpy).toHaveBeenCalledOnce();
        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
        // Regen must have run despite the failed series push — future occurrences exist locally.
        const regenerated = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' });
        expect(regenerated.length).toBeGreaterThan(0);
    });
});

describe('calendar push-back — routines', () => {
    it('updates GCal recurring event when routine changes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-recurring-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routine);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledWith('gcal-recurring-1', routine, 'primary', 'Asia/Jerusalem');
        // Verify lastPushedToGCalTs was stamped.
        const updated = await routinesDAO.findByOwnerAndId(routine._id, userId);
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('creates GCal recurring event for a new calendar routine', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routine);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('new-recurring-id');

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        expect(createSpy).toHaveBeenCalledOnce();
        const updated = await routinesDAO.findByOwnerAndId(routine._id, userId);
        expect(updated!.calendarEventId).toBe('new-recurring-id');
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('skips routine creation when DB already has calendarEventId (concurrent push-back guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Snapshot passed in the op lacks calendarEventId (captured at queue-time).
        const snapshotWithoutLink = makeRoutine(userId, {
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });

        // But the DB record already has it — a concurrent push-back linked it first.
        const routineInDb = makeRoutine(userId, {
            calendarEventId: 'already-linked',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routineInDb);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('duplicate-id');

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: snapshotWithoutLink._id, snapshot: snapshotWithoutLink }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips non-calendar routines without calendarEventId', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            routineType: 'nextAction',
            calendarIntegrationId: 'int-1',
        });
        await routinesDAO.insertOne(routine);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('id');

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips calendar routines without calendarIntegrationId', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        const routine = makeRoutine(userId);
        await routinesDAO.insertOne(routine);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('id');

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });

    it('on routine delete: deletes GCal recurring event and trashes generated calendar items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            _id: 'routine-del',
            calendarEventId: 'gcal-master-del',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        // Routine is NOT inserted into the DB: the caller (sync.ts) captures the snapshot pre-delete
        // and then applyEntityOp hard-deletes the doc. By the time maybePushToGCal runs, the routine
        // is already gone — the push-back must work off the snapshot alone.

        const now = dayjs().toISOString();
        await itemsDAO.insertMany([
            { _id: 'gen-1', user: userId, status: 'calendar', title: 'Standup Mon', routineId: 'routine-del', createdTs: now, updatedTs: now },
            { _id: 'gen-2', user: userId, status: 'calendar', title: 'Standup Mon next', routineId: 'routine-del', createdTs: now, updatedTs: now },
            // Unrelated item (no routineId) must NOT be touched.
            { _id: 'other', user: userId, status: 'calendar', title: 'Other cal item', createdTs: now, updatedTs: now },
            // Item belonging to a different routine must NOT be touched.
            {
                _id: 'other-routine-cal',
                user: userId,
                status: 'calendar',
                title: 'Other routine cal',
                routineId: 'routine-other',
                createdTs: now,
                updatedTs: now,
            },
            // Item with the same routineId but a non-calendar status IS also trashed — the
            // sibling nextAction cascade (trashGeneratedOpenNextActionItems) covers it.
            {
                _id: 'gen-nextaction',
                user: userId,
                status: 'nextAction',
                title: 'NA sibling',
                routineId: 'routine-del',
                createdTs: now,
                updatedTs: now,
            },
        ]);

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, opType: 'delete', snapshot: routine }), mockBuildProvider());

        expect(deleteSpy).toHaveBeenCalledWith('gcal-master-del', 'primary');

        const g1 = await itemsDAO.findOne({ _id: 'gen-1' });
        const g2 = await itemsDAO.findOne({ _id: 'gen-2' });
        const other = await itemsDAO.findOne({ _id: 'other' });
        const otherRoutine = await itemsDAO.findOne({ _id: 'other-routine-cal' });
        const naSibling = await itemsDAO.findOne({ _id: 'gen-nextaction' });
        expect(g1?.status).toBe('trash');
        expect(g2?.status).toBe('trash');
        expect(other?.status).toBe('calendar');
        expect(otherRoutine?.status).toBe('calendar');
        expect(naSibling?.status).toBe('trash');

        // Each cascade-trashed item records an update op so other devices sync the state change.
        const ops = await operationsDAO.findArray({ entityId: { $in: ['gen-1', 'gen-2', 'gen-nextaction'] } });
        expect(ops).toHaveLength(3);
        expect(ops.every((op) => op.opType === 'update' && op.snapshot?.status === 'trash')).toBe(true);
    });

    it('on routine delete without calendarEventId: trashes generated items but skips GCal call', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, { _id: 'routine-nolink', routineType: 'nextAction' });
        // No calendarEventId — nothing to remove from GCal.

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'gen-nextaction',
            user: userId,
            status: 'calendar',
            title: 'Weird next-action with cal status',
            routineId: 'routine-nolink',
            createdTs: now,
            updatedTs: now,
        });

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, opType: 'delete', snapshot: routine }), mockBuildProvider());

        expect(deleteSpy).not.toHaveBeenCalled();
        const item = await itemsDAO.findOne({ _id: 'gen-nextaction' });
        expect(item?.status).toBe('trash');
    });

    it('on routine delete: swallows GCal provider errors and still trashes generated items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            _id: 'routine-err',
            calendarEventId: 'gcal-err-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'gen-err',
            user: userId,
            status: 'calendar',
            title: 'Instance',
            routineId: 'routine-err',
            createdTs: now,
            updatedTs: now,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockRejectedValue(new Error('boom'));

        // Must not throw: provider failure is best-effort.
        await expect(
            maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, opType: 'delete', snapshot: routine }), mockBuildProvider()),
        ).resolves.toBeUndefined();

        const item = await itemsDAO.findOne({ _id: 'gen-err' });
        expect(item?.status).toBe('trash');
    });
});

describe('calendar push-back — concurrent in-flight guard', () => {
    it('creates only one GCal recurring event when two create ops race concurrently', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            _id: 'routine-concurrent-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routine);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('new-recurring-id');

        const op = makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine });
        // Fire two push-backs concurrently for the same entity — simulates back-to-back flush batches.
        await Promise.all([maybePushToGCal(op, mockBuildProvider()), maybePushToGCal(op, mockBuildProvider())]);

        expect(createSpy).toHaveBeenCalledOnce();
    });

    it('creates only one GCal event when two create item ops race concurrently', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { _id: 'item-concurrent-1' });
        await itemsDAO.insertOne(item);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'new-gcal-id' });

        const op = makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item });
        // Fire two push-backs concurrently for the same entity.
        await Promise.all([maybePushToGCal(op, mockBuildProvider()), maybePushToGCal(op, mockBuildProvider())]);

        expect(createSpy).toHaveBeenCalledOnce();
    });

    it('cleans up in-flight set when item GCal creation fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { _id: 'item-error-cleanup-1' });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockRejectedValue(new Error('GCal API error'));

        const op = makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item });
        await maybePushToGCal(op, mockBuildProvider());

        // The in-flight set must be cleaned up so subsequent retries are not permanently blocked.
        expect(gcalCreationInFlight.has(item._id!)).toBe(false);
    });

    it('cleans up in-flight set when routine GCal creation fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            _id: 'routine-error-cleanup-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routine);

        vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockRejectedValue(new Error('GCal API error'));

        const op = makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine });
        await maybePushToGCal(op, mockBuildProvider());

        expect(gcalCreationInFlight.has(routine._id)).toBe(false);
    });
});

// ─── Loop prevention (echo detection) ──────────────────────────────────────

describe('loop prevention — echo detection', () => {
    it('skips importing a GCal event that was recently pushed by the app', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const { integration } = await insertIntegrationWithConfig(userId);

        const now = dayjs().toISOString();
        // Item was pushed to GCal moments ago.
        const existingItem: ItemInterface = {
            _id: 'item-echo-1',
            user: userId,
            status: 'calendar',
            title: 'Echoed Event',
            timeStart: dayjs().add(1, 'day').toISOString(),
            timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
            calendarEventId: 'gcal-echo-1',
            calendarIntegrationId: integration._id,
            calendarSyncConfigId: 'sync-config-1',
            lastPushedToGCalTs: now,
            createdTs: now,
            updatedTs: now,
        };
        await itemsDAO.insertOne(existingItem);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        // The event's `updated` timestamp is within the 5-second echo window.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-echo-1',
                    title: 'Echoed Event — from GCal',
                    timeStart: existingItem.timeStart!,
                    timeEnd: existingItem.timeEnd!,
                    updated: dayjs().add(2, 'second').toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-echo',
        });

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/sync',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        // The item should NOT have been updated with the GCal title — echo was detected.
        const item = await itemsDAO.findByOwnerAndId('item-echo-1', userId);
        expect(item!.title).toBe('Echoed Event');
    });

    it('imports GCal event when outside the echo window', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const { integration } = await insertIntegrationWithConfig(userId);

        const twoMinutesAgo = dayjs().subtract(2, 'minute').toISOString();
        const existingItem: ItemInterface = {
            _id: 'item-echo-2',
            user: userId,
            status: 'calendar',
            title: 'Old Event',
            timeStart: dayjs().add(1, 'day').toISOString(),
            timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
            calendarEventId: 'gcal-echo-2',
            calendarIntegrationId: integration._id,
            calendarSyncConfigId: 'sync-config-1',
            lastPushedToGCalTs: twoMinutesAgo,
            createdTs: twoMinutesAgo,
            updatedTs: twoMinutesAgo,
        };
        await itemsDAO.insertOne(existingItem);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-echo-2',
                    title: 'Updated by someone else',
                    timeStart: existingItem.timeStart!,
                    timeEnd: existingItem.timeEnd!,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-echo-2',
        });

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/sync',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        // The item SHOULD have been updated — outside the echo window.
        const item = await itemsDAO.findByOwnerAndId('item-echo-2', userId);
        expect(item!.title).toBe('Updated by someone else');
    });
});

// ─── findNeedingWebhook ────────────────────────────────────────────────────

describe('findNeedingWebhook', () => {
    it('returns enabled configs with no webhookExpiry', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const horizon = dayjs().add(1, 'day').toISOString();
        const results = await calendarSyncConfigsDAO.findNeedingWebhook(horizon);
        expect(results).toHaveLength(1);
        expect(results[0]._id).toBe('sync-config-1');
    });

    it('returns enabled configs with expired webhookExpiry', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch', 'res', dayjs().subtract(1, 'hour').toISOString());

        const horizon = dayjs().add(1, 'day').toISOString();
        const results = await calendarSyncConfigsDAO.findNeedingWebhook(horizon);
        expect(results).toHaveLength(1);
    });

    it('excludes disabled configs', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.updateOne({ _id: 'sync-config-1' } as never, { $set: { enabled: false } });

        const horizon = dayjs().add(1, 'day').toISOString();
        const results = await calendarSyncConfigsDAO.findNeedingWebhook(horizon);
        expect(results).toHaveLength(0);
    });

    it('excludes configs with webhookExpiry beyond the horizon', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch', 'res', dayjs().add(5, 'day').toISOString());

        const horizon = dayjs().add(1, 'day').toISOString();
        const results = await calendarSyncConfigsDAO.findNeedingWebhook(horizon);
        expect(results).toHaveLength(0);
    });
});

// ─── Recurring event → routine import ─────────────────────────────────────

describe('POST /calendar/integrations/:id/sync — recurring event import', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('creates a routine from a GCal recurring master event', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();
        const endTs = dayjs().add(1, 'day').add(30, 'minute').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-1',
                    title: 'Weekly standup',
                    timeStart: futureTs,
                    timeEnd: endTs,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-1' });
        expect(routine).not.toBeNull();
        expect(routine!.title).toBe('Weekly standup');
        expect(routine!.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
        expect(routine!.routineType).toBe('calendar');
        expect(routine!.calendarIntegrationId).toBe('int-1');
        expect(routine!.calendarSyncConfigId).toBe('sync-config-1');
        expect(routine!.calendarItemTemplate).toBeDefined();
        expect(routine!.calendarItemTemplate!.duration).toBe(30);
        expect(routine!.active).toBe(true);

        // Operation should be recorded
        const ops = await operationsDAO.findArray({ entityId: routine!._id, entityType: 'routine' });
        expect(ops).toHaveLength(1);
        expect(ops[0]!.opType).toBe('create');
    });

    it('updates an existing routine when GCal master event is newer', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-2',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Old title',
                updatedTs: oldTs,
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();
        const endTs = dayjs().add(1, 'day').add(45, 'minute').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-2',
                    title: 'New title',
                    timeStart: futureTs,
                    timeEnd: endTs,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-2' });
        expect(routine!.title).toBe('New title');
        expect(routine!.rrule).toBe('FREQ=DAILY');
        expect(routine!.calendarItemTemplate!.duration).toBe(45);
    });

    it('skips update when inbound GCal payload is older than the last-synced GCal state', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // The structural gate compares against `lastSyncedFromGCalTs` (the GCal-side anchor of the last
        // applied payload), NOT `updatedTs` — a self-bumped `updatedTs` must not lock GCal out. Seed an
        // anchor newer than the inbound payload to assert genuine out-of-order protection.
        const lastSyncedFromGCalTs = dayjs().toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-3',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Local title',
                updatedTs: lastSyncedFromGCalTs,
                lastSyncedFromGCalTs,
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-3',
                    title: 'GCal title',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().subtract(2, 'hour').toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-3' });
        expect(routine!.title).toBe('Local title');
    });

    it('corrects a stale-UNTIL routine even when updatedTs is newer than the GCal payload (anchor unset)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Reproduces the stale-UNTIL deadlock: a routine frozen with a past UNTIL + active:false whose
        // `updatedTs` was bumped to "now" by churn, but with no `lastSyncedFromGCalTs` anchor. Gating on
        // the anchor (epoch fallback) lets GCal re-assert the live (no-UNTIL) schedule and reactivate it.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-stuck',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily sync',
                rrule: 'FREQ=WEEKLY;WKST=SU;UNTIL=20251210T215959Z;BYDAY=MO,TU,WE',
                active: false,
                updatedTs: dayjs().toISOString(),
                lastSyncedFromGCalTs: undefined,
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();
        const gcalUpdated = dayjs().subtract(2, 'hour').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-stuck',
                    title: 'Daily sync',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: gcalUpdated,
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-stuck' });
        expect(routine!.rrule).toBe('FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE');
        expect(routine!.rrule).not.toContain('UNTIL=');
        expect(routine!.active).toBe(true);
        expect(routine!.lastSyncedFromGCalTs).toBe(gcalUpdated);
    });

    it('clears retiredByGCal when a confirmed master proves the series alive again', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // A reap-retired routine (capped + paused + marked). If the user later restores the series in
        // GCal, the inbound confirmed master must both revive the routine (newlyLosesUntil) AND drop
        // the stale marker — otherwise the /maintenance heals keep treating the live routine as a
        // deliberate retirement forever.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-revived',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily sync',
                rrule: 'FREQ=WEEKLY;WKST=SU;UNTIL=20251210T215959Z;BYDAY=MO,TU,WE',
                active: false,
                retiredByGCal: true,
                lastSyncedFromGCalTs: undefined,
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-revived',
                    title: 'Daily sync',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().subtract(2, 'hour').toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-revived' });
        expect(routine!.active).toBe(true);
        expect(routine!.retiredByGCal).toBeUndefined();
    });

    it('does NOT clear retiredByGCal from an out-of-order older payload', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // A notes-only change on a payload OLDER than the structural anchor rides the merge path past
        // the !structurallyNewer early return — the one reachable way a stale payload meets the marker.
        // A fresher cancellation set this marker; a stale confirmed payload must not clear it, or a
        // delayed webhook replay would strip the heal protection right after the retirement.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-stale-payload',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily sync',
                rrule: 'FREQ=WEEKLY;WKST=SU;UNTIL=20251210T215959Z;BYDAY=MO,TU,WE',
                active: false,
                retiredByGCal: true,
                updatedTs: dayjs().subtract(3, 'hour').toISOString(),
                lastSyncedFromGCalTs: dayjs().toISOString(),
                lastSyncedNotes: '<p>old</p>',
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-stale-payload',
                    title: 'Daily sync',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    // Older than the anchor (structurallyNewer=false) but newer than local updatedTs,
                    // so the notes conflict resolves to GCal and the merge path actually runs.
                    updated: dayjs().subtract(2, 'hour').toISOString(),
                    status: 'confirmed',
                    description: '<p>new</p>',
                    recurrence: ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-stale-payload' });
        // Load-bearing: proves the merge path ran (payload not rejected outright) …
        expect(routine!.template.notes).toBe('new');
        // … and yet the stale payload neither cleared the marker nor revived the routine.
        expect(routine!.retiredByGCal).toBe(true);
        expect(routine!.active).toBe(false);
        expect(routine!.rrule).toContain('UNTIL=');
    });

    it('does NOT reactivate a user-paused routine on a still-uncapped series (newlyLosesUntil guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // User intentionally paused this routine. Neither the local rrule nor GCal's master carries an
        // UNTIL — so `newlyLosesUntil` (which requires the LOCAL rrule to have had UNTIL) must NOT fire,
        // leaving the user's pause intact even though the inbound payload is structurally newer.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-paused',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Paused daily',
                rrule: 'FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE',
                active: false,
                lastSyncedFromGCalTs: dayjs().subtract(1, 'day').toISOString(),
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-paused',
                    title: 'Paused daily',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        expect((await routinesDAO.findOne({ calendarEventId: 'recurring-master-paused' }))?.active).toBe(false);
    });

    it('deactivates routine when GCal master event is cancelled', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-4',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                active: true,
            }),
        );
        // Insert a future item belonging to this routine
        await itemsDAO.insertOne({
            _id: 'future-routine-item',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: futureTs,
            timeEnd: futureTs,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-4',
                    title: '',
                    timeStart: '',
                    timeEnd: '',
                    updated: dayjs().toISOString(),
                    status: 'cancelled',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-4' });
        expect(routine!.active).toBe(false);

        const item = await itemsDAO.findOne({ _id: 'future-routine-item' });
        expect(item!.status).toBe('trash');
    });

    it('deactivates routine when cancelled master lacks recurrence field', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-cancel-no-recurrence',
                calendarEventId: 'recurring-master-no-recurrence',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                active: true,
            }),
        );

        // Cancelled master events from incremental sync often lack the recurrence field
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-no-recurrence',
                    title: '',
                    timeStart: '',
                    timeEnd: '',
                    updated: dayjs().toISOString(),
                    status: 'cancelled',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ _id: 'routine-cancel-no-recurrence' });
        expect(routine!.active).toBe(false);
    });

    it('skips recurring master with echo detection', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const recentTs = dayjs().toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-5',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Original',
                lastPushedToGCalTs: recentTs,
                updatedTs: recentTs,
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-5',
                    title: 'Changed by echo',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().add(2, 'second').toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-5' });
        expect(routine!.title).toBe('Original');
    });

    it('skips recurring master with no RRULE line', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-no-rrule',
                    title: 'Only EXDATE',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['EXDATE:20260410T090000Z'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-no-rrule' });
        expect(routine).toBeNull();
    });

    it('does not create calendar items for recurring master events', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-6',
                    title: 'Daily sync',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Should create a routine, not an item
        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-6' });
        expect(routine).not.toBeNull();

        const item = await itemsDAO.findOne({ calendarEventId: 'recurring-master-6' });
        expect(item).toBeNull();
    });

    it('propagates GCal master title edit to all future generated items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-title-prop',
                calendarEventId: 'master-title-prop',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Old name',
                createdTs: oldTs,
                updatedTs: oldTs,
            }),
        );

        // Three future items on different days — all should get retitled.
        const makeItem = (suffix: string, daysAhead: number): ItemInterface => ({
            _id: `item-title-${suffix}`,
            user: userId,
            status: 'calendar',
            title: 'Old name',
            routineId: 'routine-title-prop',
            timeStart: dayjs().add(daysAhead, 'day').format('YYYY-MM-DDT09:00:00'),
            timeEnd: dayjs().add(daysAhead, 'day').format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });
        await itemsDAO.insertOne(makeItem('a', 7));
        await itemsDAO.insertOne(makeItem('b', 14));
        await itemsDAO.insertOne(makeItem('c', 21));

        // Use a Jerusalem-local 09:00 timeStart with explicit timezone offset so that
        // `extractLocalTime` round-trips to exactly "09:00" — matching the existing routine's
        // `calendarItemTemplate.timeOfDay`. Otherwise the inferred schedule would differ and the
        // update path would regenerate items instead of just propagating the title.
        const futureDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const gcalStart = dayjs.tz(`${futureDate}T09:00:00`, 'Asia/Jerusalem').format();
        const gcalEnd = dayjs.tz(`${futureDate}T09:30:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-title-prop',
                    title: 'New name',
                    timeStart: gcalStart,
                    timeEnd: gcalEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-title-prop',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const items = await itemsDAO.findArray({ routineId: 'routine-title-prop', status: 'calendar' });
        expect(items).toHaveLength(3);
        for (const item of items) {
            expect(item.title).toBe('New name');
            // IDs must be preserved — this is a rename, not a regenerate.
            expect(['item-title-a', 'item-title-b', 'item-title-c']).toContain(item._id);
        }
    });

    it('regenerates future items when GCal master rrule changes (Mon → Tue)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        // Anchor createdTs to a Monday so the rrule's DTSTART lines up with BYDAY=MO.
        const monday = dayjs().day(1).add(1, 'week').startOf('day');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-rrule-swap',
                calendarEventId: 'master-rrule-swap',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Weekly',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                createdTs: monday.toISOString(),
                updatedTs: oldTs,
            }),
        );

        const existingItemId = 'item-rrule-existing';
        await itemsDAO.insertOne({
            _id: existingItemId,
            user: userId,
            status: 'calendar',
            title: 'Weekly',
            routineId: 'routine-rrule-swap',
            timeStart: monday.format('YYYY-MM-DDT09:00:00'),
            timeEnd: monday.format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        // GCal master edit: recurrence now on Tuesday, start shifts 1 day.
        const tuesday = monday.add(1, 'day');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-rrule-swap',
                    title: 'Weekly',
                    timeStart: tuesday.format('YYYY-MM-DDT09:00:00'),
                    timeEnd: tuesday.format('YYYY-MM-DDT09:30:00'),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
                },
            ],
            nextSyncToken: 'tok-rrule-swap',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Old Monday item is trashed; fresh Tuesday items are created.
        const trashed = await itemsDAO.findOne({ _id: existingItemId });
        expect(trashed!.status).toBe('trash');

        const liveItems = await itemsDAO.findArray({ routineId: 'routine-rrule-swap', status: 'calendar' });
        expect(liveItems.length).toBeGreaterThan(0);
        for (const item of liveItems) {
            // Tuesday = day 2 of the week.
            expect(dayjs(item.timeStart).day()).toBe(2);
        }
    });

    it('regenerates future items when GCal master duration changes (30 → 60)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const monday = dayjs().day(1).add(1, 'week').startOf('day');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-duration-change',
                calendarEventId: 'master-duration-change',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Meeting',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                createdTs: monday.toISOString(),
                updatedTs: oldTs,
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            }),
        );

        await itemsDAO.insertOne({
            _id: 'item-duration-existing',
            user: userId,
            status: 'calendar',
            title: 'Meeting',
            routineId: 'routine-duration-change',
            timeStart: monday.format('YYYY-MM-DDT09:00:00'),
            timeEnd: monday.format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-duration-change',
                    title: 'Meeting',
                    timeStart: monday.format('YYYY-MM-DDT09:00:00'),
                    timeEnd: monday.format('YYYY-MM-DDT10:00:00'),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-duration',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const trashed = await itemsDAO.findOne({ _id: 'item-duration-existing' });
        expect(trashed!.status).toBe('trash');

        const liveItems = await itemsDAO.findArray({ routineId: 'routine-duration-change', status: 'calendar' });
        expect(liveItems.length).toBeGreaterThan(0);
        for (const item of liveItems) {
            const durationMin = dayjs(item.timeEnd).diff(dayjs(item.timeStart), 'minute');
            expect(durationMin).toBe(60);
        }
    });

    it('regenerates future items when GCal master timeOfDay changes (09:00 → 10:00)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const monday = dayjs().day(1).add(1, 'week').startOf('day');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-time-change',
                calendarEventId: 'master-time-change',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Meeting',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                createdTs: monday.toISOString(),
                updatedTs: oldTs,
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            }),
        );

        await itemsDAO.insertOne({
            _id: 'item-time-existing',
            user: userId,
            status: 'calendar',
            title: 'Meeting',
            routineId: 'routine-time-change',
            timeStart: monday.format('YYYY-MM-DDT09:00:00'),
            timeEnd: monday.format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        // Use Jerusalem-local 10:00 with explicit timezone so `extractLocalTime` yields "10:00".
        const gcalStart = dayjs.tz(`${monday.format('YYYY-MM-DD')}T10:00:00`, 'Asia/Jerusalem').format();
        const gcalEnd = dayjs.tz(`${monday.format('YYYY-MM-DD')}T10:30:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-time-change',
                    title: 'Meeting',
                    timeStart: gcalStart,
                    timeEnd: gcalEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-time',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const trashed = await itemsDAO.findOne({ _id: 'item-time-existing' });
        expect(trashed!.status).toBe('trash');

        const liveItems = await itemsDAO.findArray({ routineId: 'routine-time-change', status: 'calendar' });
        expect(liveItems.length).toBeGreaterThan(0);
        for (const item of liveItems) {
            expect(item.timeStart?.slice(11, 16)).toBe('10:00');
        }
    });

    it('preserves per-instance title overrides when GCal master title changes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const nextMon = dayjs().day(1).add(1, 'week').startOf('day');
        const overrideDate = nextMon.format('YYYY-MM-DD');

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-title-override',
                calendarEventId: 'master-title-override',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Old name',
                createdTs: oldTs,
                updatedTs: oldTs,
                routineExceptions: [{ date: overrideDate, type: 'modified', title: 'Special name' }],
            }),
        );

        // One regular future item (to be renamed) + one with a per-instance override (to be preserved).
        await itemsDAO.insertOne({
            _id: 'item-regular',
            user: userId,
            status: 'calendar',
            title: 'Old name',
            routineId: 'routine-title-override',
            timeStart: nextMon.add(7, 'day').format('YYYY-MM-DDT09:00:00'),
            timeEnd: nextMon.add(7, 'day').format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });
        await itemsDAO.insertOne({
            _id: 'item-overridden',
            user: userId,
            status: 'calendar',
            title: 'Special name',
            routineId: 'routine-title-override',
            timeStart: `${overrideDate}T09:00:00`,
            timeEnd: `${overrideDate}T09:30:00`,
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        // Preserve the routine's 09:00 / 30m schedule so only title changes.
        const futureDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const gcalStart = dayjs.tz(`${futureDate}T09:00:00`, 'Asia/Jerusalem').format();
        const gcalEnd = dayjs.tz(`${futureDate}T09:30:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-title-override',
                    title: 'New name',
                    timeStart: gcalStart,
                    timeEnd: gcalEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-override',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const regular = await itemsDAO.findOne({ _id: 'item-regular' });
        expect(regular!.title).toBe('New name');
        const overridden = await itemsDAO.findOne({ _id: 'item-overridden' });
        expect(overridden!.title).toBe('Special name');
    });

    it('leaves past items untouched when GCal master title changes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-past-items',
                calendarEventId: 'master-past-items',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Old name',
                createdTs: oldTs,
                updatedTs: oldTs,
            }),
        );

        // Past item should keep its historical title regardless of master rename.
        await itemsDAO.insertOne({
            _id: 'item-past',
            user: userId,
            status: 'calendar',
            title: 'Old name',
            routineId: 'routine-past-items',
            timeStart: dayjs().subtract(7, 'day').format('YYYY-MM-DDT09:00:00'),
            timeEnd: dayjs().subtract(7, 'day').format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });
        await itemsDAO.insertOne({
            _id: 'item-future',
            user: userId,
            status: 'calendar',
            title: 'Old name',
            routineId: 'routine-past-items',
            timeStart: dayjs().add(7, 'day').format('YYYY-MM-DDT09:00:00'),
            timeEnd: dayjs().add(7, 'day').format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        const futureDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const gcalStart = dayjs.tz(`${futureDate}T09:00:00`, 'Asia/Jerusalem').format();
        const gcalEnd = dayjs.tz(`${futureDate}T09:30:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-past-items',
                    title: 'New name',
                    timeStart: gcalStart,
                    timeEnd: gcalEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-past',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const past = await itemsDAO.findOne({ _id: 'item-past' });
        expect(past!.title).toBe('Old name');
        const future = await itemsDAO.findOne({ _id: 'item-future' });
        expect(future!.title).toBe('New name');
    });
});

// ── Cancelled master → orphaned split-successor reap ──────────────────────
//
// A "this and all following" split leaves TWO routines on one bare GCal id: the capped base and the live
// successor. `findExistingRoutineForEvent` resolves that bare id to the BASE (so a capped master can't
// clobber the live successor on the update path), which means a cancellation retires only the base and
// strands the successor active + open-ended, generating phantom items at the old time forever. The reap
// sweep closes that hole — but must not fire when the batch also carries the tail's own live master.

const CANCELLED_MASTER_TITLE = 'Standup';

/** Seeds a split series on one bare id: capped/inactive base + active successor (optionally `_R`-anchored). */
async function seedSplitSeries(userId: string, bareId: string, successorOverrides: Partial<RoutineInterface> = {}): Promise<void> {
    const link = { calendarEventId: bareId, calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' };
    await routinesDAO.insertOne(
        makeRoutine(userId, {
            ...link,
            _id: `${bareId}-base`,
            title: CANCELLED_MASTER_TITLE,
            rrule: 'FREQ=WEEKLY;UNTIL=20260101T235959Z;BYDAY=MO',
            active: false,
        }),
    );
    await routinesDAO.insertOne(
        makeRoutine(userId, {
            ...link,
            _id: `${bareId}-successor`,
            title: CANCELLED_MASTER_TITLE,
            splitFromRoutineId: `${bareId}-base`,
            active: true,
            ...successorOverrides,
        }),
    );
}

/** A cancelled master tombstone as GCal delivers it — no recurrence, no times. */
function cancelledMaster(id: string): GCalEvent {
    return { id, title: '', timeStart: '', timeEnd: '', updated: dayjs().toISOString(), status: 'cancelled' };
}

/** A live master — the tail that keeps a series alive. `rrule` defaults to open-ended. */
function liveMaster(id: string, rrule = 'FREQ=WEEKLY;BYDAY=MO'): GCalEvent {
    const start = dayjs().add(1, 'day');
    return {
        id,
        title: CANCELLED_MASTER_TITLE,
        timeStart: start.format('YYYY-MM-DDT09:00:00'),
        timeEnd: start.format('YYYY-MM-DDT09:30:00'),
        updated: dayjs().toISOString(),
        status: 'confirmed',
        recurrence: [`RRULE:${rrule}`],
    };
}

/** The single active routine on a series, asserting there is exactly one (catches duplicate twins). */
async function expectSoleActiveRoutine(userId: string, bareId: string): Promise<RoutineInterface> {
    const active = await routinesDAO.findArray({ user: userId, calendarEventId: bareId, active: true });
    expect(active).toHaveLength(1);
    const [live] = active;
    if (!live) throw new Error('expected exactly one active routine on the series');
    return live;
}

describe('cancelled master — orphaned split-successor reap', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('retires a legacy successor sharing the bare id, trashing its future items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Legacy successor: no calendarRebasedEventId, so no master of its own will ever cancel it.
        await seedSplitSeries(userId, 'master-orphan');
        await itemsDAO.insertOne(makeItem(userId, { _id: 'item-orphan-future', title: CANCELLED_MASTER_TITLE, routineId: 'master-orphan-successor' }));

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [cancelledMaster('master-orphan')],
            nextSyncToken: 'tok-orphan',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const successor = await routinesDAO.findOne({ _id: 'master-orphan-successor' });
        expect(successor!.active).toBe(false);
        // Capped as well as paused, so `newlyLosesUntil` can revive it if GCal ever reports the series live.
        expect(successor!.rrule).toContain('UNTIL=');
        // Marked as a deliberate GCal retirement so the /maintenance heals ("Repair sync") never
        // resurrect it — without this, healStuckGCalRoutines matches the capped+paused shape and
        // regenerates every phantom item this reap just trashed.
        expect(successor!.retiredByGCal).toBe(true);
        const item = await itemsDAO.findOne({ _id: 'item-orphan-future' });
        expect(item!.status).toBe('trash');
    });

    // Pins the use of the RAW `_R` id rather than the normalized bare id: swapping them would still pass
    // the other tests here while silently sparing every genuinely-dead tail.
    it('retires a rebased successor when its OWN _R master is the one cancelled', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const rebasedId = 'master-own_R20260102T090000';
        await seedSplitSeries(userId, 'master-own', { calendarRebasedEventId: rebasedId });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [cancelledMaster(rebasedId)],
            nextSyncToken: 'tok-own',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const successor = await routinesDAO.findOne({ _id: 'master-own-successor' });
        expect(successor!.active).toBe(false);
        expect(successor!.rrule).toContain('UNTIL=');
    });

    it('spares a rebased successor when only the base segment master is cancelled', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await seedSplitSeries(userId, 'master-spare', { calendarRebasedEventId: 'master-spare_R20260102T090000' });
        await itemsDAO.insertOne(makeItem(userId, { _id: 'item-spare-future', title: CANCELLED_MASTER_TITLE, routineId: 'master-spare-successor' }));

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [cancelledMaster('master-spare')],
            nextSyncToken: 'tok-spare',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const live = await expectSoleActiveRoutine(userId, 'master-spare');
        expect(live._id).toBe('master-spare-successor');
        // The user-visible damage of a false reap is trashed items, not the flag — assert they survive.
        const item = await itemsDAO.findOne({ _id: 'item-spare-future' });
        expect(item!.status).toBe('calendar');
    });

    // Same-batch guard 1 (anchor-less successor): a full sync after a base deletion re-reports the live
    // tail alongside the cancelled base. Reaping in phase 1 killed the routine phase 2 then re-created as
    // a duplicate twin — hence the exactly-one-active assertion.
    it('spares an anchor-less successor when the batch also carries a live _R master', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await seedSplitSeries(userId, 'master-batch1');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [cancelledMaster('master-batch1'), liveMaster('master-batch1_R20260102T090000')],
            nextSyncToken: 'tok-batch1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const live = await expectSoleActiveRoutine(userId, 'master-batch1');
        expect(live._id).toBe('master-batch1-successor');
    });

    // Same-batch guard 2 (re-split): applying "this and all following" to a segment's FIRST occurrence
    // empties it, so GCal cancels that _R master and mints a new one. Reaping in phase 1 paused the
    // successor with an OPEN rrule, which no reactivation gate can undo — the series died with zero
    // active routines.
    it('spares a rebased successor being re-split within the same batch', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await seedSplitSeries(userId, 'master-batch2', { calendarRebasedEventId: 'master-batch2_R20260102T090000' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [cancelledMaster('master-batch2_R20260102T090000'), liveMaster('master-batch2_R20260201T090000')],
            nextSyncToken: 'tok-batch2',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const live = await expectSoleActiveRoutine(userId, 'master-batch2');
        expect(live._id).toBe('master-batch2-successor');
    });

    // A sibling capped with a FUTURE UNTIL still produces occurrences for months — the series is alive.
    // Treating liveness as "open-ended only" reaped it, and unrecoverably: `newlyLosesUntil` waits for an
    // inbound OPEN rrule that a permanently-capped tail never sends.
    it('spares a successor when the batch carries a sibling capped in the future', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await seedSplitSeries(userId, 'master-capped');
        await itemsDAO.insertOne(makeItem(userId, { _id: 'item-capped-future', title: CANCELLED_MASTER_TITLE, routineId: 'master-capped-successor' }));

        const futureUntil = dayjs().add(60, 'day').format('YYYYMMDD[T235959Z]');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [cancelledMaster('master-capped'), liveMaster('master-capped_R20260102T090000', `FREQ=WEEKLY;BYDAY=MO;UNTIL=${futureUntil}`)],
            nextSyncToken: 'tok-capped',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const live = await expectSoleActiveRoutine(userId, 'master-capped');
        expect(live._id).toBe('master-capped-successor');
        const item = await itemsDAO.findOne({ _id: 'item-capped-future' });
        expect(item!.status).toBe('calendar');
    });

    // `findActiveRoutineOnSeries` returns ANY active routine on the series — including a plain base with no
    // successor markers that phase 1's cancelled branch just declined to touch as our own echo. The reap
    // must honour that same window rather than silently overriding it on a pre-existing path.
    it('honours the own-echo window and leaves a just-pushed routine alone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const now = dayjs().toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-echo',
                calendarEventId: 'master-echo',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                active: true,
                lastPushedToGCalTs: now,
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ ...cancelledMaster('master-echo'), updated: now }],
            nextSyncToken: 'tok-echo',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ _id: 'routine-echo' });
        expect(routine!.active).toBe(true);
        expect(routine!.rrule).not.toContain('UNTIL=');
    });
});

// ─── bareIdsWithLiveMasterInBatch — unit tests ────────────────────────────
//
// The reap's liveness predicate: which bare series ids still have a master producing occurrences. Getting
// this wrong in the "dead" direction retires a live series, so pin each case directly rather than only
// through the sync route.

describe('bareIdsWithLiveMasterInBatch', () => {
    const now = '2026-07-27T12:00:00.000Z';
    const master = (id: string, overrides: Partial<GCalEvent> = {}): GCalEvent => ({
        id,
        title: 'Standup',
        timeStart: '2026-07-28T09:00:00',
        timeEnd: '2026-07-28T09:30:00',
        updated: now,
        status: 'confirmed',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        ...overrides,
    });

    it('counts an open-ended master as live', () => {
        expect(bareIdsWithLiveMasterInBatch([master('evt-open')], now)).toEqual(new Set(['evt-open']));
    });

    it('counts a master capped in the future as live — it still produces occurrences', () => {
        const capped = master('evt-future', { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260925T235959Z'] });
        expect(bareIdsWithLiveMasterInBatch([capped], now)).toEqual(new Set(['evt-future']));
    });

    // A capped all-day series legally emits a date-only UNTIL; pins that it parses rather than falling through.
    it('counts a master capped with a date-only future UNTIL as live', () => {
        const capped = master('evt-dateonly', { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260925'] });
        expect(bareIdsWithLiveMasterInBatch([capped], now)).toEqual(new Set(['evt-dateonly']));
    });

    it('treats a master capped in the past as dead — the finished stump a split leaves behind', () => {
        const stump = master('evt-past', { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260606T205959Z'] });
        expect(bareIdsWithLiveMasterInBatch([stump], now)).toEqual(new Set());
    });

    it('treats a cancelled master as dead regardless of its rrule', () => {
        expect(bareIdsWithLiveMasterInBatch([master('evt-cancelled', { status: 'cancelled' })], now)).toEqual(new Set());
    });

    it('treats a master with no recurrence as dead — the series is no longer recurring', () => {
        const { recurrence: _omitted, ...single } = master('evt-single');
        expect(bareIdsWithLiveMasterInBatch([single], now)).toEqual(new Set());
    });

    it('normalizes _R rebased ids onto the bare series id', () => {
        expect(bareIdsWithLiveMasterInBatch([master('evt-bare_R20260102T090000')], now)).toEqual(new Set(['evt-bare']));
    });
});

// ── Notes / description sync ──────────────────────────────────────────────

describe('notes/description sync — inbound', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('sets notes and lastSyncedNotes when importing a new GCal event with description', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-notes-1',
                    title: 'Lunch',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: futureTs,
                    status: 'confirmed',
                    description: 'Bring salad',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ calendarEventId: 'evt-notes-1' });
        expect(item?.notes).toBe('Bring salad');
        expect(item?.lastSyncedNotes).toBe('Bring salad');
    });

    it('updates notes when GCal description changed and GCal is newer', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-notes-upd',
            user: userId,
            status: 'calendar',
            title: 'Meeting',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-notes-2',
            calendarIntegrationId: 'int-1',
            notes: 'Old notes',
            lastSyncedNotes: 'Old notes',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        const newerTs = dayjs().toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-notes-2',
                    title: 'Meeting',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: newerTs,
                    status: 'confirmed',
                    description: 'Updated from GCal',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-notes-upd' });
        expect(item?.notes).toBe('Updated from GCal');
        expect(item?.lastSyncedNotes).toBe('Updated from GCal');
    });

    it('preserves local notes when GCal description is unchanged (only title updated)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-notes-keep',
            user: userId,
            status: 'calendar',
            title: 'Old title',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-notes-3',
            calendarIntegrationId: 'int-1',
            notes: 'My local notes',
            lastSyncedNotes: 'Same as gcal',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        const newerTs = dayjs().toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-notes-3',
                    title: 'New title',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: newerTs,
                    status: 'confirmed',
                    description: 'Same as gcal',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-notes-keep' });
        expect(item?.title).toBe('New title');
        expect(item?.notes).toBe('My local notes');
    });

    it('preserves local notes when GCal description changed but local is newer', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const newerTs = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-notes-local-wins',
            user: userId,
            status: 'calendar',
            title: 'Meeting',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-notes-4',
            calendarIntegrationId: 'int-1',
            notes: 'Locally edited notes',
            lastSyncedNotes: 'Original synced',
            createdTs: newerTs,
            updatedTs: newerTs,
        });

        const olderTs = dayjs().subtract(1, 'hour').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-notes-4',
                    title: 'Meeting',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: olderTs,
                    status: 'confirmed',
                    description: 'GCal description',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-notes-local-wins' });
        expect(item?.notes).toBe('Locally edited notes');
    });
});

describe('notes/description sync — outbound push-back', () => {
    it('passes description to updateEvent when pushing item with notes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-ev-notes',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            notes: 'Push these notes',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        const updates = updateSpy.mock.calls[0]![2];
        // Markdown is converted to HTML for GCal; lastSyncedNotes stores the HTML sent.
        expect(updates).toHaveProperty('description', '<p>Push these notes</p>\n');

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.lastSyncedNotes).toBe('<p>Push these notes</p>\n');
    });

    it('passes empty description when pushing item without notes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-ev-no-notes',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        const updates = updateSpy.mock.calls[0]![2];
        expect(updates).toHaveProperty('description', '');
    });

    it('sets lastSyncedNotes when creating a new GCal event with notes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { notes: 'New item notes' });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'new-gcal-notes-id' });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.calendarEventId).toBe('new-gcal-notes-id');
        // lastSyncedNotes stores HTML (the value sent to GCal), not the raw Markdown.
        expect(updated!.lastSyncedNotes).toBe('<p>New item notes</p>\n');
    });
});

// ─── classifyRecurringMaster — unit tests ─────────────────────────────────

describe('classifyRecurringMaster', () => {
    const makeEvent = (over: Partial<GCalEvent> & Pick<GCalEvent, 'id'>): GCalEvent => ({
        title: 'Daily - Tech sync',
        timeStart: '2026-06-15T09:00:00Z',
        timeEnd: '2026-06-15T09:30:00Z',
        updated: '2026-06-01T00:00:00Z',
        status: 'confirmed',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        ...over,
    });
    const makeRoutine = (over: Partial<RoutineInterface> & Pick<RoutineInterface, 'calendarEventId'>): RoutineInterface => ({
        _id: 'r1',
        user: 'u1',
        title: 'Daily - Tech sync',
        routineType: 'calendar',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        active: true,
        createdTs: '2026-01-01T00:00:00Z',
        updatedTs: '2026-01-01T00:00:00Z',
        ...over,
    });
    const bareId = 'base-master';
    const successorId = `${bareId}_R20260615T090000`;

    it('flags an open _R event when a capped base sibling is in the batch', () => {
        const successor = makeEvent({ id: successorId, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] });
        const base = makeEvent({ id: bareId, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260101T000000Z'] });
        expect(classifyRecurringMaster(successor, [base, successor], [])).toBe('splitSuccessor');
    });

    it('flags an open _R event when an existing routine on the bare id is capped (no sibling in batch)', () => {
        const successor = makeEvent({ id: successorId });
        const capped = makeRoutine({ calendarEventId: bareId, rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260101T000000Z' });
        expect(classifyRecurringMaster(successor, [successor], [capped])).toBe('splitSuccessor');
    });

    it('flags an open _R event when an existing routine on the bare id is paused', () => {
        const successor = makeEvent({ id: successorId });
        const paused = makeRoutine({ calendarEventId: bareId, active: false });
        expect(classifyRecurringMaster(successor, [successor], [paused])).toBe('splitSuccessor');
    });

    it('treats a lone _R event with an active uncapped routine on the bare id as a re-report', () => {
        const successor = makeEvent({ id: successorId });
        const active = makeRoutine({ calendarEventId: bareId, active: true, rrule: 'FREQ=WEEKLY;BYDAY=MO' });
        expect(classifyRecurringMaster(successor, [successor], [active])).toBe('reReport');
    });

    it('treats a lone _R event with no related routine or sibling as a re-report', () => {
        const successor = makeEvent({ id: successorId });
        expect(classifyRecurringMaster(successor, [successor], [])).toBe('reReport');
    });

    it('does NOT flag a capped _R event (a historical segment, not the live tail)', () => {
        const cappedSuccessor = makeEvent({ id: successorId, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601T000000Z'] });
        const capped = makeRoutine({ calendarEventId: bareId, active: false });
        expect(classifyRecurringMaster(cappedSuccessor, [cappedSuccessor], [capped])).toBe('reReport');
    });

    it('does NOT flag a bare (non-_R) master', () => {
        const base = makeEvent({ id: bareId });
        const capped = makeRoutine({ calendarEventId: bareId, active: false });
        expect(classifyRecurringMaster(base, [base], [capped])).toBe('reReport');
    });

    it('does NOT flag a cancelled _R event', () => {
        const cancelled = makeEvent({ id: successorId, status: 'cancelled', recurrence: [] });
        const capped = makeRoutine({ calendarEventId: bareId, active: false });
        expect(classifyRecurringMaster(cancelled, [cancelled], [capped])).toBe('reReport');
    });
});

// ─── pickSplitParent — unit tests ─────────────────────────────────────────

describe('pickSplitParent', () => {
    function makeCandidate(overrides: Partial<RoutineInterface>): RoutineInterface {
        const now = dayjs().toISOString();
        return {
            _id: 'cand-1',
            user: 'u',
            title: 'Standup',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260504T205959Z',
            template: {},
            active: false,
            createdTs: now,
            updatedTs: now,
            calendarSyncConfigId: 'sync-config-1',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            ...overrides,
        };
    }

    it('returns the matching candidate on the happy path', () => {
        const candidate = makeCandidate({});
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [candidate],
        });
        expect(parent?._id).toBe('cand-1');
    });

    it('returns null when no candidates qualify', () => {
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [],
        });
        expect(parent).toBeNull();
    });

    it('E8 regression: rejects when title differs even if gap is within window', () => {
        const candidate = makeCandidate({ title: 'Standup' });
        const parent = pickSplitParent({
            tail: { title: 'unrelated-E8-foo', rrule: 'FREQ=WEEKLY;BYDAY=WE', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-06T11:00:00Z' },
            candidates: [candidate],
        });
        expect(parent).toBeNull();
    });

    it('E7 regression: picks the title-matching chain even when another chain has a closer gap', () => {
        // Wrong chain — closer gap but different title.
        const wrong = makeCandidate({ _id: 'wrong', title: 'unrelated chain', rrule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20260505T055959Z' });
        // Right chain — same title; UNTIL placed just before the tail start (the typical GCal pattern).
        const right = makeCandidate({ _id: 'right', title: 'E7 original', rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260505T055959Z' });
        const parent = pickSplitParent({
            tail: { title: 'E7 original', rrule: 'FREQ=WEEKLY;BYDAY=TU,TH', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [wrong, right],
        });
        expect(parent?._id).toBe('right');
    });

    it('rejects when gap exceeds 1 day', () => {
        const candidate = makeCandidate({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260501T205959Z' });
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [candidate],
        });
        expect(parent).toBeNull();
    });

    it('rejects when tail start precedes UNTIL (negative gap)', () => {
        const candidate = makeCandidate({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260510T205959Z' });
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [candidate],
        });
        expect(parent).toBeNull();
    });

    it('rejects when calendarSyncConfigId differs', () => {
        const candidate = makeCandidate({ calendarSyncConfigId: 'sync-config-other' });
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [candidate],
        });
        expect(parent).toBeNull();
    });

    it('accepts disjoint BYDAY (real splits usually change weekday, e.g. MO → TU)', () => {
        const candidate = makeCandidate({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260504T205959Z' });
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=TU', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [candidate],
        });
        expect(parent?._id).toBe('cand-1');
    });

    it('picks the smallest-gap candidate among multiple passing', () => {
        const farther = makeCandidate({ _id: 'far', rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260504T000000Z' });
        const closer = makeCandidate({ _id: 'close', rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260504T205959Z' });
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [farther, closer],
        });
        expect(parent?._id).toBe('close');
    });

    it('tie-breaks on _id when gaps are equal', () => {
        const a = makeCandidate({ _id: 'aaa', rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260504T205959Z' });
        const b = makeCandidate({ _id: 'bbb', rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260504T205959Z' });
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [b, a],
        });
        expect(parent?._id).toBe('aaa');
    });

    it('normalizes whitespace and case when comparing titles', () => {
        const candidate = makeCandidate({ title: 'Standup' });
        const parent = pickSplitParent({
            tail: { title: '  standup ', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [candidate],
        });
        expect(parent?._id).toBe('cand-1');
    });
});

// ─── POST /calendar/integrations/:id/sync — split detection ──────────────

describe('POST /calendar/integrations/:id/sync — split detection', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    // ─── `_R<…>` rebased-master split successor onboarding ──────────────────────────────────────
    // Regression for "recurring events invisible after a GCal 'this and all following' split": Google
    // caps the base master `<id>` (past UNTIL) and creates an open-ended successor `<id>_R<anchor>`.
    // Both arrive in one batch and both normalize to `<id>`; pre-fix the successor was collapsed onto
    // the capped base routine and never onboarded → the live series showed nothing in the app.

    it('onboards an open-ended _R successor as a new active routine when the capped base arrives in the same batch', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = '3qp933p629fvlgob08faqdtaak';
        const successorId = `${bareId}_R20260615T090000`;
        // Pre-seed the original active series on the bare id (the routine the user already has).
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily - Tech sync',
                rrule: 'FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE',
                active: true,
                updatedTs: dayjs().subtract(2, 'hour').toISOString(),
            }),
        );

        const tz = 'Asia/Jerusalem';
        const successorStart = dayjs().tz(tz).add(1, 'day').hour(11).minute(0).second(0).millisecond(0).toISOString();
        const successorEnd = dayjs(successorStart).add(30, 'minute').toISOString();
        // Base caps the day before the successor's first occurrence.
        const untilCompact = dayjs(successorStart).subtract(1, 'second').utc().format('YYYYMMDD[T]HHmmss[Z]');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: bareId,
                    title: 'Daily - Tech sync',
                    timeStart: dayjs().subtract(30, 'day').toISOString(),
                    timeEnd: dayjs().subtract(30, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE;UNTIL=${untilCompact}`],
                },
                {
                    id: successorId,
                    title: 'Daily - Tech sync',
                    timeStart: successorStart,
                    timeEnd: successorEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE'],
                },
            ],
            nextSyncToken: 'tok-split',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const onSeries = await routinesDAO.findArray({ user: userId, calendarEventId: bareId, calendarIntegrationId: 'int-1' });
        // Two routines now share the bare id: the capped (paused) parent + the open active successor.
        const active = onSeries.filter((r) => r.active);
        expect(active).toHaveLength(1);
        const [successor] = active;
        if (!successor) throw new Error('expected one active routine on the series');
        expect(successor.rrule).not.toContain('UNTIL=');
        expect(successor.calendarEventId).toBe(bareId);
        expect(successor._id).not.toBe('routine-base');
        expect(successor.splitFromRoutineId).toBe('routine-base');
        // The capped parent is paused with its UNTIL retained (GCal truth — not stripped).
        const parent = await routinesDAO.findByOwnerAndId('routine-base', userId);
        expect(parent!.active).toBe(false);
        expect(parent!.rrule).toContain('UNTIL=');

        // Successor materialised future items, all keyed on the BARE id (so they match GCal instance
        // ids — the duplicate-items regression guard) and at the new 11:00 wall-clock time.
        const items = await itemsDAO.findArray({ user: userId, routineId: successor._id, status: 'calendar' });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.timeStart).toMatch(/T11:00:00$/);
            expect(item.calendarInstanceEventId?.startsWith(`${bareId}_`)).toBe(true);
            expect(item.calendarInstanceEventId).not.toContain('_R');
        }
    });

    it('onboards an _R successor when only it arrives but the base routine is already capped (webhook-only batch)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = '42lpclon5cuqh5pggln2u5adlk';
        const successorId = `${bareId}_R20260620T073000`;
        // Base already capped + paused on a prior sync; only the successor arrives now.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-capped',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily - Team Leaders',
                rrule: 'FREQ=WEEKLY;WKST=SU;BYDAY=TH,SU,MO;UNTIL=20260101T205959Z',
                active: false,
                updatedTs: dayjs().subtract(1, 'day').toISOString(),
            }),
        );

        const tz = 'Asia/Jerusalem';
        const successorStart = dayjs().tz(tz).add(1, 'day').hour(10).minute(30).second(0).millisecond(0).toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: successorId,
                    title: 'Daily - Team Leaders',
                    timeStart: successorStart,
                    timeEnd: dayjs(successorStart).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=TH,SU,MO'],
                },
            ],
            nextSyncToken: 'tok-webhook',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const active = (await routinesDAO.findArray({ user: userId, calendarEventId: bareId, calendarIntegrationId: 'int-1' })).filter((r) => r.active);
        expect(active).toHaveLength(1);
        const [successor] = active;
        if (!successor) throw new Error('expected one active successor');
        expect(successor.rrule).not.toContain('UNTIL=');
        expect(successor.splitFromRoutineId).toBe('routine-base-capped');
        // Parent untouched, still capped + paused.
        const parent = await routinesDAO.findByOwnerAndId('routine-base-capped', userId);
        expect(parent!.active).toBe(false);
    });

    it('is idempotent: re-running the split sync creates no second successor and no duplicate items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'mleem99efhim4a0tsh3s86797o';
        const successorId = `${bareId}_R20260618T090000`;
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-idem',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Standup',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                active: true,
                updatedTs: dayjs().subtract(2, 'hour').toISOString(),
            }),
        );

        const tz = 'Asia/Jerusalem';
        const successorStart = dayjs().tz(tz).add(1, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
        const untilCompact = dayjs(successorStart).subtract(1, 'second').utc().format('YYYYMMDD[T]HHmmss[Z]');
        const events = [
            {
                id: bareId,
                title: 'Standup',
                timeStart: dayjs().subtract(30, 'day').toISOString(),
                timeEnd: dayjs().subtract(30, 'day').add(30, 'minute').toISOString(),
                updated: dayjs().toISOString(),
                status: 'confirmed' as const,
                recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`],
            },
            {
                id: successorId,
                title: 'Standup',
                timeStart: successorStart,
                timeEnd: dayjs(successorStart).add(30, 'minute').toISOString(),
                updated: dayjs().toISOString(),
                status: 'confirmed' as const,
                recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
            },
        ];
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events, nextSyncToken: 'tok-idem' });

        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        const afterFirst = await routinesDAO.findArray({ user: userId, calendarEventId: bareId, calendarIntegrationId: 'int-1' });
        const [activeFirst] = afterFirst.filter((r) => r.active);
        if (!activeFirst) throw new Error('expected an active successor after first sync');
        const itemsFirst = await itemsDAO.findArray({ user: userId, routineId: activeFirst._id, status: 'calendar' });

        // Second sync with the identical batch — must not duplicate the successor or its items.
        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        const afterSecond = await routinesDAO.findArray({ user: userId, calendarEventId: bareId, calendarIntegrationId: 'int-1' });
        expect(afterSecond).toHaveLength(afterFirst.length);
        expect(afterSecond.filter((r) => r.active)).toHaveLength(1);
        const itemsSecond = await itemsDAO.findArray({ user: userId, routineId: activeFirst._id, status: 'calendar' });
        expect(itemsSecond.length).toBe(itemsFirst.length);
    });

    it('re-report guard: a lone _R event with an active uncapped routine on the bare id does NOT create a successor', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'rereport-master-id';
        const successorId = `${bareId}_R20260519T123000`;
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-rereport',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Standup',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                active: true,
                updatedTs: dayjs().subtract(2, 'hour').toISOString(),
            }),
        );

        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: successorId,
                    title: 'Standup',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-rereport',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const onSeries = await routinesDAO.findArray({ user: userId, calendarEventId: bareId, calendarIntegrationId: 'int-1' });
        // Exactly the one pre-existing routine — the lone _R event was treated as a re-report.
        expect(onSeries).toHaveLength(1);
        const [routine] = onSeries;
        if (!routine) throw new Error('expected one routine');
        expect(routine._id).toBe('routine-rereport');
        expect(routine.splitFromRoutineId).toBeUndefined();
        expect(routine.active).toBe(true);
    });

    it('links a new master to its split parent and pauses the parent (happy path)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'parent-routine',
                calendarEventId: 'master-parent',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Weekly sync',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                updatedTs: oldTs,
            }),
        );

        const parentStart = dayjs().add(1, 'day').toISOString();
        const parentEnd = dayjs().add(1, 'day').add(30, 'minute').toISOString();
        const tailStart = dayjs().add(8, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
        const tailEnd = dayjs(tailStart).add(30, 'minute').toISOString();
        const untilCompact = dayjs(tailStart).subtract(1, 'second').utc().format('YYYYMMDD[T]HHmmss[Z]');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-parent',
                    title: 'Weekly sync',
                    timeStart: parentStart,
                    timeEnd: parentEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`],
                },
                {
                    id: 'master-tail',
                    title: 'Weekly sync',
                    timeStart: tailStart,
                    timeEnd: tailEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const tail = await routinesDAO.findOne({ calendarEventId: 'master-tail' });
        expect(tail).not.toBeNull();
        expect(tail!.splitFromRoutineId).toBe('parent-routine');

        const parent = await routinesDAO.findByOwnerAndId('parent-routine', userId);
        expect(parent!.active).toBe(false);
        expect(parent!.rrule).toContain('UNTIL=');
    });

    // Regression for the GCal "this and following + time shift" bug: the tail routine arrived
    // via sync but its calendar items were never generated, because createRoutineFromGCal only
    // stored the routine. Symptom: parent's future items got trashed past UNTIL (correct), tail
    // had zero items, so the user saw "two routines, same name, items missing for the tail".
    it('generates calendar items for the new tail routine when GCal splits with a time shift', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'parent-shift',
                calendarEventId: 'master-parent-shift',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily standup',
                rrule: 'FREQ=DAILY',
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
                updatedTs: oldTs,
            }),
        );

        // Parent retains its original 09:00 timing; tail picks up the same series at 11:00 the next day.
        // Construct in Asia/Jerusalem (the sync config's timezone) so extractLocalTime round-trips
        // to the expected HH:mm regardless of the test runner's local timezone (CI runs in UTC).
        const tz = 'Asia/Jerusalem';
        const parentStart = dayjs().tz(tz).add(1, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
        const parentEnd = dayjs(parentStart).add(30, 'minute').toISOString();
        const tailStart = dayjs().tz(tz).add(2, 'day').hour(11).minute(0).second(0).millisecond(0).toISOString();
        const tailEnd = dayjs(tailStart).add(30, 'minute').toISOString();
        const untilCompact = dayjs(tailStart).subtract(1, 'second').utc().format('YYYYMMDD[T]HHmmss[Z]');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-parent-shift',
                    title: 'Daily standup',
                    timeStart: parentStart,
                    timeEnd: parentEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=DAILY;UNTIL=${untilCompact}`],
                },
                {
                    id: 'master-tail-shift',
                    title: 'Daily standup',
                    timeStart: tailStart,
                    timeEnd: tailEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const tail = await routinesDAO.findOne({ calendarEventId: 'master-tail-shift' });
        expect(tail).not.toBeNull();
        expect(tail!.splitFromRoutineId).toBe('parent-shift');
        expect(tail!.calendarItemTemplate?.timeOfDay).toBe('11:00');

        // The tail must have its future calendar items materialised — otherwise the user sees a
        // routine with no items after the split. All items must use the new 11:00 timeOfDay.
        // item.timeStart is stored as a naive "YYYY-MM-DDTHH:mm:ss" string built directly from the
        // routine's timeOfDay (no offset), so a substring match is the timezone-independent check.
        const tailItems = await itemsDAO.findArray({ user: userId, routineId: tail!._id, status: 'calendar' });
        expect(tailItems.length).toBeGreaterThan(0);
        for (const item of tailItems) {
            expect(item.timeStart).toBeDefined();
            expect(item.timeStart).toMatch(/T11:00:00$/);
        }
    });

    // Regression for the "daily series invisible after split" bug: when GCal splits with an `_R<…>`
    // successor on the SAME bare master, the parent gets a past UNTIL and its overlapping future items
    // are trashed — but those trashed items used to keep their `calendarInstanceEventId`, which still
    // occupied the presence-partial unique index. The successor (sharing the bare master id) then
    // produced the SAME instance ids, so its inserts E11000'd and were silently swallowed → zero items.
    // The cap path must now FREE the instance id so the successor materialises every occurrence.
    it('successor on the same bare master regenerates items the capped parent trashed (instance id freed)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'shared-daily-master';
        const tz = 'Asia/Jerusalem';
        // Parent already active with overlapping future items at 10:00 daily.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'parent-daily',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily standup',
                rrule: 'FREQ=DAILY',
                calendarItemTemplate: { timeOfDay: '10:00', duration: 30 },
                updatedTs: dayjs().subtract(2, 'hour').toISOString(),
            }),
        );
        // Seed a future parent item that collides with the successor's first occurrences.
        const collidingDate = dayjs().tz(tz).add(2, 'day').format('YYYY-MM-DD');
        const collidingInstanceId = `${bareId}_${dayjs.tz(`${collidingDate}T10:00:00`, tz).utc().format('YYYYMMDD[T]HHmmss[Z]')}`;
        await itemsDAO.insertOne({
            _id: 'parent-future-item',
            user: userId,
            status: 'calendar',
            title: 'Daily standup',
            timeStart: `${collidingDate}T10:00:00`,
            timeEnd: `${collidingDate}T10:30:00`,
            routineId: 'parent-daily',
            calendarEventId: bareId,
            calendarInstanceEventId: collidingInstanceId,
            calendarIntegrationId: 'int-1',
            createdTs: dayjs().subtract(2, 'hour').toISOString(),
            updatedTs: dayjs().subtract(2, 'hour').toISOString(),
        });

        // Sync batch: capped base (past UNTIL) + open successor `<bareId>_R<anchor>`, same 10:00 daily.
        const successorStart = dayjs().tz(tz).add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
        const untilCompact = dayjs(successorStart).subtract(1, 'second').utc().format('YYYYMMDD[T]HHmmss[Z]');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: bareId,
                    title: 'Daily standup',
                    timeStart: dayjs().subtract(30, 'day').toISOString(),
                    timeEnd: dayjs().subtract(30, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=DAILY;UNTIL=${untilCompact}`],
                },
                {
                    id: `${bareId}_R20260615T070000`,
                    title: 'Daily standup',
                    timeStart: successorStart,
                    timeEnd: dayjs(successorStart).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-instance-free',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // The parent's colliding item was trashed AND its instance id freed.
        const trashedParentItem = await itemsDAO.findByOwnerAndId('parent-future-item', userId);
        expect(trashedParentItem!.status).toBe('trash');
        expect(trashedParentItem!.calendarInstanceEventId).toBeUndefined();

        // The active successor materialised items — including the previously-colliding date — none swallowed.
        const [successor] = (await routinesDAO.findArray({ user: userId, calendarEventId: bareId, calendarIntegrationId: 'int-1' })).filter((r) => r.active);
        if (!successor) throw new Error('expected an active successor');
        const successorItems = await itemsDAO.findArray({ user: userId, routineId: successor._id, status: 'calendar' });
        expect(successorItems.length).toBeGreaterThan(0);
        expect(successorItems.some((i) => i.calendarInstanceEventId === collidingInstanceId)).toBe(true);
    });

    it('E8 regression: does not link an unrelated master whose start happens to fall within the gap window', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Pre-seed a capped parent routine (already paused by a prior sync).
        const untilIso = dayjs().add(7, 'day').toISOString();
        const untilCompact = dayjs(untilIso).utc().format('YYYYMMDD[T]HHmmss[Z]');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'capped-unrelated',
                calendarEventId: 'master-capped',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Weekly sync',
                rrule: `FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`,
                active: false,
                updatedTs: dayjs().toISOString(),
            }),
        );

        // New, unrelated master: different title, different BYDAY, but start falls inside the 0–1 day window after UNTIL.
        const unrelatedStart = dayjs(untilIso).add(1, 'hour').toISOString();
        const unrelatedEnd = dayjs(unrelatedStart).add(1, 'hour').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-unrelated',
                    title: 'Unrelated event',
                    timeStart: unrelatedStart,
                    timeEnd: unrelatedEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const unrelated = await routinesDAO.findOne({ calendarEventId: 'master-unrelated' });
        expect(unrelated).not.toBeNull();
        expect(unrelated!.splitFromRoutineId).toBeUndefined();
    });

    it('flips active to false when GCal newly adds UNTIL to an existing routine', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-gets-capped',
                calendarEventId: 'master-gets-capped',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Weekly sync',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                active: true,
                updatedTs: oldTs,
            }),
        );

        // Future calendar item that should be trashed by the UNTIL cap.
        const futureItemStart = dayjs().add(30, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'future-item',
            user: userId,
            status: 'calendar',
            title: 'Weekly sync',
            timeStart: futureItemStart,
            timeEnd: dayjs(futureItemStart).add(30, 'minute').toISOString(),
            routineId: 'routine-gets-capped',
            calendarEventId: 'master-gets-capped',
            calendarIntegrationId: 'int-1',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        const untilIso = dayjs().add(7, 'day').toISOString();
        const untilCompact = dayjs(untilIso).utc().format('YYYYMMDD[T]HHmmss[Z]');
        const eventStart = dayjs().add(1, 'day').toISOString();
        const eventEnd = dayjs(eventStart).add(30, 'minute').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-gets-capped',
                    title: 'Weekly sync',
                    timeStart: eventStart,
                    timeEnd: eventEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findByOwnerAndId('routine-gets-capped', userId);
        expect(routine!.active).toBe(false);
        expect(routine!.rrule).toContain('UNTIL=');

        // Future item past UNTIL should be trashed.
        const item = await itemsDAO.findByOwnerAndId('future-item', userId);
        expect(item!.status).toBe('trash');

        // The update operation snapshot should carry active: false so other devices sync it.
        const ops = await operationsDAO.findArray({ entityId: 'routine-gets-capped', entityType: 'routine' });
        const routineUpdateOp = ops.find((op: OperationInterface) => op.opType === 'update');
        expect(routineUpdateOp).toBeDefined();
        expect((routineUpdateOp!.snapshot as RoutineInterface).active).toBe(false);
    });

    it('does not re-flip active on repeat sync of an already-capped, already-inactive parent', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const untilIso = dayjs().add(7, 'day').toISOString();
        const untilCompact = dayjs(untilIso).utc().format('YYYYMMDD[T]HHmmss[Z]');
        const oldTs = dayjs().subtract(2, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'already-capped',
                calendarEventId: 'master-already-capped',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Weekly sync',
                rrule: `FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`,
                active: false,
                updatedTs: oldTs,
            }),
        );

        const eventStart = dayjs().add(1, 'day').toISOString();
        const eventEnd = dayjs(eventStart).add(30, 'minute').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-already-capped',
                    title: 'Weekly sync',
                    timeStart: eventStart,
                    timeEnd: eventEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findByOwnerAndId('already-capped', userId);
        expect(routine!.active).toBe(false);
    });

    it('does not treat a freshly-imported tail as a parent for another freshly-imported tail in the same cycle', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // No pre-existing routine: both events are new this cycle. One carries UNTIL (resembles a
        // capped series) and the other's start falls within the 0–1 day gap — but since neither
        // existed before the import, detectAndLinkSplits must leave both unlinked.
        const tailA_Start = dayjs().add(10, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
        const tailA_End = dayjs(tailA_Start).add(30, 'minute').toISOString();
        const untilCompact = dayjs(tailA_Start).subtract(1, 'second').utc().format('YYYYMMDD[T]HHmmss[Z]');
        const tailB_Start = dayjs(tailA_Start).add(1, 'hour').toISOString();
        const tailB_End = dayjs(tailB_Start).add(30, 'minute').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-new-capped',
                    title: 'Weekly sync',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`],
                },
                {
                    id: 'master-new-tailA',
                    title: 'Weekly sync',
                    timeStart: tailA_Start,
                    timeEnd: tailA_End,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
                },
                {
                    id: 'master-new-tailB',
                    title: 'Weekly sync',
                    timeStart: tailB_Start,
                    timeEnd: tailB_End,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const tailA = await routinesDAO.findOne({ calendarEventId: 'master-new-tailA' });
        const tailB = await routinesDAO.findOne({ calendarEventId: 'master-new-tailB' });
        expect(tailA!.splitFromRoutineId).toBeUndefined();
        expect(tailB!.splitFromRoutineId).toBeUndefined();
    });
});

// ─── Routine startDate ──────────────────────────────────────────────────────

describe('routine startDate', () => {
    it('seriesStartDate uses startDate when set, else createdTs', async () => {
        // Late import to avoid circular load ordering with rrule bundle.
        const { seriesStartDate } = await import('../calendarProviders/GoogleCalendarProvider.js');
        const base = makeRoutine('u-any', { createdTs: '2026-01-01T00:00:00.000Z', rrule: 'FREQ=DAILY' });
        expect(seriesStartDate(base)).toBe('2026-01-01');
        const withStartDate = { ...base, startDate: '2026-06-15' };
        expect(seriesStartDate(withStartDate)).toBe('2026-06-15');
    });

    it('seriesStartDate with startDate > UNTIL throws', async () => {
        const { seriesStartDate } = await import('../calendarProviders/GoogleCalendarProvider.js');
        const routine = makeRoutine('u-any', {
            createdTs: '2026-01-01T00:00:00.000Z',
            startDate: '2026-12-01',
            rrule: 'FREQ=DAILY;UNTIL=20260401T235959Z',
        });
        expect(() => seriesStartDate(routine)).toThrow(/no occurrences/);
    });

    it('createRecurringEvent anchors GCal DTSTART on startDate (not createdTs)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: '2026-01-01T00:00:00.000Z',
            startDate: '2026-06-15',
            rrule: 'FREQ=DAILY',
        });
        await routinesDAO.insertOne(routine);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-new-id');

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        // createRecurringEvent itself computes seriesStartDate internally — we assert it was called
        // with the routine that has startDate set. Trailing options arg (deterministic id) ignored here.
        expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-06-15' }), 'primary', 'Asia/Jerusalem', expect.anything());
    });
});

// ─── Routine pause ───────────────────────────────────────────────────────────

describe('routine pause', () => {
    it('pause pushback caps the GCal master with UNTIL=<yesterday> and leaves eventId stable', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routineActive = makeRoutine(userId, {
            calendarEventId: 'gcal-master-pause',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            active: true,
            updatedTs: '2026-01-01T10:00:00.000Z',
        });
        await routinesDAO.insertOne(routineActive);
        // Seed a prior operation so handleRoutinePush detects the active transition.
        await operationsDAO.insertOne({
            _id: 'op-prior',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-01-01T09:59:00.000Z',
            entityType: 'routine',
            entityId: routineActive._id,
            opType: 'create',
            snapshot: routineActive,
        });

        const capSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockResolvedValue(undefined);
        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringEvent').mockResolvedValue(undefined);

        const pausedSnapshot: RoutineInterface = { ...routineActive, active: false, updatedTs: '2026-01-01T11:00:00.000Z' };
        await routinesDAO.replaceById(routineActive._id, pausedSnapshot);
        await maybePushToGCal(
            makeOp(userId, { entityType: 'routine', entityId: pausedSnapshot._id, snapshot: pausedSnapshot, ts: '2026-01-01T11:00:00.000Z' }),
            mockBuildProvider(),
        );

        expect(capSpy).toHaveBeenCalledOnce();
        expect(capSpy).toHaveBeenCalledWith('gcal-master-pause', expect.stringMatching(/^\d{8}T235959Z$/), 'primary', 'Asia/Jerusalem');
        // steady-state updateRecurringEvent must NOT fire alongside the cap.
        expect(updateSpy).not.toHaveBeenCalled();
    });

    it('pause pushback trashes future items and leaves past/done items alone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            _id: 'routine-pause-items',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            active: true,
            updatedTs: '2026-01-02T10:00:00.000Z',
        });
        await routinesDAO.insertOne(routine);
        // Seed prior op with active=true.
        await operationsDAO.insertOne({
            _id: 'op-prior-2',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-01-02T09:59:00.000Z',
            entityType: 'routine',
            entityId: routine._id,
            opType: 'create',
            snapshot: routine,
        });

        const todayStr = dayjs().startOf('day').format('YYYY-MM-DD');
        const yesterdayStr = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
        const tomorrowStr = dayjs().add(1, 'day').format('YYYY-MM-DD');
        await itemsDAO.insertMany([
            {
                _id: 'past-done',
                user: userId,
                status: 'done',
                title: 'past-done',
                routineId: routine._id,
                timeStart: `${yesterdayStr}T09:00:00`,
                createdTs: yesterdayStr,
                updatedTs: yesterdayStr,
            },
            {
                _id: 'future-calendar',
                user: userId,
                status: 'calendar',
                title: 'future',
                routineId: routine._id,
                timeStart: `${tomorrowStr}T09:00:00`,
                createdTs: todayStr,
                updatedTs: todayStr,
            },
        ]);

        vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockResolvedValue(undefined);

        const pausedSnapshot: RoutineInterface = { ...routine, active: false, updatedTs: '2026-01-02T11:00:00.000Z' };
        await routinesDAO.replaceById(routine._id, pausedSnapshot);
        await maybePushToGCal(
            makeOp(userId, { entityType: 'routine', entityId: pausedSnapshot._id, snapshot: pausedSnapshot, ts: '2026-01-02T11:00:00.000Z' }),
            mockBuildProvider(),
        );

        const future = await itemsDAO.findByOwnerAndId('future-calendar', userId);
        const past = await itemsDAO.findByOwnerAndId('past-done', userId);
        expect(future!.status).toBe('trash');
        expect(past!.status).toBe('done'); // untouched
    });

    it('capRecurringEvent strips existing UNTIL/COUNT and appends the new UNTIL (unit-level)', async () => {
        const { rrulePinnedUntil } = await import('../calendarProviders/GoogleCalendarProvider.js');
        // Pre-existing UNTIL — rewritten.
        expect(rrulePinnedUntil('RRULE:FREQ=DAILY;UNTIL=20260301T235959Z', '20260423T235959Z')).toBe('RRULE:FREQ=DAILY;UNTIL=20260423T235959Z');
        // Pre-existing COUNT — stripped (UNTIL and COUNT are mutually exclusive).
        expect(rrulePinnedUntil('RRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO', '20260423T235959Z')).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260423T235959Z');
        // No prior cap.
        expect(rrulePinnedUntil('RRULE:FREQ=DAILY', '20260423T235959Z')).toBe('RRULE:FREQ=DAILY;UNTIL=20260423T235959Z');
    });

    it('resume pushback: fires updateRecurringEvent (clears UNTIL) and regenerates future items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Routine currently paused (active=false). Prior op is the pause; the NEW op flips active=true.
        const pausedRoutine = makeRoutine(userId, {
            _id: 'routine-resume',
            calendarEventId: 'gcal-master-resume',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            active: false,
            updatedTs: '2026-01-05T09:00:00.000Z',
        });
        await routinesDAO.insertOne(pausedRoutine);
        await operationsDAO.insertOne({
            _id: 'op-paused-prior',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-01-05T09:00:00.000Z',
            entityType: 'routine',
            entityId: pausedRoutine._id,
            opType: 'update',
            snapshot: pausedRoutine,
        });

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringEvent').mockResolvedValue(undefined);
        const capSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockResolvedValue(undefined);

        const resumedSnapshot: RoutineInterface = { ...pausedRoutine, active: true, updatedTs: '2026-01-05T11:00:00.000Z' };
        await routinesDAO.replaceById(pausedRoutine._id, resumedSnapshot);
        await maybePushToGCal(
            makeOp(userId, {
                _id: 'op-resume-current',
                entityType: 'routine',
                entityId: resumedSnapshot._id,
                snapshot: resumedSnapshot,
                ts: '2026-01-05T11:00:00.000Z',
            }),
            mockBuildProvider(),
        );

        expect(updateSpy).toHaveBeenCalledOnce();
        expect(capSpy).not.toHaveBeenCalled();
    });

    it('two back-to-back pause ops: cap fires exactly once (second op sees first as prior)', async () => {
        // I7 regression: when two pause ops land in quick succession for the same routine (e.g. from
        // two flush batches), the pre-fix `readPriorActiveFlag` excluded only the current op by _id.
        // That made BOTH pause ops see each other as "prior" and infer priorActive=false → no
        // transition → skip cap. Result: GCal master never gets UNTIL, and the live pause in the I7
        // smoke case left the recurring series un-capped. Strictly-before (ts, _id) ordering fixes it.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routineActive = makeRoutine(userId, {
            _id: 'routine-double-pause',
            calendarEventId: 'gcal-master-double',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            active: true,
            updatedTs: '2026-04-24T18:59:00.000Z',
        });
        await routinesDAO.insertOne(routineActive);
        await operationsDAO.insertOne({
            _id: 'op-prior-active',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-04-24T18:59:00.000Z',
            entityType: 'routine',
            entityId: routineActive._id,
            opType: 'create',
            snapshot: routineActive,
        });

        const capSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockResolvedValue(undefined);

        // First pause op lands (ts = 19:00:00.219Z, matching the live repro).
        const pausedSnapshot: RoutineInterface = { ...routineActive, active: false, updatedTs: '2026-04-24T19:00:00.219Z' };
        await routinesDAO.replaceById(routineActive._id, pausedSnapshot);
        const pauseOp1: OperationInterface = {
            _id: 'op-pause-1',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-04-24T19:00:00.219Z',
            entityType: 'routine',
            entityId: pausedSnapshot._id,
            opType: 'update',
            snapshot: pausedSnapshot,
        };
        await operationsDAO.insertOne(pauseOp1);
        await maybePushToGCal(pauseOp1, mockBuildProvider());

        // Second pause op lands (ts = 19:00:00.435Z) — same snapshot (active still false).
        const pauseOp2: OperationInterface = {
            _id: 'op-pause-2',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-04-24T19:00:00.435Z',
            entityType: 'routine',
            entityId: pausedSnapshot._id,
            opType: 'update',
            snapshot: { ...pausedSnapshot, updatedTs: '2026-04-24T19:00:00.435Z' },
        };
        await operationsDAO.insertOne(pauseOp2);
        await maybePushToGCal(pauseOp2, mockBuildProvider());

        expect(capSpy).toHaveBeenCalledOnce();
        expect(capSpy).toHaveBeenCalledWith('gcal-master-double', expect.stringMatching(/^\d{8}T235959Z$/), 'primary', 'Asia/Jerusalem');
    });

    it('readPriorActiveFlag: same-updatedTs collision is resolved by op._id, not timestamp', async () => {
        // Two devices pushed concurrently and produced ops with identical updatedTs on the routine
        // snapshot. The prior op is the active=true create; the new op flips to active=false.
        // Classifying by updatedTs would fail to exclude the new op; classifying by op._id succeeds.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const sharedUpdatedTs = '2026-01-06T10:00:00.000Z';
        const routineCreate = makeRoutine(userId, {
            _id: 'routine-collision',
            calendarEventId: 'gcal-master-collision',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            active: true,
            updatedTs: sharedUpdatedTs,
        });
        await routinesDAO.insertOne(routineCreate);
        await operationsDAO.insertOne({
            _id: 'op-create',
            user: userId,
            deviceId: 'device-1',
            ts: sharedUpdatedTs,
            entityType: 'routine',
            entityId: routineCreate._id,
            opType: 'create',
            snapshot: routineCreate,
        });

        const capSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockResolvedValue(undefined);

        // New op: same updatedTs, but active=false. Must be recognized as a transition → cap.
        const pausedSnapshot: RoutineInterface = { ...routineCreate, active: false };
        await routinesDAO.replaceById(routineCreate._id, pausedSnapshot);
        await maybePushToGCal(
            makeOp(userId, {
                _id: 'op-pause-collision',
                entityType: 'routine',
                entityId: pausedSnapshot._id,
                snapshot: pausedSnapshot,
                ts: sharedUpdatedTs,
            }),
            mockBuildProvider(),
        );

        expect(capSpy).toHaveBeenCalledOnce();
    });

    it('pause batch with N concurrent item-trash ops: cap fires; per-instance cancellations are skipped', async () => {
        // Regression: when the user pauses a routine, the client emits one routine-pause op plus
        // N item-trash ops for the future generated items in a single sync-push batch. All N+1
        // pushbacks ran in parallel. The N parallel `cancelRecurringInstance` patches against GCal
        // raced with `capRecurringEvent` and dropped the just-written UNTIL from the master's
        // recurrence. Fix: when the routine is paused, skip per-instance cancellations entirely —
        // the cap covers them.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routineActive = makeRoutine(userId, {
            _id: 'routine-batch-pause',
            calendarEventId: 'gcal-master-batch-pause',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            active: true,
            updatedTs: '2026-01-10T09:00:00.000Z',
        });
        await routinesDAO.insertOne(routineActive);
        // Seed prior op (active=true) so handleRoutinePush sees the active→inactive transition.
        await operationsDAO.insertOne({
            _id: 'op-batch-prior',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-01-10T09:00:00.000Z',
            entityType: 'routine',
            entityId: routineActive._id,
            opType: 'create',
            snapshot: routineActive,
        });

        // Mirror the client batch: routine flips to active=false in the DB BEFORE pushbacks run
        // (sync.ts applies entity ops before fanning out push-back). Each item-trash op carries a
        // routine-generated calendar item snapshot.
        const pausedSnapshot: RoutineInterface = { ...routineActive, active: false, updatedTs: '2026-01-10T10:00:00.000Z' };
        await routinesDAO.replaceById(routineActive._id, pausedSnapshot);

        const capSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockResolvedValue(undefined);
        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        const itemCount = 5;
        const itemOps: OperationInterface[] = Array.from({ length: itemCount }, (_, i) => {
            const day = dayjs('2026-01-11').add(i, 'day').format('YYYY-MM-DD');
            const trashedItem: ItemInterface = {
                _id: `item-trash-${i}`,
                user: userId,
                status: 'trash',
                title: `Standup ${day}`,
                routineId: routineActive._id,
                timeStart: `${day}T09:00:00`,
                timeEnd: `${day}T09:30:00`,
                createdTs: '2026-01-10T08:00:00.000Z',
                updatedTs: '2026-01-10T10:00:00.000Z',
            };
            return {
                _id: `op-trash-${i}`,
                user: userId,
                deviceId: 'device-1',
                ts: '2026-01-10T10:00:00.000Z',
                entityType: 'item',
                entityId: trashedItem._id!,
                opType: 'update',
                snapshot: trashedItem,
            };
        });
        const pauseOp: OperationInterface = {
            _id: 'op-batch-pause',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-01-10T10:00:00.000Z',
            entityType: 'routine',
            entityId: pausedSnapshot._id,
            opType: 'update',
            snapshot: pausedSnapshot,
        };
        await operationsDAO.insertMany([...itemOps, pauseOp]);

        // Fan out pushbacks in parallel — same shape as sync.ts line 200.
        await Promise.all([...itemOps, pauseOp].map((op) => maybePushToGCal(op, mockBuildProvider())));

        expect(capSpy).toHaveBeenCalledOnce();
        expect(capSpy).toHaveBeenCalledWith('gcal-master-batch-pause', expect.stringMatching(/^\d{8}T235959Z$/), 'primary', 'Asia/Jerusalem');
        // Per-instance cancellations must be skipped when the routine is paused — racing them
        // against the cap caused GCal to drop UNTIL from the master.
        expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('resume heals stale link AND regenerated items inherit the healed integration ids (not the dead snapshot ids)', async () => {
        // Regression for the resume-side mirror of the disconnect/reconnect bug:
        // pushRoutineResume calls pushExistingRoutineToGCal first → resolvePushContext heals the
        // routine row in place. Without the in-resume re-read, regenerateFutureRoutineItems uses
        // the stale in-memory snapshot and stamps the gone integration ids onto every fresh item.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Current (post-reconnect) integration + default config.
        await insertIntegrationWithConfig(userId);

        // Paused routine pointing at the gone integration. Daily rrule + 09:00 timed template so
        // resume regenerates at least one occurrence inside the 2-month horizon.
        const pausedRoutine = makeRoutine(userId, {
            _id: 'routine-stale-resume',
            calendarEventId: 'gcal-master-stale-resume',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            active: false,
            rrule: 'FREQ=DAILY',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            updatedTs: '2026-01-10T09:00:00.000Z',
        });
        await routinesDAO.insertOne(pausedRoutine);
        await operationsDAO.insertOne({
            _id: 'op-paused-stale-prior',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-01-10T09:00:00.000Z',
            entityType: 'routine',
            entityId: pausedRoutine._id,
            opType: 'update',
            snapshot: pausedRoutine,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringEvent').mockResolvedValue(undefined);

        const resumedSnapshot: RoutineInterface = { ...pausedRoutine, active: true, updatedTs: '2026-01-10T11:00:00.000Z' };
        await routinesDAO.replaceById(pausedRoutine._id, resumedSnapshot);
        await maybePushToGCal(
            makeOp(userId, {
                _id: 'op-resume-stale-current',
                entityType: 'routine',
                entityId: resumedSnapshot._id,
                snapshot: resumedSnapshot,
                ts: '2026-01-10T11:00:00.000Z',
            }),
            mockBuildProvider(),
        );

        // Routine row itself was healed by pushExistingRoutineToGCal.
        const healedRoutine = await routinesDAO.findByOwnerAndId(pausedRoutine._id, userId);
        expect(healedRoutine!.calendarIntegrationId).toBe('int-1');
        expect(healedRoutine!.calendarSyncConfigId).toBe('sync-config-1');

        // The actual regression: every regenerated calendar item must reference the HEALED ids,
        // not the dead snapshot ids. Pre-fix, they would all be stamped 'int-old' / 'sync-config-old'.
        const generated = await itemsDAO.findArray({ user: userId, routineId: pausedRoutine._id, status: 'calendar' });
        expect(generated.length).toBeGreaterThan(0);
        for (const item of generated) {
            expect(item.calendarIntegrationId).toBe('int-1');
            expect(item.calendarSyncConfigId).toBe('sync-config-1');
        }
    });
});

// ─── invalid_grant escalation ────────────────────────────────────────────────

describe('integration auth status — sync, pushback, OAuth reconnect', () => {
    it('returns HTTP 410 + integration_revoked from the sync endpoint when status=revoked', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const revokedAt = dayjs().toISOString();
        const suspendedAt = dayjs().subtract(25, 'hour').toISOString();
        await insertIntegrationWithConfig(userId, { status: 'revoked', suspendedAt, revokedAt });

        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });

        expect(res.status).toBe(410);
        const body = (await res.json()) as { error: string; integrationId: string; revokedAt: string; suspendedAt: string };
        expect(body.error).toBe('integration_revoked');
        expect(body.integrationId).toBe('int-1');
        expect(body.revokedAt).toBe(revokedAt);
        expect(body.suspendedAt).toBe(suspendedAt);
        // No provider call attempted — short-circuit before sync.
        expect(watchSpy).not.toHaveBeenCalled();
    });

    it('pushback against a suspended integration is a no-op (no GCal calls)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const suspendedAt = dayjs().toISOString();
        await insertIntegrationWithConfig(userId, { status: 'suspended', suspendedAt });

        const item: ItemInterface = {
            _id: 'item-1',
            user: userId,
            title: 'Edited locally',
            status: 'calendar',
            timeStart: '2026-06-01T10:00:00Z',
            timeEnd: '2026-06-01T10:30:00Z',
            calendarEventId: 'gcal-evt-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        };
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();
        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue();

        const op: OperationInterface = {
            _id: 'op-1',
            user: userId,
            entityType: 'item',
            entityId: 'item-1',
            opType: 'update',
            ts: dayjs().toISOString(),
            snapshot: item,
        };
        await maybePushToGCal(
            op,
            () => new GoogleCalendarProvider({ accessToken: 'at', refreshToken: 'rt', tokenExpiry: dayjs().toISOString() }, async () => {}),
        );

        // Both `provider.updateEvent` and `provider.deleteEvent` must NOT be called — the suspended
        // status short-circuits inside resolvePushContext.
        expect(updateSpy).not.toHaveBeenCalled();
        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('OAuth reconnect (upsertEncrypted) flips a revoked row back to active and unsets escalation timestamps', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Seed an existing revoked integration for this user.
        await calendarIntegrationsDAO.insertEncrypted(
            makeIntegration(userId, {
                status: 'revoked',
                suspendedAt: dayjs().subtract(2, 'day').toISOString(),
                revokedAt: dayjs().subtract(1, 'day').toISOString(),
                lastAuthErrorAt: dayjs().subtract(1, 'day').toISOString(),
            }),
        );

        // Simulate the OAuth callback: upsertEncrypted is what the callback ultimately calls.
        const now = dayjs().toISOString();
        await calendarIntegrationsDAO.upsertEncrypted({
            _id: 'int-1',
            user: userId,
            provider: 'google',
            accessToken: 'fresh-at',
            refreshToken: 'fresh-rt',
            tokenExpiry: dayjs().add(1, 'hour').toISOString(),
            createdTs: now,
            updatedTs: now,
        });

        const refreshed = await calendarIntegrationsDAO.findById('int-1');
        expect(refreshed?.status).toBe('active');
        expect(refreshed?.suspendedAt).toBeUndefined();
        expect(refreshed?.revokedAt).toBeUndefined();
        expect(refreshed?.lastAuthErrorAt).toBeUndefined();
    });
});

// ─── lastKnown* rename + strong-key restore on reconnect ───────────────────

describe('disconnect/reconnect — lastKnownCalendar* rename and strong-key restore', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('unlinkItems renames calendar* fields to lastKnown* instead of unsetting them', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-rename-keep',
            user: userId,
            status: 'calendar',
            title: 'Strong-key relink target',
            calendarEventId: 'gcal-keep-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: now,
            updatedTs: now,
        });

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-rename-keep' });
        expect(item?.status).toBe('calendar');
        expect(item?.calendarEventId).toBeUndefined();
        expect(item?.calendarIntegrationId).toBeUndefined();
        expect(item?.calendarSyncConfigId).toBeUndefined();
        expect(item?.lastKnownCalendarEventId).toBe('gcal-keep-1');
        expect(item?.lastKnownCalendarIntegrationId).toBe('int-1');
        expect(item?.lastKnownCalendarSyncConfigId).toBe('sync-config-1');
    });

    it('unlinkRoutines renames calendar* fields to lastKnown*', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        await routinesDAO.insertOne(
            makeRoutine(userId, { calendarEventId: 'gcal-master-keep', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' }),
        );

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ _id: 'routine-1' });
        expect(routine?.calendarEventId).toBeUndefined();
        expect(routine?.calendarIntegrationId).toBeUndefined();
        expect(routine?.calendarSyncConfigId).toBeUndefined();
        expect(routine?.lastKnownCalendarEventId).toBe('gcal-master-keep');
        expect(routine?.lastKnownCalendarIntegrationId).toBe('int-1');
        expect(routine?.lastKnownCalendarSyncConfigId).toBe('sync-config-1');
    });

    it('trashItemsForIntegration renames calendar* fields to lastKnown* on done items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-done-rename',
            user: userId,
            status: 'done',
            title: 'Already done',
            calendarEventId: 'gcal-done-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: now,
            updatedTs: now,
        });

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=removeLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const done = await itemsDAO.findOne({ _id: 'item-done-rename' });
        expect(done?.status).toBe('done');
        expect(done?.calendarEventId).toBeUndefined();
        expect(done?.lastKnownCalendarEventId).toBe('gcal-done-1');
        expect(done?.lastKnownCalendarIntegrationId).toBe('int-1');
        expect(done?.lastKnownCalendarSyncConfigId).toBe('sync-config-1');
    });

    it('upsertCalendarItem restores an item by lastKnownCalendarEventId on inbound match (single op, fields swap)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureStart = dayjs().add(1, 'day').startOf('hour').toISOString();
        const futureEnd = dayjs(futureStart).add(1, 'hour').toISOString();
        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        // Item carries lastKnown* but no live calendar* — the rename-on-disconnect state.
        await itemsDAO.insertOne({
            _id: 'item-restore-1',
            user: userId,
            status: 'calendar',
            title: 'Restore me',
            timeStart: futureStart,
            timeEnd: futureEnd,
            createdTs: oldTs,
            updatedTs: oldTs,
            lastKnownCalendarEventId: 'gcal-restore-1',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-1',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-restore-1',
                    title: 'Restore me',
                    timeStart: futureStart,
                    timeEnd: futureEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-restore',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const all = await itemsDAO.findArray({ user: userId, title: 'Restore me' });
        expect(all).toHaveLength(1);
        const [restored] = all;
        if (!restored) throw new Error('expected one restored item');
        expect(restored._id).toBe('item-restore-1');
        expect(restored.calendarEventId).toBe('gcal-restore-1');
        expect(restored.calendarIntegrationId).toBe('int-1');
        expect(restored.calendarSyncConfigId).toBe('sync-config-1');
        expect(restored.lastKnownCalendarEventId).toBeUndefined();
        expect(restored.lastKnownCalendarIntegrationId).toBeUndefined();
        expect(restored.lastKnownCalendarSyncConfigId).toBeUndefined();
    });

    it('tryRestoreFromLastKnownEventId is TOCTOU-safe: a race interleaved between findArray and updateOne lets one writer win and the other fall through', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureStart = dayjs().add(1, 'day').startOf('hour').toISOString();
        const futureEnd = dayjs(futureStart).add(1, 'hour').toISOString();
        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-toctou',
            user: userId,
            status: 'calendar',
            title: 'TOCTOU me',
            timeStart: futureStart,
            timeEnd: futureEnd,
            createdTs: oldTs,
            updatedTs: oldTs,
            lastKnownCalendarEventId: 'gcal-toctou-1',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-1',
        });

        // Interleave a competing mutation between findArray (which already located the candidate)
        // and the conditional updateOne (which checks the `lastKnownCalendarEventId` guard).
        // Spy on itemsDAO.updateOne: when the restore's conditional update fires, apply the rival
        // claim first — that flips the candidate's markers, so the real updateOne matches 0 docs
        // and the restore returns undefined. The caller then falls through to the naked/create path.
        const realUpdateOne = itemsDAO.updateOne.bind(itemsDAO);
        vi.spyOn(itemsDAO, 'updateOne').mockImplementation(async (filter, update, options) => {
            type FilterShape = { lastKnownCalendarEventId?: string };
            const matchesRestoreGuard = (filter as FilterShape).lastKnownCalendarEventId === 'gcal-toctou-1';
            if (matchesRestoreGuard) {
                // Rival webhook restored the item first — clears the markers and binds the calendar* fields.
                await realUpdateOne(
                    { _id: 'item-toctou', user: userId },
                    {
                        $set: { calendarEventId: 'gcal-toctou-1', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' },
                        $unset: { lastKnownCalendarEventId: '', lastKnownCalendarIntegrationId: '', lastKnownCalendarSyncConfigId: '' },
                    },
                );
            }
            return await realUpdateOne(filter, update, options);
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-toctou-1',
                    title: 'TOCTOU me',
                    timeStart: futureStart,
                    timeEnd: futureEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-toctou',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // The rival's restore wins → the loser's `tryRestoreFromLastKnownEventId` returns undefined and
        // falls through to the create path. That insert now collides on the unique
        // `(user, calendarEventId)` index (rival already bound the live row) → the E11000 catch in
        // `createNewCalendarItem` re-resolves to the rival's row and merges into it instead of producing
        // a duplicate. Net: exactly ONE live item carries the event — strictly better than the old
        // "better duplicate than silent overwrite" fallback this test previously documented.
        const all = await itemsDAO.findArray({ user: userId, title: 'TOCTOU me', status: 'calendar' });
        expect(all).toHaveLength(1);
        const [restored] = all;
        if (!restored) throw new Error('expected the rival-bound item to survive');
        expect(restored._id).toBe('item-toctou');
        expect(restored.calendarEventId).toBe('gcal-toctou-1');
        expect(restored.lastKnownCalendarEventId).toBeUndefined();
    });

    it('cancelled inbound event matching lastKnown* emits no restore op and no status flap', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        // Item carries lastKnown* markers but no live calendar* — the disconnect-with-keep state.
        await itemsDAO.insertOne({
            _id: 'item-cancel-marker',
            user: userId,
            status: 'calendar',
            title: 'Marker-only — cancelled inbound',
            timeStart: dayjs().add(1, 'day').toISOString(),
            timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
            createdTs: oldTs,
            updatedTs: oldTs,
            lastKnownCalendarEventId: 'gcal-cancel-1',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-1',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-cancel-1',
                    title: 'Marker-only — cancelled inbound',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'cancelled',
                },
            ],
            nextSyncToken: 'tok-cancel',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // The item is untouched: cancelled short-circuits BEFORE the restore. No restore op, no
        // trash op, no live calendar* binding. The markers also stay put — the disconnect-with-keep
        // contract is preserved across cancelled inbound events.
        const item = await itemsDAO.findOne({ _id: 'item-cancel-marker' });
        expect(item?.status).toBe('calendar');
        expect(item?.calendarEventId).toBeUndefined();
        expect(item?.lastKnownCalendarEventId).toBe('gcal-cancel-1');
    });

    it('past inbound event matching lastKnown* emits no restore op and no status flap', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(2, 'day').toISOString();
        // Past event window — anchor in the previous day so cutoffIso is strictly after timeEnd.
        const pastStart = dayjs().subtract(2, 'day').startOf('hour').toISOString();
        const pastEnd = dayjs(pastStart).add(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-past-marker',
            user: userId,
            status: 'calendar',
            title: 'Marker-only — past inbound',
            timeStart: pastStart,
            timeEnd: pastEnd,
            createdTs: oldTs,
            updatedTs: oldTs,
            lastKnownCalendarEventId: 'gcal-past-1',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-1',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-past-1',
                    title: 'Marker-only — past inbound',
                    timeStart: pastStart,
                    timeEnd: pastEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-past',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Past-event branch short-circuits before the restore: no live calendar* binding, markers preserved.
        const item = await itemsDAO.findOne({ _id: 'item-past-marker' });
        expect(item?.status).toBe('calendar');
        expect(item?.calendarEventId).toBeUndefined();
        expect(item?.lastKnownCalendarEventId).toBe('gcal-past-1');
    });

    it('routine cancelled master matching lastKnown* skips restore and goes straight to deactivate', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Active routine carrying lastKnown* markers — the disconnect-with-keep state.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-cancel-marker',
                active: true,
                lastKnownCalendarEventId: 'gcal-master-cancel',
                lastKnownCalendarIntegrationId: 'int-1',
                lastKnownCalendarSyncConfigId: 'sync-config-1',
            }),
        );

        // Inbound recurring master event for the SAME id with status:'cancelled'.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-cancel',
                    title: makeRoutine(userId).title,
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'cancelled',
                    recurrence: [`RRULE:${makeRoutine(userId).rrule}`],
                },
            ],
            nextSyncToken: 'tok-routine-cancel',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Restore was skipped (no calendar* fields bound) — and since the routine was never restored,
        // the deactivate branch fell through with nothing to deactivate. Markers remain intact.
        const routine = await routinesDAO.findOne({ _id: 'routine-cancel-marker' });
        expect(routine?.calendarEventId).toBeUndefined();
        expect(routine?.lastKnownCalendarEventId).toBe('gcal-master-cancel');
        expect(routine?.active).toBe(true);
    });

    it('reconnect: legacy (unstamped) lastKnown* markers with a dead integration id are left intact', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        // Seed the prior disconnect state: an item AND a routine both carry markers pointing at the
        // OLD integration id (which the user has since disconnected). No live integration row exists.
        // Neither marker carries lastKnownCalendarAccountEmail (legacy, pre-stamping rows) — the
        // reconcile pass can't prove same-account, so under leave-unlinked it must NOT touch them.
        // They heal later via the relink paths, which accept email-less markers best-effort when the
        // event actually resolves (inbound strong-key restore, or the active sweep's found-event branch).
        const oldTs = dayjs().subtract(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-orphan',
            user: userId,
            status: 'calendar',
            title: 'Orphaned marker',
            timeStart: dayjs().add(1, 'day').toISOString(),
            timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
            createdTs: oldTs,
            updatedTs: oldTs,
            lastKnownCalendarEventId: 'gcal-orphan-1',
            lastKnownCalendarIntegrationId: 'int-OLD-account',
            lastKnownCalendarSyncConfigId: 'sync-config-OLD',
        });
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-orphan',
                lastKnownCalendarEventId: 'gcal-orphan-master',
                lastKnownCalendarIntegrationId: 'int-OLD-account',
                lastKnownCalendarSyncConfigId: 'sync-config-OLD',
            }),
        );

        // Drive the OAuth callback for a NEW integration (different account, different integration id).
        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;
        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'new-at', refresh_token: 'new-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        mockUserInfoEmail('alice@example.com');

        const res = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(res.status).toBe(302);

        // Reconnect produced exactly one integration row, with a fresh id distinct from 'int-OLD-account'.
        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        expect(integrations).toHaveLength(1);
        const liveIntegration = integrations[0];
        if (!liveIntegration) throw new Error('expected one live integration');
        expect(liveIntegration._id).not.toBe('int-OLD-account');
        // Redirect carries the live integration id so the client picker targets the real row.
        expect(res.headers.get('location')).toContain(`calendarConnected=${liveIntegration._id}`);

        // Leave-unlinked: the markers persist verbatim. Wiping them would irreversibly sever the
        // original events (an A→B→A round-trip could no longer relink) and re-arm the outbound
        // backfill into minting clone events on the new account's calendar.
        const orphanItem = await itemsDAO.findOne({ _id: 'item-orphan' });
        expect(orphanItem?.lastKnownCalendarEventId).toBe('gcal-orphan-1');
        expect(orphanItem?.lastKnownCalendarIntegrationId).toBe('int-OLD-account');
        expect(orphanItem?.lastKnownCalendarSyncConfigId).toBe('sync-config-OLD');
        const orphanRoutine = await routinesDAO.findOne({ _id: 'routine-orphan' });
        expect(orphanRoutine?.lastKnownCalendarEventId).toBe('gcal-orphan-master');
        expect(orphanRoutine?.lastKnownCalendarIntegrationId).toBe('int-OLD-account');
        expect(orphanRoutine?.lastKnownCalendarSyncConfigId).toBe('sync-config-OLD');

        // No repair ops either — nothing changed, so peers must not be told anything.
        const itemOps = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-orphan' });
        expect(itemOps).toHaveLength(0);
        const routineOps = await operationsDAO.findArray({ user: userId, entityType: 'routine', entityId: 'routine-orphan' });
        expect(routineOps).toHaveLength(0);
    });

    it('double disconnect without reconnect preserves the originally-stored lastKnownCalendarEventId on routines', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        // Pre-existing routine state: a prior disconnect already renamed `calendarEventId` →
        // `lastKnownCalendarEventId`. The routine row keeps a `calendarIntegrationId` (stale; the
        // integration was reconnected without the repair pass clearing it) so it's still discoverable
        // by the integration-scoped lookup in the next DELETE — but its `calendarEventId` is gone.
        // The defensive `calendarEventId: { $exists: true }` filter ensures the second rename does
        // NOT clobber the previously-stored lastKnownCalendarEventId.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-double-disconnect',
                calendarIntegrationId: 'int-1', // still linked at the integration level
                lastKnownCalendarEventId: 'gcal-first-link-PRESERVE',
                lastKnownCalendarIntegrationId: 'int-PRIOR',
                lastKnownCalendarSyncConfigId: 'sync-config-PRIOR',
                // calendarEventId intentionally undefined — already renamed by an earlier disconnect.
            }),
        );

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ _id: 'routine-double-disconnect' });
        expect(routine?.lastKnownCalendarEventId).toBe('gcal-first-link-PRESERVE');
        expect(routine?.calendarEventId).toBeUndefined();
    });

    it('removeLinkedEntities renames routine calendar* fields to lastKnown* and deactivates, recording the renamed snapshot', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId, { accountEmail: 'Alice@Example.com' }));
        await routinesDAO.insertOne(
            makeRoutine(userId, { calendarEventId: 'gcal-master-remove', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' }),
        );

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=removeLinkedEntities',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ _id: 'routine-1' });
        expect(routine?.active).toBe(false);
        expect(routine?.calendarEventId).toBeUndefined();
        expect(routine?.calendarIntegrationId).toBeUndefined();
        expect(routine?.calendarSyncConfigId).toBeUndefined();
        expect(routine?.lastKnownCalendarEventId).toBe('gcal-master-remove');
        expect(routine?.lastKnownCalendarIntegrationId).toBe('int-1');
        expect(routine?.lastKnownCalendarSyncConfigId).toBe('sync-config-1');
        // Lowercased origin-account stamp — lets a later reconnect distinguish same-account (restore)
        // from cross-account (wipe).
        expect(routine?.lastKnownCalendarAccountEmail).toBe('alice@example.com');

        // The recorded op must advertise the RENAMED + deactivated state — recording the pre-rename
        // snapshot would propagate the stale still-linked state to other devices.
        const ops = await operationsDAO.findArray({ user: userId, entityType: 'routine', entityId: 'routine-1' });
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one routine op');
        expect(op.opType).toBe('update');
        const snapshot = op.snapshot as RoutineInterface | null;
        expect(snapshot?.active).toBe(false);
        expect(snapshot?.calendarEventId).toBeUndefined();
        expect(snapshot?.lastKnownCalendarEventId).toBe('gcal-master-remove');
    });

    it('same-account reconnect after removeLinkedEntities restores the deactivated routine (no twin) and regenerates items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Post-remove-disconnect state: deactivated routine whose markers point at the DELETED
        // integration id. The reconnect minted a brand-new integration id (int-1 below).
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-restore-remove',
                active: false,
                lastKnownCalendarEventId: 'gcal-master-restore',
                lastKnownCalendarIntegrationId: 'int-DELETED',
                lastKnownCalendarSyncConfigId: 'sync-config-DELETED',
                lastKnownCalendarAccountEmail: 'alice@example.com',
                updatedTs: dayjs().subtract(3, 'day').toISOString(),
            }),
        );
        await insertIntegrationWithConfig(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-restore',
                    title: 'Standup',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-restore',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // The SAME routine doc is restored — reactivated and relinked to the new integration ids.
        const routines = await routinesDAO.findArray({ user: userId });
        expect(routines).toHaveLength(1);
        const [restored] = routines;
        if (!restored) throw new Error('expected the restored routine');
        expect(restored._id).toBe('routine-restore-remove');
        expect(restored.active).toBe(true);
        expect(restored.calendarEventId).toBe('gcal-master-restore');
        expect(restored.calendarIntegrationId).toBe('int-1');
        expect(restored.calendarSyncConfigId).toBe('sync-config-1');
        expect(restored.lastKnownCalendarEventId).toBeUndefined();
        expect(restored.lastKnownCalendarIntegrationId).toBeUndefined();
        expect(restored.lastKnownCalendarSyncConfigId).toBeUndefined();
        expect(restored.lastKnownCalendarAccountEmail).toBeUndefined();

        // The disconnect cascade trashed all generated items — reactivation must rebuild them.
        const regenerated = await itemsDAO.findArray({ user: userId, routineId: 'routine-restore-remove', status: 'calendar' });
        expect(regenerated.length).toBeGreaterThan(0);
    });

    it('cross-account reconnect leaves remove-mode markers intact and imports a fresh routine instead of hijacking', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        // Remove-mode disconnect state left by the WORK account.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-work-orphan',
                active: false,
                updatedTs: dayjs().subtract(3, 'day').toISOString(),
                lastKnownCalendarEventId: 'gcal-work-master',
                lastKnownCalendarIntegrationId: 'int-WORK',
                lastKnownCalendarSyncConfigId: 'sync-config-WORK',
                lastKnownCalendarAccountEmail: 'work@example.com',
            }),
        );
        // A leftover generated item still carrying an instance id derived from the WORK master —
        // under leave-unlinked it persists too: its routine stays unlinked, so it never participates
        // in the new account's exception sync and the stale id is inert.
        const oldTs = dayjs().subtract(3, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-work-orphan-instance',
            user: userId,
            status: 'trash',
            title: 'Standup',
            routineId: 'routine-work-orphan',
            calendarInstanceEventId: 'gcal-work-master_20260701T060000Z',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        // Reconnect with a DIFFERENT Google account (alice's, not work's) → the markers' origin email
        // no longer matches the live integration, so reconcileLastKnownMarkers leaves them untouched.
        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'new-at', refresh_token: 'new-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        mockUserInfoEmail('alice@example.com');
        const cbRes = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(cbRes.status).toBe(302);

        const [liveIntegration] = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        if (!liveIntegration) throw new Error('expected a live integration');
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, liveIntegration._id, { _id: 'sync-config-live' }));

        // The shared-calendar case: the new account sees the SAME event id. The work marker still
        // exists, but the restore is account-scoped (markerOriginAccountScope) — it must NOT match
        // the other-account marker, so the import creates a fresh routine instead of hijacking it.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-work-master',
                    title: 'Standup',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-cross',
        });
        const syncRes = await authenticatedRequest(app, { method: 'POST', path: `/calendar/integrations/${liveIntegration._id}/sync`, sessionCookie });
        expect(syncRes.status).toBe(200);

        // Original routine untouched: still inactive, unlinked, markers PRESERVED — reconnecting the
        // work account later can still relink it to its original series.
        const orphan = await routinesDAO.findOne({ _id: 'routine-work-orphan' });
        expect(orphan?.active).toBe(false);
        expect(orphan?.calendarEventId).toBeUndefined();
        expect(orphan?.lastKnownCalendarEventId).toBe('gcal-work-master');
        expect(orphan?.lastKnownCalendarAccountEmail).toBe('work@example.com');
        // The orphaned routine's leftover item keeps its (inert) instance id for the same reason.
        const orphanItem = await itemsDAO.findOne({ _id: 'item-work-orphan-instance' });
        expect(orphanItem?.calendarInstanceEventId).toBe('gcal-work-master_20260701T060000Z');

        // The inbound master created a FRESH routine under the new account's integration.
        const fresh = await routinesDAO.findOne({ calendarEventId: 'gcal-work-master' });
        expect(fresh).not.toBeNull();
        expect(fresh!._id).not.toBe('routine-work-orphan');
        expect(fresh!.active).toBe(true);
        expect(fresh!.calendarIntegrationId).toBe(liveIntegration._id);
    });

    it('split base + successor pair both restore after a remove-mode disconnect + reconnect (no twins)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const cappedRrule = `FREQ=WEEKLY;BYDAY=MO;UNTIL=${dayjs().subtract(2, 'week').format('YYYYMMDD[T]HHmmss[Z]')}`;

        // Post-remove-disconnect state of a "this and all following" split: capped base + open
        // successor, both deactivated with markers on the shared bare id.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-split-base',
                active: false,
                rrule: cappedRrule,
                updatedTs: dayjs().subtract(3, 'day').toISOString(),
                lastKnownCalendarEventId: 'gcal-split-1',
                lastKnownCalendarIntegrationId: 'int-DELETED',
                lastKnownCalendarSyncConfigId: 'sync-config-DELETED',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-split-succ',
                title: 'Standup (moved)',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TU',
                calendarRebasedEventId: 'gcal-split-1_R20260620T090000',
                splitFromRoutineId: 'routine-split-base',
                updatedTs: dayjs().subtract(3, 'day').toISOString(),
                lastKnownCalendarEventId: 'gcal-split-1',
                lastKnownCalendarIntegrationId: 'int-DELETED',
                lastKnownCalendarSyncConfigId: 'sync-config-DELETED',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        await insertIntegrationWithConfig(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-split-1',
                    title: 'Standup',
                    timeStart: dayjs().subtract(8, 'week').toISOString(),
                    timeEnd: dayjs().subtract(8, 'week').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:${cappedRrule}`],
                },
                {
                    id: 'gcal-split-1_R20260620T090000',
                    title: 'Standup (moved)',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
                },
            ],
            nextSyncToken: 'tok-split-restore',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // No new routine docs — the pair was restored in place.
        const routines = await routinesDAO.findArray({ user: userId });
        expect(routines).toHaveLength(2);

        const base = await routinesDAO.findOne({ _id: 'routine-split-base' });
        expect(base?.calendarEventId).toBe('gcal-split-1');
        expect(base?.calendarIntegrationId).toBe('int-1');
        // The capped segment stays paused — GCal truth (rrule with UNTIL) is not a live series.
        expect(base?.active).toBe(false);
        expect(base?.lastKnownCalendarEventId).toBeUndefined();

        const successor = await routinesDAO.findOne({ _id: 'routine-split-succ' });
        expect(successor?.calendarEventId).toBe('gcal-split-1');
        expect(successor?.calendarRebasedEventId).toBe('gcal-split-1_R20260620T090000');
        expect(successor?.calendarIntegrationId).toBe('int-1');
        expect(successor?.active).toBe(true);
        expect(successor?.lastKnownCalendarEventId).toBeUndefined();

        // Only the live successor regenerates items.
        const succItems = await itemsDAO.findArray({ user: userId, routineId: 'routine-split-succ', status: 'calendar' });
        expect(succItems.length).toBeGreaterThan(0);
        const baseItems = await itemsDAO.findArray({ user: userId, routineId: 'routine-split-base', status: 'calendar' });
        expect(baseItems).toHaveLength(0);
    });

    it('restore that races a concurrent active twin catches the E11000 and falls through without a 500', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-race-marker',
                active: false,
                updatedTs: dayjs().subtract(3, 'day').toISOString(),
                lastKnownCalendarEventId: 'gcal-master-race-restore',
                lastKnownCalendarIntegrationId: 'int-DELETED',
                lastKnownCalendarSyncConfigId: 'sync-config-DELETED',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        await insertIntegrationWithConfig(userId);

        // Interleave the race: a rival sync activates a routine on the same series AFTER the restore
        // candidate was read but BEFORE its conditional update executes. The reactivating $set then
        // violates uniq_active_routine_per_gcal_series — the catch must treat it as a miss, not 500.
        const realUpdateOne = routinesDAO.updateOne.bind(routinesDAO);
        let rivalInjected = false;
        vi.spyOn(routinesDAO, 'updateOne').mockImplementation(async (filter, update, options) => {
            type FilterShape = { lastKnownCalendarEventId?: string };
            if ((filter as FilterShape).lastKnownCalendarEventId === 'gcal-master-race-restore' && !rivalInjected) {
                rivalInjected = true;
                await routinesDAO.insertOne(
                    makeRoutine(userId, {
                        _id: 'routine-race-rival',
                        active: true,
                        calendarEventId: 'gcal-master-race-restore',
                        calendarIntegrationId: 'int-1',
                        calendarSyncConfigId: 'sync-config-1',
                    }),
                );
            }
            return await realUpdateOne(filter, update, options);
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-race-restore',
                    title: 'Standup',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-race-restore',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        expect(rivalInjected).toBe(true);

        // Race loser: the marker routine is untouched — markers intact, still inactive, not relinked.
        const marker = await routinesDAO.findOne({ _id: 'routine-race-marker' });
        expect(marker?.active).toBe(false);
        expect(marker?.calendarEventId).toBeUndefined();
        expect(marker?.lastKnownCalendarEventId).toBe('gcal-master-race-restore');

        // Exactly one ACTIVE routine holds the series — the rival winner.
        const active = await routinesDAO.findArray({ user: userId, calendarEventId: 'gcal-master-race-restore', active: true });
        expect(active).toHaveLength(1);
        const [winner] = active;
        if (!winner) throw new Error('expected the rival winner');
        expect(winner._id).toBe('routine-race-rival');
    });

    it('pushback skips items carrying lastKnownCalendarEventId (no create, no update)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-pb-skip',
            lastKnownCalendarEventId: 'gcal-was-linked',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-1',
        });
        await itemsDAO.insertOne(item);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'should-not-create' });
        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);
        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
        expect(updateSpy).not.toHaveBeenCalled();
        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('pushback skips routines carrying lastKnownCalendarEventId (no series create or update)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            lastKnownCalendarEventId: 'gcal-master-was-linked',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routine);

        const createRecurringSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('should-not-create');
        const updateRecurringSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        expect(createRecurringSpy).not.toHaveBeenCalled();
        expect(updateRecurringSpy).not.toHaveBeenCalled();
    });
});

// ─── reconnect — heals stale calendarIntegrationId on items ────────────────

describe('reconnect — inbound sync heals stale calendarIntegrationId', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('rewrites calendarIntegrationId from old to current when GCal sends a newer update', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Current (post-reconnect) integration — id `int-1`, default config `sync-config-1`.
        await insertIntegrationWithConfig(userId);

        // Item points at a DELETED prior integration (`int-old`) — the disconnect+reconnect dance
        // never rewrote it because no inbound update touched the item between reconnects.
        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        const newUpdatedTs = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-stale',
            user: userId,
            status: 'calendar',
            title: 'Old title',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-stale',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-stale', title: 'New title', timeStart: futureTs, timeEnd: futureTs, updated: newUpdatedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await itemsDAO.findByOwnerAndId('item-stale', userId);
        expect(updated).toBeTruthy();
        expect(updated!.title).toBe('New title');
        // Both link fields must be refreshed — if calendarIntegrationId stayed `int-old`, the next
        // local push would silently no-op in resolvePushContext.
        expect(updated!.calendarIntegrationId).toBe('int-1');
        expect(updated!.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('notes-only inbound update still refreshes both link ids', async () => {
        // Regression guard for the structurallyNewer gate: a notes-only inbound payload (no
        // title/time change) must still bring `calendarIntegrationId` + `calendarSyncConfigId`
        // forward — otherwise an item whose only post-reconnect inbound is a notes edit stays
        // pinned to the dead integration.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const t1 = dayjs().subtract(2, 'hour').toISOString();
        const t2 = dayjs().subtract(30, 'minute').toISOString();
        const t3 = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-stale-notesonly',
            user: userId,
            status: 'calendar',
            title: 'Title at T3',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-stale-notesonly',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            lastSyncedNotes: '<p>old desc</p>',
            createdTs: t1,
            updatedTs: t1,
            lastSyncedFromGCalTs: t3,
        });

        // event.updated = T2 sits between local updatedTs (T1) and anchor (T3) → notes apply,
        // structural fields don't (`structurallyNewer = false`).
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-stale-notesonly',
                    title: 'Title at T3',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: t2,
                    status: 'confirmed',
                    description: '<p>new desc</p>',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-stale-notesonly', userId);
        expect(item!.notes).toBe('new desc');
        // Link must be healed even though no structural change occurred.
        expect(item!.calendarIntegrationId).toBe('int-1');
        expect(item!.calendarSyncConfigId).toBe('sync-config-1');
        // Anchor stays at T3 — same guard as the existing notes-only-no-regress test.
        expect(item!.lastSyncedFromGCalTs).toBe(t3);
    });

    it('reviveTrashedCalendarItem also brings calendarIntegrationId forward', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Item is trashed (e.g. by disconnect-with-remove cascade) and references the gone integration.
        const oldTs = dayjs().subtract(2, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        const newUpdatedTs = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-revive',
            user: userId,
            status: 'trash',
            title: 'Will revive',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-revive',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-revive', title: 'Will revive', timeStart: futureTs, timeEnd: futureTs, updated: newUpdatedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await itemsDAO.findByOwnerAndId('item-revive', userId);
        expect(updated).toBeTruthy();
        expect(updated!.status).toBe('calendar');
        expect(updated!.calendarIntegrationId).toBe('int-1');
        expect(updated!.calendarSyncConfigId).toBe('sync-config-1');
    });
});

// ─── pushback — self-heals stale calendarIntegrationId ────────────────────

describe('pushback self-heal — stale calendarIntegrationId falls back to user default', () => {
    it('trash push deletes the GCal event via the active integration when stored integrationId is gone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // User has exactly one active integration (`int-1`) — the prior `int-old` row is gone.
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-stale-trash',
            calendarEventId: 'gcal-stale-trash',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(deleteSpy).toHaveBeenCalledOnce();
        expect(deleteSpy).toHaveBeenCalledWith('primary', 'gcal-stale-trash');

        // Row was healed in place — the next pushback won't re-pay the fallback lookup.
        const healed = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(healed!.calendarIntegrationId).toBe('int-1');
        expect(healed!.calendarSyncConfigId).toBe('sync-config-1');

        // An op was recorded for cross-device convergence (separate from the lastPushedToGCalTs stamp).
        const ops = await operationsDAO.findArray({ user: userId, entityId: item._id! });
        const healOp = ops.find((o) => {
            const snap = o.snapshot as ItemInterface | null;
            return o.opType === 'update' && snap?.calendarIntegrationId === 'int-1' && snap?.calendarSyncConfigId === 'sync-config-1';
        });
        expect(healOp).toBeTruthy();
    });

    it('done push marks the GCal event via the active integration when stored integrationId is gone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-stale-done',
            calendarEventId: 'gcal-stale-done',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            status: 'done',
            title: 'Visit the doctor',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        const [calendarId, eventId, updates] = updateSpy.mock.calls[0]!;
        expect(calendarId).toBe('primary');
        expect(eventId).toBe('gcal-stale-done');
        expect(updates).toMatchObject({ title: '✓ Visit the doctor', colorId: '2' });

        const healed = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(healed!.calendarIntegrationId).toBe('int-1');
        expect(healed!.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('reschedule push updates the GCal event via the active integration when stored integrationId is gone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-stale-move',
            calendarEventId: 'gcal-stale-move',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            status: 'calendar',
            title: 'Field trip',
            timeStart: dayjs().add(7, 'day').toISOString(),
            timeEnd: dayjs().add(7, 'day').add(1, 'hour').toISOString(),
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        const [calendarId, eventId] = updateSpy.mock.calls[0]!;
        expect(calendarId).toBe('primary');
        expect(eventId).toBe('gcal-stale-move');

        const healed = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(healed!.calendarIntegrationId).toBe('int-1');
        expect(healed!.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('no-ops when there is no active integration to fall back to', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // User has NO active integration — the prior one was disconnected and no reconnect happened.

        const item = makeItem(userId, {
            _id: 'item-stale-nofb',
            calendarEventId: 'gcal-stale-nofb',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        // No fallback → no GCal call, no heal, no op pollution.
        expect(deleteSpy).not.toHaveBeenCalled();
        const healed = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(healed!.calendarIntegrationId).toBe('int-old');
        expect(healed!.calendarSyncConfigId).toBe('sync-config-old');
    });

    it('heal write does not clobber a concurrent client edit with older updatedTs', async () => {
        // Regression for the LWW trap: the heal write is plumbing-only (calendarIntegrationId +
        // calendarSyncConfigId rewrite) and must NOT bump the entity's updatedTs anchor. If it did,
        // a concurrent offline client edit with updatedTs T2 (T1 < T2 < T_heal) would be silently
        // rejected on replay by `existing.updatedTs <= snapshot.updatedTs` — the heal would have
        // artificially advanced the anchor past the legitimate user edit.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const t1 = dayjs().subtract(1, 'hour').toISOString();
        const t2 = dayjs().subtract(10, 'second').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-heal-vs-lww',
            user: userId,
            status: 'calendar',
            title: 'Original title',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'gcal-heal-vs-lww',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            createdTs: t1,
            updatedTs: t1,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        // Step 1: pushback fires for a (notional) client op against the stale-linked item — heal runs.
        const triggerSnapshot: ItemInterface = {
            _id: 'item-heal-vs-lww',
            user: userId,
            status: 'calendar',
            title: 'Original title',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'gcal-heal-vs-lww',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            createdTs: t1,
            updatedTs: t1,
        };
        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: 'item-heal-vs-lww', snapshot: triggerSnapshot, ts: t1 }), mockBuildProvider());

        // After heal: row carries new link ids but the LWW anchor is still T1.
        const postHeal = await itemsDAO.findByOwnerAndId('item-heal-vs-lww', userId);
        expect(postHeal!.calendarIntegrationId).toBe('int-1');
        expect(postHeal!.calendarSyncConfigId).toBe('sync-config-1');
        expect(postHeal!.updatedTs).toBe(t1);

        // Step 2: a real client edit with updatedTs T2 (newer than T1) replays via applyEntityOp.
        const clientEdit: ItemInterface = {
            ...postHeal!,
            title: 'User edited title',
            updatedTs: t2,
        };
        await applyEntityOp(userId, {
            _id: 'op-client-edit',
            user: userId,
            deviceId: 'device-client',
            ts: t2,
            entityType: 'item',
            entityId: 'item-heal-vs-lww',
            opType: 'update',
            snapshot: clientEdit,
        });

        // The user's edit must win — the heal must not have locked it out by bumping the anchor.
        const final = await itemsDAO.findByOwnerAndId('item-heal-vs-lww', userId);
        expect(final!.title).toBe('User edited title');
        expect(final!.updatedTs).toBe(t2);
        // Healed link ids carry through into the client snapshot (the client already saw the healed
        // values via the recorded heal op before staging its own edit).
        expect(final!.calendarIntegrationId).toBe('int-1');
        expect(final!.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('happy path: item already references the active integration → no heal op written', async () => {
        // Guards against accidental over-eager heals — when the link is valid, resolvePushContext
        // must succeed on its first DAO lookup, tryHealStaleLink never runs, and the op log gets
        // no server-origin heal op for this item.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-no-drift',
            calendarEventId: 'gcal-no-drift',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const ops = await operationsDAO.findArray({ user: userId, entityId: item._id! });
        const serverHealOps = ops.filter((o) => {
            if (o.deviceId !== 'server' || o.opType !== 'update') {
                return false;
            }
            const snap = o.snapshot as ItemInterface | null;
            return snap?.calendarIntegrationId === 'int-1';
        });
        expect(serverHealOps).toHaveLength(0);
    });

    it('heals when snapshot.calendarIntegrationId is entirely absent (client wiped the link)', async () => {
        // Production symptom: a client mutation can stage a snapshot with no calendarIntegrationId
        // at all (not stale, absent). Pre-fix the "no integrationId — skipping" early-return bailed
        // before the heal could attempt fallback. Now the absent-integration path also reroutes
        // through tryHealStaleLink, picks the user's default active integration, and proceeds.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-absent-int',
            calendarEventId: 'gcal-absent-int',
            status: 'done',
            title: 'Push me anyway',
        });
        // Intentionally omit calendarIntegrationId/calendarSyncConfigId — this is the bug shape.
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        // GCal call landed via the fallback integration.
        expect(updateSpy).toHaveBeenCalledOnce();
        const [calendarId, eventId] = updateSpy.mock.calls[0]!;
        expect(calendarId).toBe('primary');
        expect(eventId).toBe('gcal-absent-int');

        // The row was healed in place — next push won't re-pay the fallback lookup.
        const healed = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(healed!.calendarIntegrationId).toBe('int-1');
        expect(healed!.calendarSyncConfigId).toBe('sync-config-1');

        // Heal op was recorded so other devices learn about the healed link on their next sync pull.
        const ops = await operationsDAO.findArray({ user: userId, entityId: item._id! });
        const healOp = ops.find((o) => {
            const snap = o.snapshot as ItemInterface | null;
            return o.opType === 'update' && snap?.calendarIntegrationId === 'int-1' && snap?.calendarSyncConfigId === 'sync-config-1';
        });
        expect(healOp).toBeTruthy();
    });

    it('absent-integration heal: still bails when no active integration exists for the user', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // No insertIntegrationWithConfig — user is currently disconnected.

        const item = makeItem(userId, {
            _id: 'item-absent-int-no-fb',
            calendarEventId: 'gcal-absent-int-no-fb',
            status: 'done',
            title: 'No fallback',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        // Nothing to fall back to → no GCal call, no row mutation, no spurious heal op.
        expect(updateSpy).not.toHaveBeenCalled();
        const after = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(after!.calendarIntegrationId).toBeUndefined();
        const ops = await operationsDAO.findArray({ user: userId, entityId: item._id! });
        const serverHealOps = ops.filter((o) => o.deviceId === 'server' && o.opType === 'update');
        expect(serverHealOps).toHaveLength(0);
    });
});

// ─── pushback skips fromGmail items (read-only via Calendar API) ─────────────────

describe('pushback skip — fromGmail events are Calendar-API-read-only', () => {
    it('done transition on a fromGmail item: no provider call, local status stays done', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-fromgmail-done',
            calendarEventId: 'gcal-fromgmail-done',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            status: 'done',
            title: 'Visit doctor (Gmail-created)',
            eventType: 'fromGmail',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);
        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        // Google rejects writes to fromGmail events with 400. We skip the attempt entirely.
        expect(updateSpy).not.toHaveBeenCalled();
        expect(deleteSpy).not.toHaveBeenCalled();

        // Local state unchanged — the GTD-side status flip persists regardless of GCal skip.
        const after = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(after!.status).toBe('done');
    });

    it('trash transition on a fromGmail item: no provider call', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-fromgmail-trash',
            calendarEventId: 'gcal-fromgmail-trash',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            status: 'trash',
            title: 'Cancel doctor visit',
            eventType: 'fromGmail',
        });
        await itemsDAO.insertOne(item);

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('hard-delete op on a fromGmail item: no provider call', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const snapshot = makeItem(userId, {
            _id: 'item-fromgmail-hard-delete',
            calendarEventId: 'gcal-fromgmail-hard-delete',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            status: 'trash',
            title: 'Hard delete me',
            eventType: 'fromGmail',
        });

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: snapshot._id!, snapshot, opType: 'delete' }), mockBuildProvider());

        // handleItemDelete must skip the delete call for fromGmail (Google would 400/403).
        expect(deleteSpy).not.toHaveBeenCalled();
    });
});

// ─── applyExceptionToItems — instance-id lookup, fallback, and create-on-miss ──────────────

describe('applyExceptionToItems — tiered lookup + create-on-miss', () => {
    beforeEach(() => {
        // Same default as the upsert-paths block: listEventsFull is called per sync.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-instance' });
    });

    async function setupRoutineAndIntegration(userId: string): Promise<RoutineInterface> {
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-master', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' });
        await routinesDAO.insertOne(routine);
        return routine;
    }

    it('preferred lookup by calendarInstanceEventId hits the right item even when timeStart no longer matches originalDate', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const instanceEventId = 'gcal-evt-master_20260519T060000Z';
        // Insert an item whose `timeStart` has already been moved to a different date — only the
        // `calendarInstanceEventId` ties it back to the May 19 occurrence.
        await itemsDAO.insertOne({
            _id: 'item-instance',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: instanceEventId,
            timeStart: '2026-05-20T08:00:00Z',
            timeEnd: '2026-05-20T08:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: '2026-05-19',
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: '2026-05-24T09:30:00Z',
                newTimeEnd: '2026-05-24T10:30:00Z',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await itemsDAO.findByOwnerAndId('item-instance', userId);
        expect(updated?.timeStart).toBe('2026-05-24T09:30:00Z');
        expect(updated?.timeEnd).toBe('2026-05-24T10:30:00Z');

        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        // CRITICAL: instance-id match prevents a phantom create.
        expect(allForRoutine).toHaveLength(1);
    });

    it('fallback to routineId + originalDate when no item carries calendarInstanceEventId (legacy row)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        // Legacy item — pre-rollout, no calendarInstanceEventId. The date-keyed fallback must still find it.
        await itemsDAO.insertOne({
            _id: 'item-legacy',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: '2026-05-19T06:00:00Z',
            timeEnd: '2026-05-19T06:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: '2026-05-19',
                type: 'modified',
                googleEventId: 'gcal-evt-master_20260519T060000Z',
                newTimeStart: '2026-05-19T08:30:00Z',
                newTimeEnd: '2026-05-19T09:00:00Z',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await itemsDAO.findByOwnerAndId('item-legacy', userId);
        expect(updated?.timeStart).toBe('2026-05-19T08:30:00Z');
        expect(updated?.timeEnd).toBe('2026-05-19T09:00:00Z');

        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(allForRoutine).toHaveLength(1);
    });

    it('moved twice (REGRESSION): second move lands on the now-shifted item, no duplicate created', async () => {
        // This is the reported bug: a user moves the Tue 15:00 instance to Sun 12:30, then again
        // to Mon 14:00. The first move already shifted the item's `timeStart`, so a date-keyed
        // lookup for May 19 misses on the second move. With `calendarInstanceEventId` the second
        // move still finds the (shifted) item.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const instanceEventId = 'gcal-evt-master_20260519T060000Z';
        await itemsDAO.insertOne({
            _id: 'item-moved',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: instanceEventId,
            timeStart: '2026-05-19T06:00:00Z',
            timeEnd: '2026-05-19T06:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        // First move: May 19 → May 24 (12:30 local — exact values are stand-ins).
        const getExceptionsSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions');
        getExceptionsSpy.mockResolvedValueOnce([
            {
                originalDate: '2026-05-19',
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: '2026-05-24T09:30:00Z',
                newTimeEnd: '2026-05-24T10:30:00Z',
            },
        ]);
        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });

        const afterFirst = await itemsDAO.findByOwnerAndId('item-moved', userId);
        expect(afterFirst?.timeStart).toBe('2026-05-24T09:30:00Z');

        // Second move of the same instance: May 24 → May 25. The `originalDate` stays at May 19
        // (rrule slot didn't change). Pre-fix: date-keyed lookup found nothing because the item
        // was already at May 24. Post-fix: `calendarInstanceEventId` resolves it directly.
        getExceptionsSpy.mockResolvedValueOnce([
            {
                originalDate: '2026-05-19',
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: '2026-05-25T11:00:00Z',
                newTimeEnd: '2026-05-25T12:00:00Z',
            },
        ]);
        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });

        const afterSecond = await itemsDAO.findByOwnerAndId('item-moved', userId);
        expect(afterSecond?.timeStart).toBe('2026-05-25T11:00:00Z');
        expect(afterSecond?.timeEnd).toBe('2026-05-25T12:00:00Z');

        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(allForRoutine).toHaveLength(1);
    });

    it('create-on-miss: modified exception with no matching item inserts a fresh calendar item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);
        // No item seeded — the exception has nothing to find via either tier.

        // Dates are relative to today so the exception is always in the FUTURE — otherwise the
        // `isExceptionBeforeToday` past-cutoff guard skips the create-on-miss and the test rots the
        // day after a hardcoded date passes. originalDate / move date / instance id stay consistent.
        const originalDate = dayjs().add(2, 'day').format('YYYY-MM-DD');
        const movedStart = dayjs().add(3, 'day').hour(7).minute(0).second(0).millisecond(0);
        const movedTimeStart = movedStart.utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
        const movedTimeEnd = movedStart.add(30, 'minute').utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
        const instanceEventId = `gcal-evt-master_${originalDate.replace(/-/g, '')}T060000Z`;
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: movedTimeStart,
                newTimeEnd: movedTimeEnd,
                title: 'Standup (moved)',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const created = await itemsDAO.findArray({ user: userId, routineId: 'routine-1', calendarInstanceEventId: instanceEventId } as never);
        expect(created).toHaveLength(1);
        const [item] = created;
        if (!item) throw new Error('expected create-on-miss to insert one item');
        expect(item.status).toBe('calendar');
        expect(item.title).toBe('Standup (moved)');
        expect(item.timeStart).toBe(movedTimeStart);
        expect(item.timeEnd).toBe(movedTimeEnd);
        // Inherits the routine's integration link so the UI can group it under the right calendar.
        expect(item.calendarIntegrationId).toBe('int-1');
        expect(item.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('create-on-miss does NOT fire for deleted exceptions', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: '2026-06-15', type: 'deleted', googleEventId: 'gcal-evt-master_20260615T060000Z' },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Deleted exception with no matching item must NOT spawn a phantom item.
        const itemsForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(itemsForRoutine).toHaveLength(0);

        // Positive assertion: prove the create branch was not taken. (The shape "0 items remain"
        // would silently pass even if a phantom create op were recorded — checking the op log
        // directly catches the path having been reached at all.)
        const createOps = await operationsDAO.findArray({ user: userId, entityType: 'item', opType: 'create' });
        expect(createOps).toHaveLength(0);
    });

    it('past-cutoff guard (REGRESSION): orphan-create is skipped for exceptions whose date is years in the past', async () => {
        // Repro for the fresh-reconnect bug: a yearly-birthday routine has `* […]` modified
        // exceptions from 2021/2022. On first reconnect, `getExceptions` returns them (since
        // lastSyncedTs is unset → epoch). Without the past-cutoff guard, each one materializes
        // as an ancient `calendar` item via `createItemForOrphanedException`.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);
        // No item seeded for the 2021 occurrence — orphan-create branch would normally fire.

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: '2021-09-24',
                type: 'modified',
                googleEventId: 'gcal-evt-master_20210924',
                title: '* [Yael’s Birthday]',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // No ancient `calendar` item materialized.
        const items = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(items).toHaveLength(0);

        // Positive assertion: no item-create op was recorded either.
        const createOps = await operationsDAO.findArray({ user: userId, entityType: 'item', opType: 'create' });
        expect(createOps).toHaveLength(0);
    });

    it('past exception is still applied to an existing item (modify path is not blocked by the cutoff)', async () => {
        // The cutoff only short-circuits orphan-create. If an item already exists for the past
        // occurrence (e.g. a routine generated it before today), a modified exception must still
        // be applied so historical edits aren't silently dropped.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const instanceEventId = 'gcal-evt-master_20210924';
        await itemsDAO.insertOne({
            _id: 'item-past-existing',
            user: userId,
            status: 'calendar',
            title: 'Yael’s Birthday',
            routineId: 'routine-1',
            calendarInstanceEventId: instanceEventId,
            timeStart: '2021-09-24',
            timeEnd: '2021-09-25',
            allDay: true,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: '2021-09-24', type: 'modified', googleEventId: instanceEventId, title: '* [Yael’s Birthday]' },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Existing item picked up the title edit.
        const updated = await itemsDAO.findByOwnerAndId('item-past-existing', userId);
        expect(updated?.title).toBe('* [Yael’s Birthday]');
        // No phantom duplicate created.
        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(allForRoutine).toHaveLength(1);
    });

    it('past-cutoff does NOT mis-flag a today, all-day exception in a west-of-UTC zone (LA)', async () => {
        // Regression for the date-vs-datetime comparison bug. The bug only fires in zones west of
        // UTC: `originalDate = today_LA` parses to `today_LA T00:00:00Z`, while
        // `startOfTodayInTz('America/Los_Angeles') = today_LA T07:00:00Z` (PDT). Pre-fix:
        // `T00:00:00Z < T07:00:00Z` → true → mis-flagged as past → orphan-create silently dropped.
        // Post-fix: YYYY-MM-DD string comparison in the calendar's timezone returns false.
        //
        // Call applyExceptionToItems directly so we control `ctx.timeZone` cleanly without having
        // to override the globally-mocked `getCalendarTimeZone` for a single test.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const routine = await setupRoutineAndIntegration(userId);

        const todayInLA = dayjs().tz('America/Los_Angeles').format('YYYY-MM-DD');
        const instanceEventId = `gcal-evt-master_${todayInLA.replaceAll('-', '')}`;
        const { applyExceptionToItems } = await import('../routes/calendar.js');
        const ctx: Parameters<typeof applyExceptionToItems>[2] = {
            userId,
            now: dayjs().toISOString(),
            ops: [],
            timeZone: 'America/Los_Angeles',
        };
        await applyExceptionToItems(
            routine,
            { originalDate: todayInLA, type: 'modified', googleEventId: instanceEventId, title: 'Today (all-day, edited)' },
            ctx,
        );

        const created = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(created).toHaveLength(1);
    });

    it('past-cutoff does NOT block a move FROM the past INTO the future', async () => {
        // newTimeStart wins over originalDate when present: a series instance whose original date
        // was in the past but has been moved to a future date should still materialize via
        // orphan-create. Otherwise users would lose calendar items they explicitly rescheduled.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const instanceEventId = 'gcal-evt-master_20210924';
        const futureStart = dayjs().add(60, 'day').format('YYYY-MM-DDTHH:mm:ss');
        const futureEnd = dayjs().add(60, 'day').add(30, 'minute').format('YYYY-MM-DDTHH:mm:ss');
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: '2021-09-24',
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: futureStart,
                newTimeEnd: futureEnd,
                title: 'Yael’s Birthday (rescheduled)',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const created = await itemsDAO.findArray({ user: userId, routineId: 'routine-1', calendarInstanceEventId: instanceEventId } as never);
        expect(created).toHaveLength(1);
        const [item] = created;
        if (!item) throw new Error('expected the rescheduled occurrence to materialize');
        expect(item.timeStart).toBe(futureStart);
    });

    it('legacy row moved twice (no calendarInstanceEventId): first move via fallback, second move converges with no duplicate', async () => {
        // Pre-rollout shape: routine-generated item has NO `calendarInstanceEventId`. The first
        // move hits the date-keyed fallback OK. The second move would historically miss (item's
        // timeStart already shifted off the originalDate) — assert we end up with one item, not two.
        // Dates are computed relative to "today" so the past-event guard doesn't filter them out
        // when the suite is run on a future calendar day.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const originalDate = dayjs().add(3, 'day').format('YYYY-MM-DD');
        const move1Date = dayjs().add(5, 'day').format('YYYY-MM-DD');
        const move2Date = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const originalTimeStart = `${originalDate}T06:00:00Z`;
        const originalTimeEnd = `${originalDate}T06:30:00Z`;

        await itemsDAO.insertOne({
            _id: 'item-legacy-moved',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            // No calendarInstanceEventId — this is the legacy shape.
            timeStart: originalTimeStart,
            timeEnd: originalTimeEnd,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        const instanceEventId = `gcal-evt-master_${originalDate.replace(/-/g, '')}T060000Z`;
        const getExceptionsSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions');

        // Move 1: originalDate → move1Date. Fallback (routineId + date) finds the row on originalDate.
        getExceptionsSpy.mockResolvedValueOnce([
            {
                originalDate,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: `${move1Date}T09:30:00Z`,
                newTimeEnd: `${move1Date}T10:30:00Z`,
            },
        ]);
        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });

        // Move 1 resolved via the date-keyed fallback AND backfilled the instance id onto the
        // legacy row, so move 2 hits the tier-1 id lookup directly — no create-on-miss, no
        // duplicate. (Historically this scenario left two rows: the shifted legacy row plus a
        // fresh create-on-miss row.)
        const afterFirst = await itemsDAO.findByOwnerAndId('item-legacy-moved', userId);
        expect(afterFirst?.calendarInstanceEventId).toBe(instanceEventId);
        expect(afterFirst?.timeStart).toBe(`${move1Date}T09:30:00Z`);

        // Move 2 of the SAME instance: move1Date → move2Date.
        getExceptionsSpy.mockResolvedValueOnce([
            {
                originalDate,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: `${move2Date}T11:00:00Z`,
                newTimeEnd: `${move2Date}T12:00:00Z`,
            },
        ]);
        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });

        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(allForRoutine).toHaveLength(1);
        const [survivor] = allForRoutine;
        if (!survivor) throw new Error('expected exactly one row for the moved instance');
        expect(survivor._id).toBe('item-legacy-moved');
        expect(survivor.calendarInstanceEventId).toBe(instanceEventId);
        expect(survivor.timeStart).toBe(`${move2Date}T11:00:00Z`);
        expect(survivor.timeEnd).toBe(`${move2Date}T12:00:00Z`);
    });

    it('re-delivered exception on an already-shifted legacy row (REGRESSION): instant-keyed tier 3 patches it, no duplicate', async () => {
        // The reported duplicate-item bug: an earlier apply already shifted the legacy row (no
        // `calendarInstanceEventId`) to the move target, storing the time in a DIFFERENT offset
        // representation (UTC) than the exception carries (+03:00). GCal re-reports the same
        // exception (`getExceptions` is a time-range query) → tier 1 misses (no id), tier 2 misses
        // (row no longer at originalDate). Pre-fix, create-on-miss inserted a duplicate row for
        // the same instant. Tier 3 must match by instant and backfill the id instead.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const originalDate = dayjs().add(3, 'day').format('YYYY-MM-DD');
        const moveDate = dayjs().add(10, 'day').format('YYYY-MM-DD');
        const movedStartOffset = `${moveDate}T07:00:00+03:00`;
        const movedEndOffset = `${moveDate}T08:00:00+03:00`;
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-master',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            // Pre-merge state: the exception was already applied and recorded on the routine.
            routineExceptions: [{ date: originalDate, type: 'modified', newTimeStart: movedStartOffset, newTimeEnd: movedEndOffset }],
        });
        await routinesDAO.insertOne(routine);

        // The legacy row sits at the SAME instant as the exception's target, but stored in UTC.
        await itemsDAO.insertOne({
            _id: 'item-legacy-shifted',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${moveDate}T04:00:00.000Z`,
            timeEnd: `${moveDate}T05:00:00.000Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        const instanceEventId = `gcal-evt-master_${originalDate.replace(/-/g, '')}T040000Z`;
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: movedStartOffset,
                newTimeEnd: movedEndOffset,
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(allForRoutine).toHaveLength(1);
        const [survivor] = allForRoutine;
        if (!survivor) throw new Error('expected exactly one row for the re-delivered exception');
        expect(survivor._id).toBe('item-legacy-shifted');
        // Tier 3 matched → the id got backfilled so future exceptions hit tier 1.
        expect(survivor.calendarInstanceEventId).toBe(instanceEventId);
        expect(survivor.status).toBe('calendar');
    });

    it('deleted exception on an already-shifted legacy row: instant-keyed tier 3 finds and trashes it (no ghost item)', async () => {
        // Symmetric variant: the instance was moved earlier (legacy row shifted, no instance id),
        // then deleted on GCal. Tier 2's date-keyed lookup misses the shifted row, and deletes
        // have no create-on-miss — pre-fix the row survived forever as a ghost. Tier 3 keys on the
        // routine's stored prior `newTimeStart` for that date and trashes the row.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const originalDate = dayjs().add(4, 'day').format('YYYY-MM-DD');
        const moveDate = dayjs().add(9, 'day').format('YYYY-MM-DD');
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-master',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            routineExceptions: [{ date: originalDate, type: 'modified', newTimeStart: `${moveDate}T07:00:00+03:00`, newTimeEnd: `${moveDate}T08:00:00+03:00` }],
        });
        await routinesDAO.insertOne(routine);

        await itemsDAO.insertOne({
            _id: 'item-legacy-deleted',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${moveDate}T04:00:00.000Z`,
            timeEnd: `${moveDate}T05:00:00.000Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate,
                type: 'deleted',
                googleEventId: `gcal-evt-master_${originalDate.replace(/-/g, '')}T040000Z`,
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const ghost = await itemsDAO.findByOwnerAndId('item-legacy-deleted', userId);
        expect(ghost?.status).toBe('trash');
    });

    it('tier 3 matches an offset-NAIVE legacy timeStart against an offset-explicit exception (calendar-tz parse, not server-local)', async () => {
        // Routine-generated rows store wall-clock naive `timeStart` (no Z / offset). The stored
        // exception carries +03:00. The instants only line up when the naive string is parsed in
        // the CALENDAR's timezone (Asia/Jerusalem fixture) — a server-local parse (UTC on Cloud
        // Run) skews by the offset and misses, falling through to a duplicate create.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const originalDate = dayjs().add(5, 'day').format('YYYY-MM-DD');
        const moveDate = dayjs().add(11, 'day').format('YYYY-MM-DD');
        const movedStartOffset = `${moveDate}T07:00:00+03:00`;
        const movedEndOffset = `${moveDate}T08:00:00+03:00`;
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-master',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            routineExceptions: [{ date: originalDate, type: 'modified', newTimeStart: movedStartOffset, newTimeEnd: movedEndOffset }],
        });
        await routinesDAO.insertOne(routine);

        // Same wall-clock instant as the exception, stored offset-naive (Jerusalem wall time).
        await itemsDAO.insertOne({
            _id: 'item-legacy-naive',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${moveDate}T07:00:00`,
            timeEnd: `${moveDate}T08:00:00`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        const instanceEventId = `gcal-evt-master_${originalDate.replace(/-/g, '')}T040000Z`;
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate, type: 'modified', googleEventId: instanceEventId, newTimeStart: movedStartOffset, newTimeEnd: movedEndOffset },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(allForRoutine).toHaveLength(1);
        const [survivor] = allForRoutine;
        if (!survivor) throw new Error('expected one row for the naive-timeStart instance');
        expect(survivor._id).toBe('item-legacy-naive');
        expect(survivor.calendarInstanceEventId).toBe(instanceEventId);
    });

    it('dead-twin squat on the instance id: the move still lands, only the id backfill is skipped', async () => {
        // The `(user, calendarInstanceEventId)` unique index is NOT status-scoped: a trash row from
        // an earlier routine generation can squat the id indefinitely. The backfilled update then
        // E11000s — the exception's time move must still be applied (retry without the backfill),
        // not silently dropped on every sync.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const originalDate = dayjs().add(6, 'day').format('YYYY-MM-DD');
        const moveDate = dayjs().add(8, 'day').format('YYYY-MM-DD');
        const instanceEventId = `gcal-evt-master_${originalDate.replace(/-/g, '')}T060000Z`;

        // Dead twin on a FOREIGN routine squatting the instance id (tier 1 skips it: not status 'calendar').
        await itemsDAO.insertOne({
            _id: 'item-dead-squatter',
            user: userId,
            status: 'trash',
            title: 'Standup (old generation)',
            routineId: 'routine-prior-generation',
            calendarInstanceEventId: instanceEventId,
            timeStart: `${originalDate}T06:00:00Z`,
            timeEnd: `${originalDate}T06:30:00Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });
        // Live legacy row at the original date — tier 2 resolves it.
        await itemsDAO.insertOne({
            _id: 'item-live-legacy',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${originalDate}T06:00:00Z`,
            timeEnd: `${originalDate}T06:30:00Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: `${moveDate}T09:30:00Z`,
                newTimeEnd: `${moveDate}T10:30:00Z`,
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // The move landed despite the squat…
        const moved = await itemsDAO.findByOwnerAndId('item-live-legacy', userId);
        expect(moved?.timeStart).toBe(`${moveDate}T09:30:00Z`);
        expect(moved?.timeEnd).toBe(`${moveDate}T10:30:00Z`);
        // …the backfill was skipped (id still squatted), and the squatter is untouched.
        expect(moved?.calendarInstanceEventId).toBeUndefined();
        const squatter = await itemsDAO.findByOwnerAndId('item-dead-squatter', userId);
        expect(squatter?.status).toBe('trash');
        expect(squatter?.calendarInstanceEventId).toBe(instanceEventId);
    });

    it('tier 3 ambiguity (two legacy rows at the same instant): deleted exception trashes NOTHING', async () => {
        // Two legacy occurrences legitimately at the same instant are indistinguishable — a wrong
        // guess on a deleted exception would trash a live occurrence the user never cancelled.
        // Ambiguity must degrade to a miss (both rows survive), never to data loss.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const originalDate = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const moveDate = dayjs().add(12, 'day').format('YYYY-MM-DD');
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-master',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            routineExceptions: [{ date: originalDate, type: 'modified', newTimeStart: `${moveDate}T07:00:00+03:00`, newTimeEnd: `${moveDate}T08:00:00+03:00` }],
        });
        await routinesDAO.insertOne(routine);

        const sharedRow = {
            user: userId,
            status: 'calendar' as const,
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${moveDate}T04:00:00.000Z`,
            timeEnd: `${moveDate}T05:00:00.000Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        };
        await itemsDAO.insertOne({ _id: 'item-ambiguous-a', ...sharedRow });
        await itemsDAO.insertOne({ _id: 'item-ambiguous-b', ...sharedRow });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate, type: 'deleted', googleEventId: `gcal-evt-master_${originalDate.replace(/-/g, '')}T040000Z` },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const rowA = await itemsDAO.findByOwnerAndId('item-ambiguous-a', userId);
        const rowB = await itemsDAO.findByOwnerAndId('item-ambiguous-b', userId);
        expect(rowA?.status).toBe('calendar');
        expect(rowB?.status).toBe('calendar');
    });

    it('concurrent updatedTs bump between resolve and apply: modified exception is skipped, not clobbered', async () => {
        // Simulates the race the reviewer flagged: `resolveExceptionTarget` reads an item, then
        // a /sync/push edit lands between read and apply (bumping updatedTs). The updateOne
        // conditional on the stale updatedTs must matchCount=0 and skip — otherwise the apply
        // silently overwrites the user's edit.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const instanceEventId = 'gcal-evt-master_20260701T060000Z';
        const initialUpdatedTs = dayjs().subtract(10, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-race',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: instanceEventId,
            timeStart: '2026-07-01T06:00:00Z',
            timeEnd: '2026-07-01T06:30:00Z',
            createdTs: initialUpdatedTs,
            updatedTs: initialUpdatedTs,
        });

        // Bump updatedTs BEFORE the exception lands — same effect as a concurrent /sync/push
        // racing in between resolveExceptionTarget and the apply's updateOne. Since vitest can't
        // truly interleave, we mutate first; the conditional updateOne sees a mismatched
        // updatedTs from the snapshot the resolver captured.
        const racingTs = dayjs().toISOString();
        await itemsDAO.updateOne({ _id: 'item-race', user: userId } as never, { $set: { title: 'User edited title', updatedTs: racingTs } });

        // Mock the resolver-internal findArray to return the STALE pre-race snapshot, exactly the
        // window we're guarding against. The actual write goes through the real DB.
        const findArraySpy = vi.spyOn(itemsDAO, 'findArray');
        let staleReturned = false;
        findArraySpy.mockImplementationOnce(async () => {
            staleReturned = true;
            return [
                {
                    _id: 'item-race',
                    user: userId,
                    status: 'calendar' as const,
                    title: 'Standup',
                    routineId: 'routine-1',
                    calendarInstanceEventId: instanceEventId,
                    timeStart: '2026-07-01T06:00:00Z',
                    timeEnd: '2026-07-01T06:30:00Z',
                    createdTs: initialUpdatedTs,
                    updatedTs: initialUpdatedTs, // stale
                },
            ];
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: '2026-07-01',
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: '2026-07-02T08:00:00Z',
                newTimeEnd: '2026-07-02T08:30:00Z',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        expect(staleReturned).toBe(true);

        // The user's racing edit must survive — title + timeStart unchanged from the racing write.
        const finalItem = await itemsDAO.findByOwnerAndId('item-race', userId);
        expect(finalItem?.title).toBe('User edited title');
        expect(finalItem?.timeStart).toBe('2026-07-01T06:00:00Z');
    });

    it('concurrent create race: two callers seeing target miss converge on one item (no duplicate)', async () => {
        // Real-world scenario the unique partial index guards: a webhook delivery and a manual
        // /calendar/integrations/:id/sync land within the same window, both see resolve miss,
        // both reach createItemForOrphanedException. The loser gets E11000 and falls through to
        // re-resolve + apply on the winner's row. End state: exactly one item.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const routine = await setupRoutineAndIntegration(userId);

        // Dynamic future dates — a hardcoded date rots into `isExceptionBeforeToday`'s past-cutoff
        // guard once the calendar catches up, making the orphan create silently skip.
        const originalDate = dayjs().add(10, 'day').format('YYYY-MM-DD');
        const movedStart = dayjs(`${originalDate}T09:00:00Z`).add(1, 'day').toISOString();
        const movedEnd = dayjs(`${originalDate}T09:30:00Z`).add(1, 'day').toISOString();
        const instanceEventId = `gcal-evt-master_${originalDate.replaceAll('-', '')}T060000Z`;
        const exception = {
            originalDate,
            type: 'modified' as const,
            googleEventId: instanceEventId,
            newTimeStart: movedStart,
            newTimeEnd: movedEnd,
            title: 'Standup (raced move)',
        };

        // Fire two concurrent applies of the same exception through the exported handler. Equivalent
        // to what syncRoutineExceptions does for each entry returned by getExceptions, but lets us
        // race without standing up the full /dev/* mount in this test app.
        const { applyExceptionToItems } = await import('../routes/calendar.js');
        const now = dayjs().toISOString();
        const ctx1: Parameters<typeof applyExceptionToItems>[2] = { userId, now, ops: [] };
        const ctx2: Parameters<typeof applyExceptionToItems>[2] = { userId, now, ops: [] };

        await Promise.all([applyExceptionToItems(routine, exception, ctx1), applyExceptionToItems(routine, exception, ctx2)]);

        // The race guard (unique partial index on calendarInstanceEventId) ensures only one row.
        const itemsForInstance = await itemsDAO.findArray({ user: userId, calendarInstanceEventId: instanceEventId } as never);
        expect(itemsForInstance).toHaveLength(1);
        const winner = itemsForInstance[0];
        if (!winner) throw new Error('expected one winner');
        // The winning row carries the move's title/time, regardless of which caller inserted.
        expect(winner.title).toBe('Standup (raced move)');
        expect(winner.timeStart).toBe(movedStart);
    });

    it('dead-twin demote (REGRESSION): trashed twin on a different routine is demoted so the active routine can insert', async () => {
        // Real-world scenario: a routine was paused or replaced. Its old items moved to `trash` but
        // still carry `calendarInstanceEventId`. When the active routine's exception sync runs, the
        // unique partial index `(user, calendarInstanceEventId)` fires E11000 on the insert. The
        // fix demotes the trashed twin (strips its instance id) and retries — UI sees the fresh row.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const activeRoutine = await setupRoutineAndIntegration(userId);

        // Date must be strictly after today-in-config-TZ; the past-cutoff guard in applyExceptionToItems
        // skips orphan-create otherwise. 7 days is well clear of any test-runner-vs-integration TZ skew.
        const futureDay = dayjs().add(7, 'day');
        const futureYmd = futureDay.format('YYYY-MM-DD');
        const futureYmdCompact = futureDay.format('YYYYMMDD');
        const instanceEventId = `gcal-evt-master_${futureYmdCompact}T123000Z`;
        const newStart = `${futureYmd}T14:00:00Z`;
        const newEnd = `${futureYmd}T15:00:00Z`;
        // Trashed twin on a DIFFERENT (paused) routine, still squatting the instance slot.
        await itemsDAO.insertOne({
            _id: 'item-trashed-twin',
            user: userId,
            status: 'trash',
            title: 'All-Hands (old)',
            routineId: 'routine-paused',
            calendarInstanceEventId: instanceEventId,
            timeStart: `${futureYmd}T12:30:00Z`,
            timeEnd: `${futureYmd}T13:30:00Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: futureYmd,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: newStart,
                newTimeEnd: newEnd,
                title: 'All-Hands',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Trashed twin's instance id is stripped — slot is freed.
        const demoted = await itemsDAO.findByOwnerAndId('item-trashed-twin', userId);
        expect(demoted?.calendarInstanceEventId).toBeUndefined();
        expect(demoted?.status).toBe('trash');

        // Active routine got its fresh `calendar` item with the freed instance id.
        const freshForActive = await itemsDAO.findArray({ user: userId, routineId: activeRoutine._id, status: 'calendar' });
        expect(freshForActive).toHaveLength(1);
        const [item] = freshForActive;
        if (!item) throw new Error('expected one fresh calendar item');
        expect(item.calendarInstanceEventId).toBe(instanceEventId);
        expect(item.timeStart).toBe(newStart);
        expect(item.title).toBe('All-Hands');
    });

    it('dead-twin demote: a `done` twin on a different routine is demoted just like a trashed twin', async () => {
        // Same logic as above but the dead occupant is a completed item (kept for history). `done`
        // rows also retain `calendarInstanceEventId` for echo matching and must be demotable.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const activeRoutine = await setupRoutineAndIntegration(userId);

        const futureDay = dayjs().add(7, 'day');
        const futureYmd = futureDay.format('YYYY-MM-DD');
        const futureYmdCompact = futureDay.format('YYYYMMDD');
        const instanceEventId = `gcal-evt-master_${futureYmdCompact}T123000Z`;
        const newStart = `${futureYmd}T14:00:00Z`;
        const newEnd = `${futureYmd}T15:00:00Z`;
        await itemsDAO.insertOne({
            _id: 'item-done-twin',
            user: userId,
            status: 'done',
            title: 'All-Hands (completed)',
            routineId: 'routine-paused',
            calendarInstanceEventId: instanceEventId,
            timeStart: `${futureYmd}T12:30:00Z`,
            timeEnd: `${futureYmd}T13:30:00Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: futureYmd,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: newStart,
                newTimeEnd: newEnd,
                title: 'All-Hands',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const demoted = await itemsDAO.findByOwnerAndId('item-done-twin', userId);
        expect(demoted?.calendarInstanceEventId).toBeUndefined();
        expect(demoted?.status).toBe('done');

        const freshForActive = await itemsDAO.findArray({ user: userId, routineId: activeRoutine._id, status: 'calendar' });
        expect(freshForActive).toHaveLength(1);
        const [item] = freshForActive;
        if (!item) throw new Error('expected one fresh calendar item');
        expect(item.calendarInstanceEventId).toBe(instanceEventId);
        expect(item.timeStart).toBe(newStart);
    });

    it('dead-twin demote: live `calendar` row on the SAME routine is NOT demoted (existing race-loser path runs)', async () => {
        // Sanity check that the new demote branch is narrowly scoped: a same-routine live row is
        // the legitimate race winner; we must NOT strip its instance id. The existing
        // applyExceptionAfterDuplicate path patches it via the standard modified-exception apply.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const activeRoutine = await setupRoutineAndIntegration(userId);

        const futureDay = dayjs().add(7, 'day');
        const futureYmd = futureDay.format('YYYY-MM-DD');
        const futureYmdCompact = futureDay.format('YYYYMMDD');
        const instanceEventId = `gcal-evt-master_${futureYmdCompact}T123000Z`;
        const newStart = `${futureYmd}T14:00:00Z`;
        const newEnd = `${futureYmd}T15:00:00Z`;
        // Live race-winner already inserted by some other path on the SAME routine.
        await itemsDAO.insertOne({
            _id: 'item-race-winner',
            user: userId,
            status: 'calendar',
            title: 'All-Hands (existing)',
            routineId: activeRoutine._id,
            calendarInstanceEventId: instanceEventId,
            timeStart: `${futureYmd}T12:30:00Z`,
            timeEnd: `${futureYmd}T13:30:00Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        // Force the orphan-create branch by spying on resolveExceptionTarget's findArray: return
        // empty so applyExceptionToItems treats it as a miss and reaches createItemForOrphanedException.
        const findArraySpy = vi.spyOn(itemsDAO, 'findArray');
        findArraySpy.mockImplementationOnce(async () => []); // preferred-lookup miss
        findArraySpy.mockImplementationOnce(async () => []); // fallback-lookup miss

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: futureYmd,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: newStart,
                newTimeEnd: newEnd,
                title: 'All-Hands (updated)',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Existing live row is preserved AND received the modified-exception update via the race-loser path.
        const winner = await itemsDAO.findByOwnerAndId('item-race-winner', userId);
        expect(winner?.calendarInstanceEventId).toBe(instanceEventId);
        expect(winner?.title).toBe('All-Hands (updated)');
        expect(winner?.timeStart).toBe(newStart);

        // No second item created — applyExceptionAfterDuplicate patched the winner instead.
        const allForActive = await itemsDAO.findArray({ user: userId, routineId: activeRoutine._id });
        expect(allForActive).toHaveLength(1);
    });

    it("cross-account reconnect: routine markers and instance ids persist; the unlinked routine never joins B's exception sync", async () => {
        // Historic context: disconnect-with-keep on account A, reconnect to a DIFFERENT account B.
        // The old wipe-and-repush behavior cleared markers + stale instance ids so the routine could
        // be relinked/re-pushed under B (and stale ids then caused the duplicate-on-second-move
        // regression). Under leave-unlinked the routine simply STAYS unlinked — markers and instance
        // ids persist inertly, and only an explicit re-bind (simulated below) brings the routine into
        // B's exception sync, at which point the duplicate-protection invariant must still hold.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        // Seed: routine + items still bound to OLD account A. Items carry instance ids derived
        // from A's master id ('gcal-master-A'). The lastKnownCalendarIntegrationId points at a
        // defunct integration the user no longer owns.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-cross-account',
                lastKnownCalendarEventId: 'gcal-master-A',
                lastKnownCalendarIntegrationId: 'int-OLD-account-A',
                lastKnownCalendarSyncConfigId: 'sync-config-OLD',
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-cross-account',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-cross-account',
            calendarInstanceEventId: 'gcal-master-A_20260815T060000Z', // derived from A's master
            timeStart: '2026-08-15T06:00:00Z',
            timeEnd: '2026-08-15T06:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        // Drive the OAuth reconnect for a NEW account B.
        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;
        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'B-at', refresh_token: 'B-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        mockUserInfoEmail('alice@example.com');

        const callbackRes = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-B&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(callbackRes.status).toBe(302);

        // Leave-unlinked: the reconnect touches neither the routine's markers nor the item's stale
        // instance id. The routine is unlinked, so it does not participate in B's exception sync —
        // the stale id is inert until something explicitly re-binds the routine.
        const afterReconnect = await routinesDAO.findByOwnerAndId('routine-cross-account', userId);
        expect(afterReconnect?.lastKnownCalendarEventId).toBe('gcal-master-A');
        const itemAfterReconnect = await itemsDAO.findByOwnerAndId('item-cross-account', userId);
        expect(itemAfterReconnect?.calendarInstanceEventId).toBe('gcal-master-A_20260815T060000Z');

        // Simulate two moves under account B's master id after an EXPLICIT re-bind. The stale
        // instance id makes the preferred lookup miss; the first move lands via the originalDate
        // fallback. Create-on-miss may fire on the second move, but the unique partial index
        // ensures at most one new row — the invariant that must survive leave-unlinked.
        const integrationsB = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        const liveIntegrationId = integrationsB[0]?._id;
        if (!liveIntegrationId) throw new Error('expected reconnected integration');
        // The sweep runs inside each manual sync below (full sync) and picks up the legacy
        // email-less marker best-effort; return "not found" so it skips (provenance unproven).
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);

        const instanceB1 = 'gcal-master-B_20260815T060000Z';
        const getExceptionsSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions');
        getExceptionsSpy.mockResolvedValueOnce([
            {
                originalDate: '2026-08-15',
                type: 'modified',
                googleEventId: instanceB1,
                newTimeStart: '2026-08-20T09:00:00Z',
                newTimeEnd: '2026-08-20T09:30:00Z',
            },
        ]);
        // Bind the routine to B so syncRoutineExceptions includes it on next pass.
        await routinesDAO.updateOne({ _id: 'routine-cross-account', user: userId } as never, {
            $set: { calendarEventId: 'gcal-master-B', calendarIntegrationId: liveIntegrationId, calendarSyncConfigId: 'sync-config-1' },
        });
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, liveIntegrationId));
        await authenticatedRequest(app, { method: 'POST', path: `/calendar/integrations/${liveIntegrationId}/sync`, sessionCookie });

        // Second move of the SAME instance.
        getExceptionsSpy.mockResolvedValueOnce([
            {
                originalDate: '2026-08-15',
                type: 'modified',
                googleEventId: instanceB1,
                newTimeStart: '2026-08-21T10:00:00Z',
                newTimeEnd: '2026-08-21T10:30:00Z',
            },
        ]);
        await authenticatedRequest(app, { method: 'POST', path: `/calendar/integrations/${liveIntegrationId}/sync`, sessionCookie });

        // Critical: never more than one item per instance id, regardless of which path each move
        // took. Strictly worse than pre-Q2 would be 2+ items here.
        const itemsB = await itemsDAO.findArray({ user: userId, calendarInstanceEventId: instanceB1 } as never);
        expect(itemsB.length).toBeLessThanOrEqual(1);
        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-cross-account' });
        expect(allForRoutine.length).toBeLessThanOrEqual(2);
    });

    it('same-account reconnect: markers are REWRITTEN to the live integration, not wiped (no gtd* clone)', async () => {
        // The duplicate-event bug: disconnect-with-keep on account A, reconnect to the SAME account A.
        // The disconnect markers (lastKnownCalendar*) carry the origin email; the reconnect's authorized
        // email matches it, so the markers must be REWRITTEN to the new integration id (every reconnect
        // mints a new id) — NOT wiped. Wiping would let the outbound backfill push the routine as a fresh
        // gtd* clone master alongside the real one that still lives on Google.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-same-account',
                lastKnownCalendarEventId: 'gcal-master-real',
                lastKnownCalendarIntegrationId: 'int-OLD-deleted',
                lastKnownCalendarSyncConfigId: 'sync-config-OLD',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );

        // Drive the OAuth reconnect for the SAME account (alice@example.com).
        const redirectRes = await authenticatedRequest(app, { method: 'GET', path: '/calendar/auth/google?login_hint=alice@example.com', sessionCookie });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;
        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'A2-at', refresh_token: 'A2-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        mockUserInfoEmail('alice@example.com');
        const callbackRes = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-A2&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(callbackRes.status).toBe(302);

        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        const [liveIntegration] = integrations;
        if (!liveIntegration) throw new Error('expected reconnected integration');

        const afterRepair = await routinesDAO.findByOwnerAndId('routine-same-account', userId);
        // Marker survives — the real master id is intact so the inbound pull can strong-key relink.
        expect(afterRepair?.lastKnownCalendarEventId).toBe('gcal-master-real');
        // And its integration id is repointed at the LIVE integration (not the deleted one, not absent).
        expect(afterRepair?.lastKnownCalendarIntegrationId).toBe(liveIntegration._id);

        // The rewrite must record a convergence op — otherwise peer devices keep the dead int-OLD-deleted
        // marker in their local IDB forever and their pushback stays skipped. Assert the latest recorded op
        // carries the rewritten (live) integration id.
        const repairOps = await operationsDAO.findArray({ user: userId, entityType: 'routine', entityId: 'routine-same-account' });
        const [latestRepairOp] = repairOps.sort((a, b) => b.ts.localeCompare(a.ts));
        if (!latestRepairOp) throw new Error('expected a repair op for routine-same-account');
        expect(latestRepairOp.snapshot?.lastKnownCalendarIntegrationId).toBe(liveIntegration._id);
    });

    it('cross-account reconnect: a STAMPED different-account marker is left intact (not rewritten, not wiped)', async () => {
        // Genuine cross-account: disconnect-with-keep stamped origin email `other@example.com`, then reconnect
        // authorizes `alice@example.com`. Leave-unlinked: the marker must survive verbatim — wiping would
        // re-arm the outbound backfill (clone events on alice's calendar) and irreversibly sever the
        // original series, killing a later other@ reconnect's ability to relink. Rewriting would lie
        // about the marker's origin account.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-other-account',
                lastKnownCalendarEventId: 'gcal-master-other',
                lastKnownCalendarIntegrationId: 'int-OTHER-deleted',
                lastKnownCalendarSyncConfigId: 'sync-config-OTHER',
                lastKnownCalendarAccountEmail: 'other@example.com',
            }),
        );

        // Reconnect authorizes alice@example.com — a DIFFERENT account than the marker's origin.
        const redirectRes = await authenticatedRequest(app, { method: 'GET', path: '/calendar/auth/google?login_hint=alice@example.com', sessionCookie });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;
        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'B-at', refresh_token: 'B-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        mockUserInfoEmail('alice@example.com');
        const callbackRes = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-B&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(callbackRes.status).toBe(302);

        const afterRepair = await routinesDAO.findByOwnerAndId('routine-other-account', userId);
        // Marker preserved verbatim — the routine stays unlinked (and unpushable) until other@ returns.
        expect(afterRepair?.lastKnownCalendarEventId).toBe('gcal-master-other');
        expect(afterRepair?.lastKnownCalendarIntegrationId).toBe('int-OTHER-deleted');
        expect(afterRepair?.lastKnownCalendarAccountEmail).toBe('other@example.com');
    });
});

// ─── Phase 2: outbound push for all-day + attendees + sendUpdates ─────────────

// Spy on the googleapis events resource via its shared prototype so all `google.calendar()`
// instances (one is created per provider call) route through the same mock. Returns the
// freshly-installed spies; vi.restoreAllMocks in beforeEach clears them between tests.
function spyOnGCalEventsApi() {
    // Each google.calendar() call returns a fresh Resource$Events; the methods we care about
    // live on its shared prototype. Patching the prototype affects every future instance.
    const eventsProto = Object.getPrototypeOf(google.calendar({ version: 'v3' }).events) as Record<string, unknown>;
    type ApiCall = (
        params: unknown,
    ) => Promise<{ data: { id?: string; htmlLink?: string; items?: Array<{ id?: string; originalStartTime?: { dateTime?: string; date?: string } }> } }>;
    const insertSpy = vi.spyOn(eventsProto, 'insert' as keyof typeof eventsProto) as unknown as ReturnType<typeof vi.fn<ApiCall>>;
    const patchSpy = vi.spyOn(eventsProto, 'patch' as keyof typeof eventsProto) as unknown as ReturnType<typeof vi.fn<ApiCall>>;
    // routine-instance overrides hit cal.events.instances first to resolve the master+date → instance id.
    const instancesSpy = vi.spyOn(eventsProto, 'instances' as keyof typeof eventsProto) as unknown as ReturnType<typeof vi.fn<ApiCall>>;
    insertSpy.mockResolvedValue({ data: { id: 'mocked-id' } });
    patchSpy.mockResolvedValue({ data: {} });
    instancesSpy.mockImplementation(async () => ({
        data: { items: [{ id: 'mocked-instance-id', originalStartTime: { date: dayjs().add(1, 'day').format('YYYY-MM-DD') } }] },
    }));
    return { insertSpy, patchSpy, instancesSpy };
}

function getInsertRequestBody(spy: ReturnType<typeof spyOnGCalEventsApi>['insertSpy']) {
    expect(spy).toHaveBeenCalledOnce();
    const [args] = spy.mock.calls;
    if (!args) throw new Error('expected one insert call');
    const [params] = args;
    if (!params || typeof params !== 'object') throw new Error('expected insert params object');
    return params as { requestBody?: Record<string, unknown>; sendUpdates?: string };
}

function getPatchRequestBody(spy: ReturnType<typeof spyOnGCalEventsApi>['patchSpy']) {
    expect(spy).toHaveBeenCalledOnce();
    const [args] = spy.mock.calls;
    if (!args) throw new Error('expected one patch call');
    const [params] = args;
    if (!params || typeof params !== 'object') throw new Error('expected patch params object');
    return params as { requestBody?: Record<string, unknown>; sendUpdates?: string };
}

describe('calendar push-back — all-day items (outbound)', () => {
    it('createEvent for an all-day item emits { date } start/end with no timeZone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // All-day item: timeStart/timeEnd are YYYY-MM-DD strings (GCal's exclusive-end convention).
        const item = makeItem(userId, {
            allDay: true,
            timeStart: '2026-05-27',
            timeEnd: '2026-05-28',
        });
        await itemsDAO.insertOne(item);

        const { insertSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const params = getInsertRequestBody(insertSpy);
        expect(params.requestBody?.start).toEqual({ date: '2026-05-27' });
        expect(params.requestBody?.end).toEqual({ date: '2026-05-28' });
        // No timeZone field at all on the start/end objects — GCal must treat them as owner-local.
        expect(params.requestBody?.start).not.toHaveProperty('timeZone');
        expect(params.requestBody?.end).not.toHaveProperty('timeZone');
    });

    it('updateEvent for an all-day item emits { date } start/end (no timeZone)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-allday-update',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            allDay: true,
            timeStart: '2026-05-27',
            timeEnd: '2026-05-28',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const params = getPatchRequestBody(patchSpy);
        expect(params.requestBody?.start).toEqual({ date: '2026-05-27' });
        expect(params.requestBody?.end).toEqual({ date: '2026-05-28' });
    });

    it('createRecurringEvent for an all-day template emits { date } start/end and the routine rrule', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // All-day calendar routine: template { allDay: true } with no timeOfDay/duration.
        const routine = makeRoutine(userId, {
            _id: 'routine-allday',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            startDate: '2026-05-25',
            calendarItemTemplate: { allDay: true },
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routine);

        const { insertSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        const params = getInsertRequestBody(insertSpy);
        // start.date = the rrule-anchored series start (Monday 2026-05-25). end = start + 1 day.
        expect(params.requestBody?.start).toEqual({ date: '2026-05-25' });
        expect(params.requestBody?.end).toEqual({ date: '2026-05-26' });
        expect(params.requestBody?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    });
});

describe('calendar push-back — htmlLink capture (outbound)', () => {
    // Exercises the real GoogleCalendarProvider mapping (googleapis-level insert mock), not a
    // provider-method mock: the insert response's htmlLink must survive createEvent's return
    // shape and land on the item row in the same write as the link fields.
    it('stamps the insert response htmlLink on the newly linked item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { _id: 'item-htmllink-1' });
        await itemsDAO.insertOne(item);

        const { insertSpy } = spyOnGCalEventsApi();
        insertSpy.mockResolvedValue({ data: { id: 'gcal-htmllink-1', htmlLink: 'https://www.google.com/calendar/event?eid=aHRtbA' } });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const linked = await itemsDAO.findByOwnerAndId('item-htmllink-1', userId);
        expect(linked?.calendarEventId).toBe('gcal-htmllink-1');
        expect(linked?.htmlLink).toBe('https://www.google.com/calendar/event?eid=aHRtbA');
    });
});

describe('calendar push-back — attendees + sendUpdates threading', () => {
    it('updateEvent forwards the full attendees array verbatim in requestBody', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const attendees = [
            { email: 'alice@example.com', responseStatus: 'accepted' as const },
            { email: 'bob@example.com', responseStatus: 'needsAction' as const, displayName: 'Bob' },
        ];
        const item = makeItem(userId, {
            calendarEventId: 'gcal-with-attendees',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            attendees,
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const params = getPatchRequestBody(patchSpy);
        expect(params.requestBody?.attendees).toEqual(attendees);
    });

    it("op gcalMeta.sendUpdates='all' propagates to events.patch sendUpdates param", async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-send-all',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(
            makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item, gcalMeta: { sendUpdates: 'all' } }),
            mockBuildProvider(),
        );

        const params = getPatchRequestBody(patchSpy);
        expect(params.sendUpdates).toBe('all');
    });

    it("op gcalMeta.sendUpdates='all' propagates to events.insert sendUpdates param on create", async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId); // no calendarEventId yet → create path
        await itemsDAO.insertOne(item);

        const { insertSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(
            makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item, gcalMeta: { sendUpdates: 'all' } }),
            mockBuildProvider(),
        );

        const params = getInsertRequestBody(insertSpy);
        expect(params.sendUpdates).toBe('all');
    });

    it("absent gcalMeta defaults sendUpdates to 'none' on events.patch (silent edit)", async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-silent',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        // No gcalMeta on the op → default path.
        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const params = getPatchRequestBody(patchSpy);
        expect(params.sendUpdates).toBe('none');
    });

    it('routine-instance override omits attendees when they match the routine master (server-side detach gate)', async () => {
        // Server-side detach gate: when the snapshot attendees match the routine master attendees,
        // the pushback skips the `attendees` field so a title/time/notes edit does NOT silently
        // fork the instance per RFC 5545. The UI's detach-warning dialog covers the membership-change
        // case; the server gate covers everything else (including replayed legacy ops).
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const masterAttendees = [{ email: 'master-attendee@example.com', responseStatus: 'accepted' as const }];
        const routine = makeRoutine(userId, {
            _id: 'routine-with-attendees-master',
            calendarEventId: 'gcal-master-attendees',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            attendees: masterAttendees,
        });
        await routinesDAO.insertOne(routine);

        const occurrenceTs = dayjs().add(1, 'day').toISOString();
        const item = makeItem(userId, {
            _id: 'item-routine-instance-attendees',
            routineId: routine._id,
            timeStart: occurrenceTs,
            timeEnd: dayjs(occurrenceTs).add(30, 'minute').toISOString(),
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            attendees: masterAttendees, // identical to routine.attendees ⇒ inheritance preserved
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id ?? '', snapshot: item }), mockBuildProvider());

        const params = getPatchRequestBody(patchSpy);
        expect(params.requestBody).not.toHaveProperty('attendees');
    });

    it('routine-instance override forwards attendees when they diverge from the routine master (detach gesture)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const masterAttendees = [{ email: 'master-attendee@example.com', responseStatus: 'accepted' as const }];
        const routine = makeRoutine(userId, {
            _id: 'routine-with-attendees-master-2',
            calendarEventId: 'gcal-master-attendees-2',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            attendees: masterAttendees,
        });
        await routinesDAO.insertOne(routine);

        // User added a second attendee on this specific date — the snapshot diverges from the master.
        const divergentAttendees = [
            { email: 'master-attendee@example.com', responseStatus: 'accepted' as const },
            { email: 'guest@example.com', responseStatus: 'needsAction' as const },
        ];
        const occurrenceTs = dayjs().add(1, 'day').toISOString();
        const item = makeItem(userId, {
            _id: 'item-routine-instance-attendees-2',
            routineId: routine._id,
            timeStart: occurrenceTs,
            timeEnd: dayjs(occurrenceTs).add(30, 'minute').toISOString(),
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            attendees: divergentAttendees,
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id ?? '', snapshot: item }), mockBuildProvider());

        const params = getPatchRequestBody(patchSpy);
        expect(params.requestBody).toHaveProperty('attendees');
        expect(params.requestBody.attendees).toEqual(divergentAttendees);
    });

    it('all-day item done-marker push emits { date } start/end (not { dateTime })', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-allday-done',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            allDay: true,
            timeStart: '2026-05-27',
            timeEnd: '2026-05-28',
            status: 'done',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id ?? '', snapshot: item }), mockBuildProvider());

        const params = getPatchRequestBody(patchSpy);
        expect(params.requestBody?.start).toEqual({ date: '2026-05-27' });
        expect(params.requestBody?.end).toEqual({ date: '2026-05-28' });
    });
});

// ─── Phase 3: RSVP endpoint + scope-missing re-consent ────────────────────────

describe('POST /calendar/items/:itemId/rsvp', () => {
    /** Inserts a linked calendar item with an existing self attendee in `needsAction`. */
    async function insertLinkedCalendarItem(userId: string, overrides: Partial<ItemInterface> = {}): Promise<ItemInterface> {
        const item = makeItem(userId, {
            _id: 'item-rsvp-1',
            calendarEventId: 'gcal-rsvp-ev',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            attendees: [
                { email: 'alice@example.com', responseStatus: 'needsAction', self: true },
                { email: 'organizer@example.com', responseStatus: 'accepted', organizer: true },
            ],
            responseStatus: 'needsAction',
            ...overrides,
        });
        await itemsDAO.insertOne(item);
        return item;
    }

    it('updates the existing self attendee and stamps the item on success', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedCalendarItem(userId);

        // Skip the userinfo round-trip — the spy returns alice's email so it matches the self entry.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValueOnce('alice@example.com');
        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValueOnce(undefined);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(200);

        // sendUpdates:'all' propagates so the organizer sees the chip flip in real time.
        expect(patchSpy).toHaveBeenCalledOnce();
        const [args] = patchSpy.mock.calls;
        if (!args) throw new Error('expected one patch call');
        const [calendarId, eventId, attendees, options] = args;
        expect(calendarId).toBe('primary');
        expect(eventId).toBe('gcal-rsvp-ev');
        expect(options).toEqual({ sendUpdates: 'all' });
        // Attendees sorted by email; self entry updated to accepted; other entries preserved.
        expect(attendees).toEqual([
            { email: 'alice@example.com', responseStatus: 'accepted', self: true },
            { email: 'organizer@example.com', responseStatus: 'accepted', organizer: true },
        ]);

        const stored = await itemsDAO.findByOwnerAndId('item-rsvp-1', userId);
        expect(stored?.responseStatus).toBe('accepted');
        expect(stored?.attendees?.find((a) => a.self)?.responseStatus).toBe('accepted');
        expect(stored?.lastPushedToGCalTs).toBeDefined();
    });

    it("records an opType:'rsvp' op with the rsvp sidecar", async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedCalendarItem(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValueOnce('alice@example.com');
        vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValueOnce(undefined);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'declined' },
        });
        expect(res.status).toBe(200);

        const ops = await operationsDAO.findArray({ user: userId, entityId: 'item-rsvp-1' });
        const rsvpOps = ops.filter((o) => o.opType === 'rsvp');
        expect(rsvpOps).toHaveLength(1);
        const [op] = rsvpOps;
        if (!op) throw new Error('expected one rsvp op');
        expect(op.snapshot).toBeNull();
        expect(op.rsvp).toEqual({
            itemId: 'item-rsvp-1',
            calendarEventId: 'gcal-rsvp-ev',
            calendarIntegrationId: 'int-1',
            responseStatus: 'declined',
        });
    });

    it('appends a self attendee when none exists yet', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedCalendarItem(userId, {
            // No self entry — the user wasn't on the invite list (e.g. delegated mailbox case).
            attendees: [{ email: 'organizer@example.com', responseStatus: 'accepted', organizer: true }],
            responseStatus: undefined,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValueOnce('alice@example.com');
        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValueOnce(undefined);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'tentative' },
        });
        expect(res.status).toBe(200);

        const [args] = patchSpy.mock.calls;
        if (!args) throw new Error('expected one patch call');
        const [, , attendees] = args;
        // Sorted by email — alice comes before organizer alphabetically.
        expect(attendees).toEqual([
            { email: 'alice@example.com', responseStatus: 'tentative', self: true },
            { email: 'organizer@example.com', responseStatus: 'accepted', organizer: true },
        ]);

        const stored = await itemsDAO.findByOwnerAndId('item-rsvp-1', userId);
        expect(stored?.attendees).toHaveLength(2);
        expect(stored?.responseStatus).toBe('tentative');
    });

    it('returns 403 scope_missing when grantedScopes lacks calendar write', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId, {
            // Only the email scope was granted — RSVP requires calendar or calendar.events.
            grantedScopes: ['https://www.googleapis.com/auth/userinfo.email'],
        });
        await insertLinkedCalendarItem(userId);

        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValueOnce(undefined);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string; reconsentUrl: string };
        expect(body.error).toBe('scope_missing');
        expect(body.reconsentUrl).toContain('/calendar/auth/google');
        expect(body.reconsentUrl).toContain('intent=rsvp');
        // The active session is alice@example.com (set up by oauthLogin); login_hint pre-fills the picker.
        expect(body.reconsentUrl).toContain('login_hint=alice');

        // No push was attempted — the gate rejected before reaching the provider.
        expect(patchSpy).not.toHaveBeenCalled();
    });

    it('treats absent grantedScopes as permissive (legacy integrations)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // grantedScopes omitted — the integration predates Phase 3 scope persistence.
        await insertIntegrationWithConfig(userId);
        await insertLinkedCalendarItem(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValueOnce('alice@example.com');
        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValueOnce(undefined);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(200);
        expect(patchSpy).toHaveBeenCalledOnce();
    });

    it('returns 404 when the item does not exist', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/no-such-item/rsvp',
            sessionCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(404);
    });

    it('returns 400 when the item is not a calendar item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // nextAction item — no calendarEventId either, so the calendar-shape guard rejects.
        await itemsDAO.insertOne(makeItem(userId, { _id: 'item-na-1', status: 'nextAction', calendarEventId: undefined, calendarIntegrationId: undefined }));

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-na-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(400);
    });

    it('returns 400 when responseStatus is invalid', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedCalendarItem(userId);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'maybe' },
        });
        expect(res.status).toBe(400);
    });

    it('returns 500 rsvp_push_failed and does not mutate the local item when the GCal patch throws', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedCalendarItem(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValueOnce('alice@example.com');
        vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockRejectedValueOnce(new Error('gcal exploded'));

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error: string; message: string };
        expect(body.error).toBe('rsvp_push_failed');
        expect(body.message).toContain('gcal exploded');

        // Local state unchanged — the client is expected to roll back its optimistic UI.
        const stored = await itemsDAO.findByOwnerAndId('item-rsvp-1', userId);
        expect(stored?.responseStatus).toBe('needsAction');
    });

    it("tenant isolation: user B cannot RSVP on user A's calendar item (returns 404)", async () => {
        // Set up user A with a calendar item.
        const aliceCookie = await loginAsAlice();
        const aliceId = await getUserId(aliceCookie);
        await insertIntegrationWithConfig(aliceId);
        await insertLinkedCalendarItem(aliceId);

        // Log in as user B via GitHub — Google's test mock always returns sub:g1, so a second
        // Google login would link back to alice. Routing bob through GitHub gives us a distinct user.
        const { sessionCookie: bobCookieRaw } = await oauthLogin(app, 'github', { email: 'bob@example.com', login: 'bob-gh' });
        if (!bobCookieRaw) throw new Error('expected bob session cookie');
        const bobCookie = bobCookieRaw;
        const bobId = await getUserId(bobCookie);
        expect(bobId).not.toBe(aliceId);

        // No spies set up — if isolation fails and the handler reaches the provider, the test
        // crashes on the unmocked network call, surfacing the leak loud and clear.
        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie: bobCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(404);

        // Alice's item is untouched.
        const aliceItem = await itemsDAO.findByOwnerAndId('item-rsvp-1', aliceId);
        expect(aliceItem?.responseStatus).toBe('needsAction');
    });
});

// ─── Active relink sweep (stranded lastKnown* markers) ───────────────────────

describe('relink sweep — active resolution of stranded lastKnown* markers', () => {
    const FUTURE_START = dayjs().add(5, 'day').startOf('hour').toISOString();
    const FUTURE_END = dayjs().add(5, 'day').startOf('hour').add(30, 'minute').toISOString();
    const LOCAL_EDIT_START = dayjs().add(9, 'day').startOf('hour').toISOString();
    const LOCAL_EDIT_END = dayjs().add(9, 'day').startOf('hour').add(30, 'minute').toISOString();

    /** Seeds alice + a live integration (accountEmail stamped) and mocks an empty full sync so the sweep is the only actor. */
    async function seedSweepFixture() {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const { integration, config } = await insertIntegrationWithConfig(userId, { accountEmail: 'alice@example.com' });
        // No syncToken on the config → the manual sync runs a FULL sync → the sweep fires after import.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-sweep' });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        return { sessionCookie, userId, integration, config };
    }

    function makeMarkerItem(userId: string, overrides: Partial<ItemInterface> = {}): ItemInterface {
        const contact = dayjs().subtract(7, 'day').toISOString();
        return {
            _id: 'item-stranded',
            user: userId,
            status: 'calendar',
            title: 'Return the booster',
            timeStart: FUTURE_START,
            timeEnd: FUTURE_END,
            createdTs: contact,
            updatedTs: contact,
            lastPushedToGCalTs: contact,
            lastSyncedFromGCalTs: contact,
            lastKnownCalendarEventId: 'gtd-stranded-event',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-dead',
            lastKnownCalendarAccountEmail: 'alice@example.com',
            ...overrides,
        };
    }

    /** GCal event frozen at the last agreed state: updated == the item's last contact anchor. */
    function makeFrozenEvent(item: ItemInterface) {
        return {
            id: 'gtd-stranded-event',
            title: item.title,
            timeStart: item.timeStart ?? FUTURE_START,
            timeEnd: item.timeEnd ?? FUTURE_END,
            updated: item.lastSyncedFromGCalTs ?? dayjs().subtract(7, 'day').toISOString(),
            status: 'confirmed' as const,
        };
    }

    async function runManualSync(sessionCookie: string, integrationId: string) {
        const res = await authenticatedRequest(app, { method: 'POST', path: `/calendar/integrations/${integrationId}/sync`, sessionCookie });
        expect(res.status).toBe(200);
    }

    it('relinks a locally-edited item against an unmodified event and pushes the local state to GCal (the stranded-reschedule bug)', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        // The b50e8cd3 shape: item rescheduled in-app AFTER the disconnect; the GCal event is frozen
        // at the old time and was never modified since → no sync window would ever surface it.
        const seeded = makeMarkerItem(userId, { timeStart: LOCAL_EDIT_START, timeEnd: LOCAL_EDIT_END, updatedTs: dayjs().toISOString() });
        await itemsDAO.insertOne(seeded);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(makeFrozenEvent({ ...seeded, timeStart: FUTURE_START, timeEnd: FUTURE_END }));
        const updateEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        await runManualSync(sessionCookie, integration._id);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.calendarEventId).toBe('gtd-stranded-event');
        expect(item?.calendarIntegrationId).toBe(integration._id);
        expect(item?.calendarSyncConfigId).toBe('sync-config-1');
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
        expect(item?.lastKnownCalendarAccountEmail).toBeUndefined();
        // Local state won: the rescheduled time was pushed out to GCal.
        expect(updateEventSpy).toHaveBeenCalledTimes(1);
        const [, eventId, updates] = updateEventSpy.mock.calls[0]!;
        expect(eventId).toBe('gtd-stranded-event');
        expect(updates.timeStart).toBe(LOCAL_EDIT_START);
        // The push stamped the item so the webhook echo of our own update is suppressed.
        const stamped = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(stamped?.lastPushedToGCalTs).toBeDefined();
        expect(dayjs(stamped?.lastPushedToGCalTs).isAfter(dayjs().subtract(1, 'minute'))).toBe(true);
    });

    it('relinks an untouched item against a GCal-edited event and applies the event state locally', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId);
        await itemsDAO.insertOne(seeded);
        // GCal moved the event while disconnected; the app item was never edited.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue({
            ...makeFrozenEvent(seeded),
            timeStart: LOCAL_EDIT_START,
            timeEnd: LOCAL_EDIT_END,
            updated: dayjs().subtract(1, 'day').toISOString(),
        });
        const updateEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        await runManualSync(sessionCookie, integration._id);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.calendarEventId).toBe('gtd-stranded-event');
        expect(item?.timeStart).toBe(LOCAL_EDIT_START);
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
        expect(updateEventSpy).not.toHaveBeenCalled();
    });

    it('relinks a content-equal marker quietly and a second sweep run records nothing (idempotent)', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId);
        await itemsDAO.insertOne(seeded);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(makeFrozenEvent(seeded));
        const updateEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        await runManualSync(sessionCookie, integration._id);
        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.calendarEventId).toBe('gtd-stranded-event');
        expect(updateEventSpy).not.toHaveBeenCalled();
        const opsAfterFirst = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-stranded' });
        expect(opsAfterFirst).toHaveLength(1); // the restore op only

        // Clear the syncToken so the second manual sync is a FULL sync again — the sweep must re-run.
        // The full snapshot must now INCLUDE the event (the item is linked, and a snapshot missing it
        // would legitimately trigger the vanished-event reconcile) — the first sync omitted it to
        // model the stranded case, where the event sits outside the snapshot window.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [makeFrozenEvent(seeded)],
            nextSyncToken: 'tok-sweep-2',
        });
        await calendarSyncConfigsDAO.upsertSyncToken('sync-config-1', '', dayjs().toISOString());
        await runManualSync(sessionCookie, integration._id);
        const opsAfterSecond = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-stranded' });
        expect(opsAfterSecond).toHaveLength(1); // no marker left — the sweep had nothing to do
    });

    it('recreates the GCal event for a locally-edited item whose event is gone (hybrid: local wins)', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId, { timeStart: LOCAL_EDIT_START, timeEnd: LOCAL_EDIT_END, updatedTs: dayjs().toISOString() });
        await itemsDAO.insertOne(seeded);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);
        const createEventSpy = vi
            .spyOn(GoogleCalendarProvider.prototype, 'createEvent')
            .mockResolvedValue({ eventId: 'recreated-event-id', htmlLink: 'https://cal.example/recreated' });

        await runManualSync(sessionCookie, integration._id);

        expect(createEventSpy).toHaveBeenCalledTimes(1);
        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.status).toBe('calendar');
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
        expect(item?.calendarEventId).toBeDefined();
    });

    it('trashes an untouched item whose event was deleted on GCal (hybrid: deletion wins), stamping cancelledByGCal', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId);
        await itemsDAO.insertOne(seeded);
        // A cancellation tombstone newer than the item's last local touch.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue({
            ...makeFrozenEvent(seeded),
            status: 'cancelled',
            updated: dayjs().subtract(1, 'day').toISOString(),
        });
        const createEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'never' });

        await runManualSync(sessionCookie, integration._id);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.status).toBe('trash');
        expect(item?.cancelledByGCal).toBe(true);
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
        expect(createEventSpy).not.toHaveBeenCalled();
    });

    it('clears markers on a done item whose event is gone without trashing or recreating', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId, { status: 'done' });
        await itemsDAO.insertOne(seeded);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);
        const createEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'never' });

        await runManualSync(sessionCookie, integration._id);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.status).toBe('done');
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
        expect(createEventSpy).not.toHaveBeenCalled();
    });

    it('never touches a marker stamped with a different account email — not even a lookup', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId, {
            lastKnownCalendarIntegrationId: 'int-WORK-dead',
            lastKnownCalendarAccountEmail: 'work@example.com',
        });
        await itemsDAO.insertOne(seeded);
        const getEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);

        await runManualSync(sessionCookie, integration._id);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.lastKnownCalendarEventId).toBe('gtd-stranded-event');
        expect(item?.lastKnownCalendarAccountEmail).toBe('work@example.com');
        expect(getEventSpy).not.toHaveBeenCalled();
    });

    it('relinks a legacy email-less marker when its event resolves, but skips it (no trash/recreate) when it does not', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        // Legacy marker: no origin email, dead integration id → provenance unproven.
        const resolvable = makeMarkerItem(userId, {
            _id: 'item-legacy-found',
            lastKnownCalendarEventId: 'legacy-found-event',
            lastKnownCalendarIntegrationId: 'int-legacy-dead',
        });
        const { lastKnownCalendarAccountEmail: _dropA, ...legacyFound } = resolvable;
        const unresolvable = makeMarkerItem(userId, {
            _id: 'item-legacy-missing',
            title: 'Other legacy',
            lastKnownCalendarEventId: 'legacy-missing-event',
            lastKnownCalendarIntegrationId: 'int-legacy-dead',
        });
        const { lastKnownCalendarAccountEmail: _dropB, ...legacyMissing } = unresolvable;
        await itemsDAO.insertOne(legacyFound);
        await itemsDAO.insertOne(legacyMissing);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockImplementation(async (_calendarId: string, eventId: string) =>
            eventId === 'legacy-found-event' ? { ...makeFrozenEvent(legacyFound), id: 'legacy-found-event' } : null,
        );

        await runManualSync(sessionCookie, integration._id);

        // Found on this account's calendar → safe to relink.
        const found = await itemsDAO.findByOwnerAndId('item-legacy-found', userId);
        expect(found?.calendarEventId).toBe('legacy-found-event');
        // Not found → could belong to an account we can't see: left untouched, NOT trashed.
        const missing = await itemsDAO.findByOwnerAndId('item-legacy-missing', userId);
        expect(missing?.status).toBe('calendar');
        expect(missing?.lastKnownCalendarEventId).toBe('legacy-missing-event');
    });

    it('restores a stranded routine through the full import path when its master resolves live', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-stranded',
                active: false,
                updatedTs: dayjs().subtract(7, 'day').toISOString(),
                lastKnownCalendarEventId: 'gcal-stranded-master',
                lastKnownCalendarIntegrationId: 'int-1',
                lastKnownCalendarSyncConfigId: 'sync-config-dead',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue({
            id: 'gcal-stranded-master',
            title: 'Standup',
            timeStart: FUTURE_START,
            timeEnd: FUTURE_END,
            updated: dayjs().subtract(6, 'day').toISOString(),
            status: 'confirmed',
            recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        });

        await runManualSync(sessionCookie, integration._id);

        const routine = await routinesDAO.findByOwnerAndId('routine-stranded', userId);
        expect(routine?.calendarEventId).toBe('gcal-stranded-master');
        expect(routine?.calendarIntegrationId).toBe(integration._id);
        expect(routine?.lastKnownCalendarEventId).toBeUndefined();
        // Open inbound rrule + inactive local → the disconnect-inflicted pause is lifted.
        expect(routine?.active).toBe(true);
    });

    it('recreates a fresh series for an active routine whose master is hard-gone, and deactivates an inactive one on a newer tombstone', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-recreate',
                active: true,
                lastKnownCalendarEventId: 'gcal-gone-master',
                lastKnownCalendarIntegrationId: 'int-1',
                lastKnownCalendarSyncConfigId: 'sync-config-dead',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);
        const createSeriesSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('fresh-master-id');

        await runManualSync(sessionCookie, integration._id);

        expect(createSeriesSpy).toHaveBeenCalledTimes(1);
        const routine = await routinesDAO.findByOwnerAndId('routine-recreate', userId);
        expect(routine?.lastKnownCalendarEventId).toBeUndefined();
        expect(routine?.active).toBe(true);
        expect(routine?.calendarEventId).toBeDefined();
    });

    it('deactivation path: an active routine whose master was cancelled AFTER its last local touch is deactivated, future items trashed', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const staleTouch = dayjs().subtract(7, 'day').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-deactivate',
                active: true,
                updatedTs: staleTouch,
                lastKnownCalendarEventId: 'gcal-cancelled-master',
                lastKnownCalendarIntegrationId: 'int-1',
                lastKnownCalendarSyncConfigId: 'sync-config-dead',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-future-occurrence',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-deactivate',
            timeStart: FUTURE_START,
            timeEnd: FUTURE_END,
            createdTs: staleTouch,
            updatedTs: staleTouch,
        });
        // Cancellation tombstone NEWER than the routine's last local touch → deletion wins.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue({
            id: 'gcal-cancelled-master',
            title: '',
            timeStart: '',
            timeEnd: '',
            updated: dayjs().subtract(1, 'day').toISOString(),
            status: 'cancelled',
        });
        const createSeriesSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('never');

        await runManualSync(sessionCookie, integration._id);

        expect(createSeriesSpy).not.toHaveBeenCalled();
        const routine = await routinesDAO.findByOwnerAndId('routine-deactivate', userId);
        expect(routine?.active).toBe(false);
        expect(routine?.lastKnownCalendarEventId).toBeUndefined();
        const occurrence = await itemsDAO.findByOwnerAndId('item-future-occurrence', userId);
        expect(occurrence?.status).toBe('trash');
    });

    it('POST /maintenance/relink-calendar-markers heals a stranded item on demand and reports counts', async () => {
        const maintenanceApp = new Hono()
            .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
            .route('/calendar', calendarRoutes)
            .route('/maintenance', maintenanceRoutes);
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId);
        await itemsDAO.insertOne(seeded);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(makeFrozenEvent(seeded));

        const res = await authenticatedRequest(maintenanceApp, { method: 'POST', path: '/maintenance/relink-calendar-markers', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { relinkedItems: number };
        expect(body.relinkedItems).toBe(1);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.calendarEventId).toBe('gtd-stranded-event');
        expect(item?.calendarIntegrationId).toBe(integration._id);
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
    });

    it("POST /maintenance/relink-calendar-markers is tenant-isolated — another user's markers stay untouched", async () => {
        const maintenanceApp = new Hono()
            .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
            .route('/calendar', calendarRoutes)
            .route('/maintenance', maintenanceRoutes);
        const { sessionCookie } = await seedSweepFixture();
        // A second user (bob) with the same-shaped stranded marker AND a live integration of his own.
        const { sessionCookie: bobCookieRaw } = await oauthLogin(app, 'github');
        if (!bobCookieRaw) throw new Error('expected bob session cookie');
        const bobId = await getUserId(bobCookieRaw);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(bobId, { _id: 'int-bob', accountEmail: 'alice@example.com' }));
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(bobId, 'int-bob', { _id: 'sync-config-bob' }));
        const bobMarkerItem = makeMarkerItem(bobId, { _id: 'item-bob-stranded', lastKnownCalendarIntegrationId: 'int-bob' });
        await itemsDAO.insertOne(bobMarkerItem);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(makeFrozenEvent(bobMarkerItem));

        // Alice's sweep: she has no markers, and bob's must not be visible to her session.
        const res = await authenticatedRequest(maintenanceApp, { method: 'POST', path: '/maintenance/relink-calendar-markers', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { relinkedItems: number; trashedItems: number; recreatedEvents: number };
        expect(body.relinkedItems).toBe(0);
        expect(body.trashedItems).toBe(0);
        expect(body.recreatedEvents).toBe(0);

        const bobItem = await itemsDAO.findByOwnerAndId('item-bob-stranded', bobId);
        expect(bobItem?.lastKnownCalendarEventId).toBe('gtd-stranded-event');
        expect(bobItem?.calendarEventId).toBeUndefined();
    });

    it('relinks a done marker item against its live event quietly — no outbound push, done stays done', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        // Done items keep their timeStart/timeEnd; on GCal the event carries the "✓ " done marker
        // in its title, which the content comparison must strip before deciding anything changed.
        const seeded = makeMarkerItem(userId, { status: 'done' });
        await itemsDAO.insertOne(seeded);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue({
            ...makeFrozenEvent(seeded),
            title: `✓ ${seeded.title}`,
        });
        const updateEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        await runManualSync(sessionCookie, integration._id);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.status).toBe('done');
        expect(item?.calendarEventId).toBe('gtd-stranded-event');
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
        expect(updateEventSpy).not.toHaveBeenCalled();
    });

    // ── Split-successor markers (calendarRebasedEventId) ─────────────────────
    // After a "this and all following" split, the live master lives under the raw `_R<anchor>` id
    // while the bare id is the capped stump. A successor marker routine must therefore resolve
    // against its OWN rebased master — fetching only the bare id can never relink it.

    const REBASED_ID = 'gcal-split-base_R20260601T060000Z';
    const BARE_ID = 'gcal-split-base';

    function makeSuccessorMarkerRoutine(userId: string, overrides: Partial<RoutineInterface> = {}) {
        return makeRoutine(userId, {
            _id: 'routine-split-successor',
            active: false,
            updatedTs: dayjs().subtract(7, 'day').toISOString(),
            calendarRebasedEventId: REBASED_ID,
            lastKnownCalendarEventId: BARE_ID,
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-dead',
            lastKnownCalendarAccountEmail: 'alice@example.com',
            ...overrides,
        });
    }

    function makeLiveRebasedMaster() {
        return {
            id: REBASED_ID,
            title: 'Standup',
            timeStart: FUTURE_START,
            timeEnd: FUTURE_END,
            updated: dayjs().subtract(6, 'day').toISOString(),
            status: 'confirmed' as const,
            recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        };
    }

    it('relinks a stranded split-successor routine through its rebased _R master — the bare stump id is never fetched', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        await routinesDAO.insertOne(makeSuccessorMarkerRoutine(userId));
        const getEventSpy = vi
            .spyOn(GoogleCalendarProvider.prototype, 'getEvent')
            .mockImplementation(async (_calendarId: string, eventId: string) => (eventId === REBASED_ID ? makeLiveRebasedMaster() : null));

        await runManualSync(sessionCookie, integration._id);

        const routine = await routinesDAO.findByOwnerAndId('routine-split-successor', userId);
        // Linked on the BARE id (GCal instance ids use it), with the rebased idempotency key preserved.
        expect(routine?.calendarEventId).toBe(BARE_ID);
        expect(routine?.calendarIntegrationId).toBe(integration._id);
        expect(routine?.calendarRebasedEventId).toBe(REBASED_ID);
        expect(routine?.lastKnownCalendarEventId).toBeUndefined();
        expect(routine?.lastKnownCalendarAccountEmail).toBeUndefined();
        // Open inbound rrule + inactive local → the disconnect-inflicted pause is lifted.
        expect(routine?.active).toBe(true);
        expect(getEventSpy.mock.calls.every(([, eventId]) => eventId === REBASED_ID)).toBe(true);
    });

    it('a gone bare master never gone-resolves a successor whose own master is alive: base sheds markers, successor relinks', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const staleTouch = dayjs().subtract(7, 'day').toISOString();
        // The capped base of the split, also stranded — inactive, as the disconnect cascade left it.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-split-base',
                active: false,
                updatedTs: staleTouch,
                rrule: `FREQ=WEEKLY;BYDAY=MO;UNTIL=${dayjs().subtract(30, 'day').format('YYYYMMDD')}T000000Z`,
                lastKnownCalendarEventId: BARE_ID,
                lastKnownCalendarIntegrationId: 'int-1',
                lastKnownCalendarSyncConfigId: 'sync-config-dead',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        await routinesDAO.insertOne(makeSuccessorMarkerRoutine(userId));
        // The user deleted the capped stump on GCal (tombstone newer than any local touch) while the
        // successor series lives on — the old grouped-by-bare-id sweep would have gone-resolved BOTH.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockImplementation(async (_calendarId: string, eventId: string) => {
            if (eventId === REBASED_ID) {
                return makeLiveRebasedMaster();
            }
            if (eventId === BARE_ID) {
                return { id: BARE_ID, title: '', timeStart: '', timeEnd: '', updated: dayjs().subtract(1, 'day').toISOString(), status: 'cancelled' as const };
            }
            return null;
        });
        const createSeriesSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('never');

        await runManualSync(sessionCookie, integration._id);

        // Base: inactive + newer tombstone → deletion wins quietly (markers cleared, stays inactive).
        const base = await routinesDAO.findByOwnerAndId('routine-split-base', userId);
        expect(base?.lastKnownCalendarEventId).toBeUndefined();
        expect(base?.active).toBe(false);
        expect(base?.calendarEventId).toBeUndefined();
        // Successor: relinked and reactivated against its own live master, untouched by the tombstone.
        const successor = await routinesDAO.findByOwnerAndId('routine-split-successor', userId);
        expect(successor?.calendarEventId).toBe(BARE_ID);
        expect(successor?.active).toBe(true);
        expect(successor?.lastKnownCalendarEventId).toBeUndefined();
        expect(createSeriesSpy).not.toHaveBeenCalled();
    });

    it('never touches a split-successor marker stamped with a different account email — not even a rebased-id lookup', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        await routinesDAO.insertOne(
            makeSuccessorMarkerRoutine(userId, {
                lastKnownCalendarIntegrationId: 'int-WORK-dead',
                lastKnownCalendarAccountEmail: 'work@example.com',
            }),
        );
        const getEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);

        await runManualSync(sessionCookie, integration._id);

        const routine = await routinesDAO.findByOwnerAndId('routine-split-successor', userId);
        expect(routine?.lastKnownCalendarEventId).toBe(BARE_ID);
        expect(routine?.lastKnownCalendarAccountEmail).toBe('work@example.com');
        expect(routine?.active).toBe(false);
        expect(getEventSpy).not.toHaveBeenCalled();
    });

    it('recreates a fresh series for an ACTIVE split successor whose rebased master is hard-gone', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        await routinesDAO.insertOne(makeSuccessorMarkerRoutine(userId, { active: true, updatedTs: dayjs().toISOString() }));
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);
        const createSeriesSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('fresh-successor-series');

        await runManualSync(sessionCookie, integration._id);

        expect(createSeriesSpy).toHaveBeenCalledTimes(1);
        const routine = await routinesDAO.findByOwnerAndId('routine-split-successor', userId);
        expect(routine?.lastKnownCalendarEventId).toBeUndefined();
        expect(routine?.active).toBe(true);
        expect(routine?.calendarEventId).toBeDefined();
    });
});

// ─── Master-linked standalone item convergence ─────────────────────────────
//
// A GCal event can be synced as a standalone one-off item BEFORE its series is recognized as a
// routine (`recurrence` not visible at first sight). The leftover item then links straight to the
// series MASTER — marking it done used to PATCH the ✓ marker + sage colorId onto the master,
// flagging every future occurrence done for all attendees, and the ✓ then round-tripped into the
// routine's and open items' stored titles. Two layers of defense are covered here:
//  1. import-side absorb: importing (or re-reporting) a recurring master converges any standalone
//     item still linked to it — open duplicates are trashed, done ones are unlinked;
//  2. pushback-side guard: a master-linked item push reroutes to a single-instance override and
//     never PATCHes or deletes the master itself.

describe('recurring-master import absorbs master-linked standalone items', () => {
    const tomorrowAt9 = () => dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
    const tomorrowAt10 = () => dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T10:00:00`, 'Asia/Jerusalem').format();

    function mockMasterInFullSync() {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-absorb',
                    title: 'Daily standup',
                    timeStart: tomorrowAt9(),
                    timeEnd: tomorrowAt10(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-absorb',
        });
    }

    function makeMasterLinkedStandaloneItem(userId: string, overrides: Partial<ItemInterface> = {}) {
        return makeItem(userId, {
            _id: 'item-master-dup',
            title: 'Daily standup',
            calendarEventId: 'gcal-master-absorb',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            timeStart: tomorrowAt9(),
            timeEnd: tomorrowAt10(),
            ...overrides,
        });
    }

    it('trashes an open standalone duplicate when the series is imported as a routine', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await itemsDAO.insertOne(makeMasterLinkedStandaloneItem(userId));
        mockMasterInFullSync();

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ user: userId, calendarEventId: 'gcal-master-absorb' });
        expect(routine).not.toBeNull();
        // The standalone duplicate no longer competes with the routine's generated items.
        const absorbed = await itemsDAO.findByOwnerAndId('item-master-dup', userId);
        expect(absorbed?.status).toBe('trash');
        // The convergence rode the operation log so other devices apply it too.
        const ops = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-master-dup' });
        expect(ops).toHaveLength(1);
        expect(ops[0]!.snapshot).toMatchObject({ status: 'trash' });
    });

    it('unlinks (not trashes) a done standalone duplicate so the completion record survives', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await itemsDAO.insertOne(makeMasterLinkedStandaloneItem(userId, { status: 'done' }));
        mockMasterInFullSync();

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const absorbed = await itemsDAO.findByOwnerAndId('item-master-dup', userId);
        expect(absorbed?.status).toBe('done');
        expect(absorbed?.calendarEventId).toBeUndefined();
        const ops = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-master-dup' });
        expect(ops).toHaveLength(1);
        expect(ops[0]!.snapshot).toMatchObject({ status: 'done' });
        expect(ops[0]!.snapshot).not.toHaveProperty('calendarEventId');
    });

    it('self-heals pre-existing damage: a master re-report absorbs the duplicate via updateRoutineFromGCal', async () => {
        // The routine already exists (imported before the absorb fix) and the standalone duplicate
        // lingers — the next re-report of the master must converge it even though the routine's
        // schedule may be structurally unchanged.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-absorb-existing',
                title: 'Daily standup',
                rrule: 'FREQ=DAILY',
                calendarEventId: 'gcal-master-absorb',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        await itemsDAO.insertOne(makeMasterLinkedStandaloneItem(userId));
        mockMasterInFullSync();

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const absorbed = await itemsDAO.findByOwnerAndId('item-master-dup', userId);
        expect(absorbed?.status).toBe('trash');
        // No second routine was minted for the same series.
        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: 'gcal-master-absorb' });
        expect(routines).toHaveLength(1);
    });
});

describe('pushback guard — item linked to a recurring MASTER event', () => {
    async function insertMasterRoutine(userId: string, overrides: Partial<RoutineInterface> = {}) {
        const routine = makeRoutine(userId, {
            _id: 'routine-master-guard',
            title: 'Daily standup',
            calendarEventId: 'recurring-master-guard',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            ...overrides,
        });
        await routinesDAO.insertOne(routine);
        return routine;
    }

    function makeMasterLinkedItem(userId: string, overrides: Partial<ItemInterface> = {}) {
        return makeItem(userId, {
            _id: 'item-master-linked',
            title: 'Daily standup',
            calendarEventId: 'recurring-master-guard',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            ...overrides,
        });
    }

    it('marking a master-linked item done patches a single instance override — never the master', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertMasterRoutine(userId);
        const item = makeMasterLinkedItem(userId, { status: 'done' });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);
        const instanceSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        // The whole-event PATCH (which would have applied the ✓ + sage color to EVERY occurrence
        // of the series) must never fire against a master id.
        expect(updateSpy).not.toHaveBeenCalled();
        expect(instanceSpy).toHaveBeenCalledOnce();
        const [eventId, originalDate, updates] = instanceSpy.mock.calls[0]!;
        expect(eventId).toBe('recurring-master-guard');
        expect(originalDate).toBe(dayjs(item.timeStart).format('YYYY-MM-DD'));
        expect(updates).toMatchObject({ title: '✓ Daily standup', colorId: '2' });
        // The reroute stamps the push anchor like any other instance override.
        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated?.lastPushedToGCalTs).toBeTruthy();
    });

    it('a generic edit of a master-linked item reroutes to an instance override too', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertMasterRoutine(userId);
        const item = makeMasterLinkedItem(userId, { status: 'calendar' });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);
        const instanceSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).not.toHaveBeenCalled();
        expect(instanceSpy).toHaveBeenCalledOnce();
        const updates = instanceSpy.mock.calls[0]![2];
        expect(updates).toMatchObject({ title: 'Daily standup', colorId: null });
    });

    it('trashing a master-linked item skips the delete — never removes the series', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertMasterRoutine(userId);
        const item = makeMasterLinkedItem(userId, { status: 'trash' });
        await itemsDAO.insertOne(item);

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);
        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(deleteSpy).not.toHaveBeenCalled();
        expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('hard-deleting a master-linked item skips the GCal delete — never removes the series', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertMasterRoutine(userId);
        const item = makeMasterLinkedItem(userId, { status: 'calendar' });

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        // Delete ops arrive with the pre-delete row hydrated as the snapshot.
        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, opType: 'delete', snapshot: item }), mockBuildProvider());

        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('reroutes onto the ACTIVE split successor, not the capped base, when a split shares the bare id', async () => {
        // After "this and all following", the capped inactive base and the live successor
        // legitimately coexist on ONE bare calendarEventId (the unique index is active-partial).
        // The reroute must resolve the successor: the base's capped rrule and retired sync config
        // would make the instance-window lookup come up empty and silently drop the push. The base
        // carries the NEWER updatedTs to prove selection is by `active`, not recency.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertMasterRoutine(userId, {
            _id: 'routine-split-capped-base',
            active: false,
            rrule: 'FREQ=DAILY;UNTIL=20260101T000000Z',
            updatedTs: dayjs().toISOString(),
            routineExceptions: [{ date: '2026-01-01', type: 'modified', itemId: 'item-master-linked' }],
        });
        await insertMasterRoutine(userId, {
            _id: 'routine-split-live-successor',
            active: true,
            updatedTs: dayjs().subtract(1, 'day').toISOString(),
            routineExceptions: [{ date: '2026-09-01', type: 'modified', itemId: 'item-master-linked' }],
        });
        const item = makeMasterLinkedItem(userId, { status: 'done' });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);
        const instanceSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).not.toHaveBeenCalled();
        expect(instanceSpy).toHaveBeenCalledOnce();
        // The originalDate comes from the resolved routine's `modified` exception for this item —
        // 2026-09-01 proves the successor supplied the context, not the newer-updatedTs base.
        const [, originalDate] = instanceSpy.mock.calls[0]!;
        expect(originalDate).toBe('2026-09-01');
    });

    it("does not forward the duplicate item's import-frozen attendees — the occurrence keeps inheriting from the master", async () => {
        // The standalone duplicate's attendees snapshot dates from import and is never refreshed
        // (master ids route to the routine import path). An RSVP since then would read as
        // divergence and permanently fork this occurrence off the master's list (RFC 5545
        // per-instance attendee override) — for what the user experienced as ticking a checkbox.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertMasterRoutine(userId, {
            attendees: [
                { email: 'a@example.com', responseStatus: 'accepted' },
                { email: 'b@example.com', responseStatus: 'needsAction' },
            ],
        });
        const item = makeMasterLinkedItem(userId, {
            status: 'done',
            // Frozen pre-RSVP snapshot — differs from the routine's current list.
            attendees: [
                { email: 'a@example.com', responseStatus: 'needsAction' },
                { email: 'b@example.com', responseStatus: 'needsAction' },
            ],
        });
        await itemsDAO.insertOne(item);

        const instanceSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(instanceSpy).toHaveBeenCalledOnce();
        expect(instanceSpy.mock.calls[0]![2]).not.toHaveProperty('attendees');
    });
});
