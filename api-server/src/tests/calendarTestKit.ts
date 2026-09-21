/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
// Shared fixtures, helpers and lifecycle for the calendar.*.test.ts files, which were split out of
// one 16.8k-line calendar.test.ts so the suite can spread its slowest file across workers.
import dayjs from 'dayjs';
import { google } from 'googleapis';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';
import type { GCalEvent } from '../calendarProviders/CalendarProvider.js';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { gcalCreationInFlight } from '../lib/calendarPushback.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { calendarRoutes } from '../routes/calendar.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface, ItemInterface, OperationInterface, RoutineInterface } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

export const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/calendar', calendarRoutes);

// ─── Helpers ──────────────────────────────────────────────────────────────

export async function loginAsAlice(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    return sessionCookie!;
}

export async function getUserId(sessionCookie: string): Promise<string> {
    const res = await app.fetch(
        new Request('http://localhost:4000/auth/get-session', {
            headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
        }),
    );
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
}

export function makeIntegration(userId: string, overrides: Partial<CalendarIntegrationInterface> = {}): CalendarIntegrationInterface {
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

export function makeRoutine(userId: string, overrides: Partial<RoutineInterface> = {}): RoutineInterface {
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

export function makeSyncConfig(userId: string, integrationId: string, overrides: Partial<CalendarSyncConfigInterface> = {}): CalendarSyncConfigInterface {
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
export async function insertIntegrationWithConfig(userId: string, integrationOverrides?: Partial<CalendarIntegrationInterface>) {
    const integration = makeIntegration(userId, integrationOverrides);
    await calendarIntegrationsDAO.insertEncrypted(integration);
    const config = makeSyncConfig(userId, integration._id);
    await calendarSyncConfigsDAO.insertOne(config);
    return { integration, config };
}

/**
 * Mocks the Google userinfo endpoint to return a fixed email — used by callback tests.
 * Patches the prototype of the oauth2.userinfo Resource so any new client instance built by the
 * route under test inherits the mock without coupling to gaxios internals.
 */
export function mockUserInfoEmail(email: string): void {
    // biome-ignore lint/suspicious/noExplicitAny: googleapis Resource$Userinfo type is internal; cast to access prototype.
    const userinfoCtor = Object.getPrototypeOf(google.oauth2('v2').userinfo) as { constructor: any };
    vi.spyOn(userinfoCtor.constructor.prototype, 'get').mockResolvedValue({ data: { email } } as never);
}

// ─── Calendar push-back ────────────────────────────────────────────────────

export function mockBuildProvider(): (integration: CalendarIntegrationInterface, userId: string) => GoogleCalendarProvider {
    // Return a typed mock factory — the actual provider methods are spied on via prototype.
    return (integration, _userId) => new GoogleCalendarProvider(integration);
}

export function makeOp(userId: string, overrides: Partial<OperationInterface>): OperationInterface {
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

export function makeItem(userId: string, overrides: Partial<ItemInterface> = {}): ItemInterface {
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

// ── Cancelled master → orphaned split-successor reap ──────────────────────
//
// A "this and all following" split leaves TWO routines on one bare GCal id: the capped base and the live
// successor. `findExistingRoutineForEvent` resolves that bare id to the BASE (so a capped master can't
// clobber the live successor on the update path), which means a cancellation retires only the base and
// strands the successor active + open-ended, generating phantom items at the old time forever. The reap
// sweep closes that hole — but must not fire when the batch also carries the tail's own live master.

export const CANCELLED_MASTER_TITLE = 'Standup';

/** Seeds a split series on one bare id: capped/inactive base + active successor (optionally `_R`-anchored). */
export async function seedSplitSeries(userId: string, bareId: string, successorOverrides: Partial<RoutineInterface> = {}): Promise<void> {
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
export function cancelledMaster(id: string): GCalEvent {
    return { id, title: '', timeStart: '', timeEnd: '', updated: dayjs().toISOString(), status: 'cancelled' };
}

/** A live master — the tail that keeps a series alive. `rrule` defaults to open-ended. */
export function liveMaster(id: string, rrule = 'FREQ=WEEKLY;BYDAY=MO'): GCalEvent {
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
export async function expectSoleActiveRoutine(userId: string, bareId: string): Promise<RoutineInterface> {
    const active = await routinesDAO.findArray({ user: userId, calendarEventId: bareId, active: true });
    expect(active).toHaveLength(1);
    const [live] = active;
    if (!live) throw new Error('expected exactly one active routine on the series');
    return live;
}

// ─── Phase 2: outbound push for all-day + attendees + sendUpdates ─────────────

// Spy on the googleapis events resource via its shared prototype so all `google.calendar()`
// instances (one is created per provider call) route through the same mock. Returns the
// freshly-installed spies; vi.restoreAllMocks in beforeEach clears them between tests.
export function spyOnGCalEventsApi() {
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

export function getInsertRequestBody(spy: ReturnType<typeof spyOnGCalEventsApi>['insertSpy']) {
    expect(spy).toHaveBeenCalledOnce();
    const [args] = spy.mock.calls;
    if (!args) throw new Error('expected one insert call');
    const [params] = args;
    if (!params || typeof params !== 'object') throw new Error('expected insert params object');
    return params as { requestBody?: Record<string, unknown>; sendUpdates?: string };
}

export function getPatchRequestBody(spy: ReturnType<typeof spyOnGCalEventsApi>['patchSpy']) {
    expect(spy).toHaveBeenCalledOnce();
    const [args] = spy.mock.calls;
    if (!args) throw new Error('expected one patch call');
    const [params] = args;
    if (!params || typeof params !== 'object') throw new Error('expected patch params object');
    return params as { requestBody?: Record<string, unknown>; sendUpdates?: string };
}

/**
 * Registers the lifecycle every calendar.*.test.ts file shares: one DB per file, a wiped slate and a
 * fresh mock set per test. Call it once at module top level, before any describe block.
 */
export function useCalendarTestLifecycle() {
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
}
