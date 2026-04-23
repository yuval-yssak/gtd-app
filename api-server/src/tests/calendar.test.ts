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
import { gcalCreationInFlight, maybePushToGCal } from '../lib/calendarPushback.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { calendarRoutes, pickSplitParent } from '../routes/calendar.js';
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

    it('updates an existing item when its GCal event is moved to the past', async () => {
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

        const item = await itemsDAO.findOne({ _id: 'item-moved-past' });
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

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue('duplicate-id');

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

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue('new-id');
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
        expect(cancelSpy).toHaveBeenCalledWith('recurring-master-1', '2026-04-27', 'primary');
        expect(updateSpy).not.toHaveBeenCalled();

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('does NOT cancel the GCal instance when a routine-generated item is completed (done)', async () => {
        // Matrix A8: completion is a GTD-local concept — the GCal occurrence must remain so other
        // calendars / attendees still see the event. Cancelling on done would also round-trip a
        // `deleted` exception back via GCal sync and flip the app-side item from `done` to `trash`.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-done-1',
            routineId: 'routine-1',
            status: 'done',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).not.toHaveBeenCalled();
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
            // Item with the same routineId but a non-calendar status must NOT be touched —
            // the cascade is scoped to the calendar projection of this routine.
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
        expect(naSibling?.status).toBe('nextAction');

        // Each cascade-trashed item records an update op so other devices sync the state change.
        const ops = await operationsDAO.findArray({ entityId: { $in: ['gen-1', 'gen-2'] } });
        expect(ops).toHaveLength(2);
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

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue('new-gcal-id');

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

    it('skips update when existing routine is newer than GCal event', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const recentTs = dayjs().toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-3',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Local title',
                updatedTs: recentTs,
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

        vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue('new-gcal-notes-id');

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.calendarEventId).toBe('new-gcal-notes-id');
        // lastSyncedNotes stores HTML (the value sent to GCal), not the raw Markdown.
        expect(updated!.lastSyncedNotes).toBe('<p>New item notes</p>\n');
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
