/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { maybePushToGCal } from '../lib/calendarPushback.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { calendarRoutes } from '../routes/calendar.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface, ItemInterface, OperationInterface, RoutineInterface } from '../types/entities.js';
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
    ]);
    vi.restoreAllMocks();
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
        expect(location).toContain('calendar');
        // state must be present and HMAC-signed (verified below in callback test)
        expect(new URL(location).searchParams.get('state')).toBeTruthy();
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

        const res = await app.fetch(new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-code&state=${state}`));
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('calendarConnected=1');

        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        expect(integrations).toHaveLength(1);
        expect(integrations[0]!.user).toBe(userId);
        expect(integrations[0]!.provider).toBe('google');
        expect(integrations[0]!.accessToken).toBe('test-at');
        expect(integrations[0]!.refreshToken).toBe('test-rt');
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
            { id: 'primary', name: 'Alice Smith' },
            { id: 'work@group.calendar.google.com', name: 'Work' },
        ]);

        const res = await authenticatedRequest(app, { method: 'GET', path: '/calendar/integrations/int-1/calendars', sessionCookie });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([
            { id: 'primary', name: 'Alice Smith' },
            { id: 'work@group.calendar.google.com', name: 'Work' },
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
        expect(items[0]).toMatchObject({ status: 'calendar', title: 'Team lunch', calendarIntegrationId: 'int-1' });
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

    it('trashes an existing item when its GCal event is moved to the past', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

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
            createdTs: futureTime,
            updatedTs: futureTime,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-moved', title: 'Was future', timeStart: pastTime, timeEnd: pastTime, updated: dayjs().toISOString(), status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-moved-past' });
        expect(item?.status).toBe('trash');
    });

    it('does not trash a routine-managed item when its GCal event is moved to the past', async () => {
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
});

// ─── DELETE /calendar/integrations/:id ────────────────────────────────────

describe('DELETE /calendar/integrations/:id', () => {
    it('returns 404 for an unknown integration', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, { method: 'DELETE', path: '/calendar/integrations/bad-id', sessionCookie });
        expect(res.status).toBe(404);
    });

    it('removes the integration with action=keepEvents', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepEvents',
            sessionCookie,
        });
        expect(res.status).toBe(200);
        expect(await calendarIntegrationsDAO.findByOwnerAndIdDecrypted('int-1', userId)).toBeNull();
    });

    it('deletes GCal events but does not trash items with action=deleteEvents', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-del', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-del',
            user: userId,
            status: 'calendar',
            title: 'Standup Mon',
            routineId: 'routine-1',
            createdTs: now,
            updatedTs: now,
        });

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=deleteEvents',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        // GCal event must be deleted.
        expect(deleteSpy).toHaveBeenCalledWith('gcal-evt-del', 'primary');
        // The item must NOT be trashed — only the GCal event is removed.
        const item = await itemsDAO.findOne({ _id: 'item-del' });
        expect(item?.status).toBe('calendar');
        // The integration must be removed.
        expect(await calendarIntegrationsDAO.findByOwnerAndIdDecrypted('int-1', userId)).toBeNull();
    });

    it('trashes linked items and records operations with action=deleteAll', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-r1',
            user: userId,
            status: 'calendar',
            title: 'Standup Mon',
            routineId: 'routine-1',
            createdTs: now,
            updatedTs: now,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=deleteAll',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-r1' });
        expect(item?.status).toBe('trash');

        const ops = await operationsDAO.findArray({ entityId: 'item-r1' });
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ opType: 'update', snapshot: expect.objectContaining({ status: 'trash' }) });
    });

    it('cascade-deletes sync configs when integration is removed', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        expect(await calendarSyncConfigsDAO.findByIntegration('int-1')).toHaveLength(1);

        vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1?action=keepEvents',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        expect(await calendarSyncConfigsDAO.findByIntegration('int-1')).toHaveLength(0);
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

    it('deduplicates rapid-fire notifications for the same channel', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Use a unique channel ID to avoid interference from prior tests' dedup entries.
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-dedup', 'res-dedup', dayjs().add(7, 'day').toISOString());

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const listEventsSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-dd' });

        const makeWebhookRequest = () =>
            app.fetch(
                new Request('http://localhost:4000/calendar/webhooks/google', {
                    method: 'POST',
                    headers: { 'x-goog-channel-id': 'ch-dedup', 'x-goog-resource-id': 'res-dedup', 'x-goog-resource-state': 'exists' },
                }),
            );

        // Send sequentially so the first request records the channel ID in the dedup map
        // before the second request checks it (parallel sends race past the async DB lookup).
        const res1 = await makeWebhookRequest();
        const res2 = await makeWebhookRequest();
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);

        // Give the fire-and-forget sync a moment to complete.
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Only one sync should have run — the second notification was deduped.
        expect(listEventsSpy).toHaveBeenCalledTimes(1);
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
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok' });

        try {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            // Old channel should be stopped and new one created.
            expect(stopSpy).toHaveBeenCalledWith('ch-expired', 'res-expired');
            expect(watchSpy).toHaveBeenCalledOnce();
            const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
            expect(config!.webhookResourceId).toBe('res-renewed');
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

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(deleteSpy).toHaveBeenCalledWith('primary', 'gcal-ev-1');
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
});

describe('calendar push-back — new items', () => {
    it('creates GCal event for app-created calendar item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId);
        await itemsDAO.insertOne(item);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue('new-gcal-id');

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

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue('new-id');

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips routine-managed calendar items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { routineId: 'routine-1' });

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue('new-id');

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
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

        expect(updateSpy).toHaveBeenCalledWith('gcal-recurring-1', routine, 'primary');
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
        // The event's `updated` timestamp is within the 60-second echo window.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-echo-1',
                    title: 'Echoed Event — from GCal',
                    timeStart: existingItem.timeStart!,
                    timeEnd: existingItem.timeEnd!,
                    updated: dayjs().add(5, 'second').toISOString(),
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
