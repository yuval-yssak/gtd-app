/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { calendarRoutes } from '../routes/calendar.js';
import type { CalendarIntegrationInterface, RoutineInterface } from '../types/entities.js';
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
    // listEvents is called by importCalendarItems on every sync — mock it by default so
    // tests that focus on other behaviour don't need to set it up themselves.
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEvents').mockResolvedValue([]);
    });

    it('returns 404 for an unknown integration', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/bad-id/sync', sessionCookie });
        expect(res.status).toBe(404);
    });

    it('returns syncedRoutines: 0 when no routines are linked', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        // Mock the GoogleCalendarProvider so no real HTTP calls are made.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, syncedRoutines: 0 });
    });

    it('merges a deleted exception as type:skipped in routineExceptions', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
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
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
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
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const eventTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEvents').mockResolvedValue([
            { id: 'evt-abc', title: 'Team lunch', timeStart: eventTs, timeEnd: eventTs, updated: eventTs, status: 'confirmed' },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const items = await db.collection('items').find({ user: userId, calendarEventId: 'evt-abc' }).toArray();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ status: 'calendar', title: 'Team lunch', calendarIntegrationId: 'int-1' });
    });

    it('trashes an existing item when its GCal event is cancelled', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const now = dayjs().toISOString();
        itemsDAO.insertOne({
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
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEvents').mockResolvedValue([
            { id: 'evt-cancelled', title: 'Old event', timeStart: now, timeEnd: now, updated: now, status: 'cancelled' },
        ]);

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

// ─── upsertCalendarItem (via sync) ─────────────────────────────────────────

describe('POST /calendar/integrations/:id/sync — upsert paths', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEvents').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('updates an existing item when GCal event is newer', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const newTs = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-upd',
            user: userId,
            status: 'calendar',
            title: 'Old title',
            timeStart: oldTs,
            timeEnd: oldTs,
            calendarEventId: 'evt-upd',
            calendarIntegrationId: 'int-1',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEvents').mockResolvedValue([
            { id: 'evt-upd', title: 'New title', timeStart: newTs, timeEnd: newTs, updated: newTs, status: 'confirmed' },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-upd' });
        expect(item?.title).toBe('New title');
    });

    it('skips update when local item is newer than the GCal event', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));

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

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEvents').mockResolvedValue([
            { id: 'evt-stale', title: 'Overwritten title', timeStart: gcalTs, timeEnd: gcalTs, updated: gcalTs, status: 'confirmed' },
        ]);

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
