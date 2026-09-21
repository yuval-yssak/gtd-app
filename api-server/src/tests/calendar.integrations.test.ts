/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { google } from 'googleapis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { auth, db } from '../loaders/mainLoader.js';
import type { CalendarSyncConfigInterface, ItemInterface } from '../types/entities.js';
import {
    app,
    getUserId,
    insertIntegrationWithConfig,
    loginAsAlice,
    makeIntegration,
    makeRoutine,
    makeSyncConfig,
    mockUserInfoEmail,
    useCalendarTestLifecycle,
} from './calendarTestKit.js';
import { authenticatedRequest, SESSION_COOKIE } from './helpers.js';

useCalendarTestLifecycle();

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

// Regression: `listEvents` used to issue a single un-paginated `events.list` call — Google defaults
// to 250 results/page and truncates SILENTLY. Callers treat the result as a complete window
// snapshot; the split-chain walk in particular reads "no continuation instance in the window" as
// proof a series is over and retires the routine, so a truncated page must never masquerade as
// absence.
describe('GoogleCalendarProvider.listEvents — pagination', () => {
    it('follows nextPageToken across pages and returns the union of all pages', async () => {
        const eventsProto = Object.getPrototypeOf(google.calendar({ version: 'v3' }).events) as Record<string, unknown>;
        type ListCall = (params: { pageToken?: string }) => Promise<{ data: { items?: unknown[]; nextPageToken?: string } }>;
        const listSpy = vi.spyOn(eventsProto, 'list' as keyof typeof eventsProto) as unknown as ReturnType<typeof vi.fn<ListCall>>;
        const pageItem = (id: string) => ({
            id,
            summary: `Event ${id}`,
            start: { dateTime: '2026-05-26T12:30:00Z' },
            end: { dateTime: '2026-05-26T13:00:00Z' },
            updated: '2026-05-01T00:00:00Z',
            status: 'confirmed',
        });
        listSpy.mockImplementation((params) => {
            if (!params.pageToken) {
                return Promise.resolve({ data: { items: [pageItem('page1-event')], nextPageToken: 'page-2' } });
            }
            expect(params.pageToken).toBe('page-2');
            return Promise.resolve({ data: { items: [pageItem('page2-event')] } });
        });

        const provider = new GoogleCalendarProvider(makeIntegration('user-1'));
        const events = await provider.listEvents('cal-1', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');

        expect(listSpy).toHaveBeenCalledTimes(2);
        expect(events.map((e) => e.id)).toEqual(['page1-event', 'page2-event']);
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
