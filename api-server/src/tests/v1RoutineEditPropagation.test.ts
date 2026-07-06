/**
 * PATCH /v1/routines/:id — edit propagation to generated items (routineEditPropagation.ts).
 * Covers the nextAction open-item merge/recompute/exhaustion paths and the calendar
 * regen/content-refresh paths, end-to-end through the route.
 */
import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import * as buildCalendarProviderModule from '../lib/buildCalendarProvider.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1RoutinesRoutes } from '../routes/v1/routines.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface, ItemInterface, RoutineInterface } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/v1', v1RoutinesRoutes);

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
        db.collection('routines').deleteMany({}),
        db.collection('items').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('calendarIntegrations').deleteMany({}),
        db.collection('calendarSyncConfigs').deleteMany({}),
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

async function setup(): Promise<{ userId: string; token: string }> {
    const userId = await login();
    const { plaintext } = await issueApiToken(userId, 't', ['routines.write', 'routines.read']);
    return { userId, token: plaintext };
}

async function createRoutineViaApi(token: string, body: Record<string, unknown>): Promise<{ _id: string }> {
    const res = await app.fetch(
        new Request('http://localhost:4000/v1/routines', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as { _id: string };
}

async function patchRoutine(token: string, id: string, body: Record<string, unknown>): Promise<Response> {
    return app.fetch(
        new Request(`http://localhost:4000/v1/routines/${id}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

async function openItemOf(userId: string, routineId: string): Promise<ItemInterface | null> {
    return itemsDAO.findOne({ user: userId, routineId, status: 'nextAction' } as never);
}

const naBody = {
    title: 'Water plants',
    routineType: 'nextAction' as const,
    rrule: 'FREQ=DAILY',
    template: {},
    active: true,
};

describe('PATCH /v1/routines — nextAction open-item propagation', () => {
    it('merges template additions into the clean open item', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, naBody);

        const res = await patchRoutine(token, created._id, { template: { workContextIds: ['wc-1'], energy: 'high' } });
        expect(res.status).toBe(200);

        const open = await openItemOf(userId, created._id);
        expect(open?.workContextIds).toEqual(['wc-1']);
        expect(open?.energy).toBe('high');
    });

    it('preserves a hand-tweaked item field while adopting the rest', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, { ...naBody, template: { energy: 'low' } });
        const open = await openItemOf(userId, created._id);
        if (!open?._id) throw new Error('expected a materialized open item');
        await itemsDAO.replaceById(open._id, { ...open, energy: 'medium' });

        const res = await patchRoutine(token, created._id, { template: { energy: 'high', time: 15 } });
        expect(res.status).toBe(200);

        const after = await openItemOf(userId, created._id);
        expect(after?.energy).toBe('medium');
        expect(after?.time).toBe(15);
    });

    it('adopts a title rename on the open item', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, naBody);

        await patchRoutine(token, created._id, { title: 'Water all plants' });

        const open = await openItemOf(userId, created._id);
        expect(open?.title).toBe('Water all plants');
    });

    it('recomputes expectedBy/ignoreBefore on an rrule change', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, naBody);

        const res = await patchRoutine(token, created._id, { rrule: 'FREQ=WEEKLY;BYDAY=WE' });
        expect(res.status).toBe(200);

        const open = await openItemOf(userId, created._id);
        if (!open?.expectedBy) throw new Error('expected a rescheduled open item');
        // First Wednesday on/after today, tickler in lockstep.
        expect(dayjs(open.expectedBy).day()).toBe(3);
        expect(open.expectedBy >= dayjs().format('YYYY-MM-DD')).toBe(true);
        expect(open.ignoreBefore).toBe(open.expectedBy);
    });

    it('recomputes on a startDate change even when the item date was hand-moved (unified semantics)', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, naBody);
        const open = await openItemOf(userId, created._id);
        if (!open?._id) throw new Error('expected a materialized open item');
        // Hand-move the date so expectedBy !== ignoreBefore — the old restamp guard would skip this.
        await itemsDAO.replaceById(open._id, { ...open, expectedBy: dayjs().add(20, 'day').format('YYYY-MM-DD') });

        const startDate = dayjs().add(5, 'day').format('YYYY-MM-DD');
        const res = await patchRoutine(token, created._id, { startDate });
        expect(res.status).toBe(200);

        const after = await openItemOf(userId, created._id);
        expect(after?.expectedBy).toBe(startDate);
        expect(after?.ignoreBefore).toBe(startDate);
    });

    it('trashes the pending item and deactivates the routine when the new schedule is exhausted', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, naBody);

        const res = await patchRoutine(token, created._id, { rrule: 'FREQ=DAILY;UNTIL=20200101T235959Z' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { active: boolean };
        expect(body.active).toBe(false);

        expect(await openItemOf(userId, created._id)).toBeNull();
        const trashed = await itemsDAO.findArray({ user: userId, routineId: created._id, status: 'trash' } as never);
        expect(trashed).toHaveLength(1);
        const stored = await routinesDAO.findByOwnerAndId(created._id, userId);
        expect(stored?.active).toBe(false);
    });

    it('emits no item ops on a PATCH that changes nothing the item carries', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, naBody);
        const open = await openItemOf(userId, created._id);
        if (!open?._id) throw new Error('expected a materialized open item');
        const opsBefore = await operationsDAO.findArray({ user: userId, entityId: open._id } as never);

        const res = await patchRoutine(token, created._id, { title: 'Water plants' });
        expect(res.status).toBe(200);

        const opsAfter = await operationsDAO.findArray({ user: userId, entityId: open._id } as never);
        expect(opsAfter).toHaveLength(opsBefore.length);
    });

    it('never touches a transformed item', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, naBody);
        const open = await openItemOf(userId, created._id);
        if (!open?._id) throw new Error('expected a materialized open item');
        await itemsDAO.replaceById(open._id, { ...open, status: 'waitingFor' });

        const res = await patchRoutine(token, created._id, { template: { energy: 'high' } });
        expect(res.status).toBe(200);

        const transformed = await itemsDAO.findOne({ _id: open._id } as never);
        expect(transformed?.status).toBe('waitingFor');
        expect(transformed?.energy).toBeUndefined();
    });
});

const calendarBody = {
    title: 'Morning swim',
    routineType: 'calendar' as const,
    rrule: 'FREQ=DAILY',
    template: {},
    active: true,
    calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
};

/** Seed a future calendar item exactly as the client generator would have produced it. */
async function seedCalendarItem(userId: string, routineId: string, dateStr: string): Promise<ItemInterface> {
    const now = dayjs().toISOString();
    const item: ItemInterface = {
        _id: randomUUID(),
        user: userId,
        status: 'calendar',
        title: 'Morning swim',
        routineId,
        timeStart: `${dateStr}T09:00:00`,
        timeEnd: `${dateStr}T10:00:00`,
        createdTs: now,
        updatedTs: now,
    };
    await itemsDAO.insertOne(item);
    return item;
}

describe('PATCH /v1/routines — calendar item propagation', () => {
    it('updates title and notes on future items in place (ids preserved) for a content-only edit', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, calendarBody);
        const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const seeded = await seedCalendarItem(userId, created._id, tomorrow);

        const res = await patchRoutine(token, created._id, { title: 'Evening swim', template: { notes: 'bring goggles' } });
        expect(res.status).toBe(200);

        const after = await itemsDAO.findOne({ _id: seeded._id } as never);
        expect(after?.status).toBe('calendar');
        expect(after?.title).toBe('Evening swim');
        expect(after?.notes).toBe('bring goggles');
        expect(after?.timeStart).toBe(seeded.timeStart);
    });

    it('regenerates future items when the schedule changes (drifted item replaced)', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, calendarBody);
        const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const seeded = await seedCalendarItem(userId, created._id, tomorrow);

        const res = await patchRoutine(token, created._id, { calendarItemTemplate: { timeOfDay: '09:00', duration: 30 } });
        expect(res.status).toBe(200);

        const old = await itemsDAO.findOne({ _id: seeded._id } as never);
        expect(old?.status).toBe('trash');
        const replacement = await itemsDAO.findOne({
            user: userId,
            routineId: created._id,
            status: 'calendar',
            timeStart: `${tomorrow}T09:00:00`,
        } as never);
        expect(replacement?.timeEnd).toBe(`${tomorrow}T09:30:00`);
    });

    it('leaves past items alone on a content edit', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, calendarBody);
        const lastWeek = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
        const seeded = await seedCalendarItem(userId, created._id, lastWeek);

        await patchRoutine(token, created._id, { title: 'Evening swim' });

        const after = await itemsDAO.findOne({ _id: seeded._id } as never);
        expect(after?.title).toBe('Morning swim');
    });
});

describe('PATCH /v1/routines — GCal-linked calendar routine (pushback suppression)', () => {
    /** Seed a fully-resolvable GCal link (integration + default sync config) so pushback's
     *  `resolvePushContext` succeeds and the stubbed provider is actually reachable — without
     *  these rows the per-instance branches bail on `!ctx` and the non-call assertions below
     *  would pass vacuously. */
    async function seedGCalLink(userId: string): Promise<void> {
        const now = dayjs().toISOString();
        const integration: CalendarIntegrationInterface = {
            _id: 'integ-1',
            user: userId,
            provider: 'google',
            accessToken: 'at',
            refreshToken: 'rt',
            tokenExpiry: now,
            createdTs: now,
            updatedTs: now,
        };
        // insertEncrypted (test-only) — the pushback path reads via findByOwnerAndIdDecrypted,
        // which throws on plaintext tokens; a raw insertOne would silently kill the whole push.
        await calendarIntegrationsDAO.insertEncrypted(integration);
        const config: CalendarSyncConfigInterface = {
            _id: 'cfg-1',
            integrationId: 'integ-1',
            user: userId,
            calendarId: 'primary',
            isDefault: true,
            enabled: true,
            timeZone: 'UTC',
            createdTs: now,
            updatedTs: now,
        };
        await calendarSyncConfigsDAO.insertOne(config);
    }

    it('never layers per-instance overrides/cancellations on top of the master push during regen', async () => {
        const { userId, token } = await setup();
        await seedGCalLink(userId);
        const updateRecurringEvent = vi.fn().mockResolvedValue(undefined);
        const updateRecurringInstance = vi.fn().mockResolvedValue(undefined);
        const cancelRecurringInstance = vi.fn().mockResolvedValue(undefined);
        const stubProvider = {
            updateRecurringEvent,
            updateRecurringInstance,
            cancelRecurringInstance,
            updateEvent: vi.fn().mockResolvedValue(undefined),
            getCalendarTimeZone: vi.fn().mockResolvedValue('UTC'),
        };
        vi.spyOn(buildCalendarProviderModule, 'buildCalendarProvider').mockImplementation(() => stubProvider as never);

        const created = await createRoutineViaApi(token, calendarBody);
        const stored = await routinesDAO.findByOwnerAndId(created._id, userId);
        if (!stored) throw new Error('expected the routine');
        await routinesDAO.replaceById(created._id, {
            ...stored,
            calendarEventId: 'gcal-master-1',
            calendarIntegrationId: 'integ-1',
            calendarSyncConfigId: 'cfg-1',
        } as RoutineInterface);
        const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
        await seedCalendarItem(userId, created._id, tomorrow);

        const res = await patchRoutine(token, created._id, { calendarItemTemplate: { timeOfDay: '09:00', duration: 30 } });
        expect(res.status).toBe(200);

        // The MASTER push (routine op → handleRoutinePush → pushExistingRoutineToGCal) proves the
        // fire-and-forget pushback pipeline ran end-to-end with a resolvable context — the
        // positive anchor that keeps the negative assertions below from passing vacuously.
        await vi.waitFor(() => expect(updateRecurringEvent).toHaveBeenCalled());
        // The per-item regen pushes (the thing suppression must prevent) are separate
        // fire-and-forget promises started before this point; give them a bounded window to
        // land so the not-called assertions are meaningful rather than a race win.
        await new Promise((resolve) => setTimeout(resolve, 200));

        const replacement = await itemsDAO.findOne({ user: userId, routineId: created._id, status: 'calendar', timeStart: `${tomorrow}T09:00:00` } as never);
        expect(replacement?.timeEnd).toBe(`${tomorrow}T09:30:00`);
        // The regen ops (trash + creates) must NOT reach the per-instance pushback branches —
        // suppressGCalPushback in propagateCalendarRoutineEdit is what keeps them out.
        expect(updateRecurringInstance).not.toHaveBeenCalled();
        expect(cancelRecurringInstance).not.toHaveBeenCalled();
    });
});

describe('PATCH /v1/routines — calendar exhausted schedule', () => {
    it('trashes future items without deactivating the routine (calendar exhaustion ≠ nextAction exhaustion)', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, calendarBody);
        const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const seeded = await seedCalendarItem(userId, created._id, tomorrow);

        const res = await patchRoutine(token, created._id, { rrule: 'FREQ=DAILY;UNTIL=20200101T235959Z' });
        expect(res.status).toBe(200);

        const old = await itemsDAO.findOne({ _id: seeded._id } as never);
        expect(old?.status).toBe('trash');
        const live = await itemsDAO.findArray({ user: userId, routineId: created._id, status: 'calendar' } as never);
        expect(live).toHaveLength(0);
        const stored = await routinesDAO.findByOwnerAndId(created._id, userId);
        expect(stored?.active).toBe(true);
    });
});

describe('PATCH /v1/routines — paused routines', () => {
    it('does not touch items of an inactive routine', async () => {
        const { userId, token } = await setup();
        const created = await createRoutineViaApi(token, naBody);
        const open = await openItemOf(userId, created._id);
        if (!open?._id) throw new Error('expected a materialized open item');
        const stored = await routinesDAO.findByOwnerAndId(created._id, userId);
        if (!stored) throw new Error('expected the routine');
        await routinesDAO.replaceById(created._id, { ...stored, active: false } as RoutineInterface);

        const res = await patchRoutine(token, created._id, { template: { energy: 'high' }, active: false });
        expect(res.status).toBe(200);

        const after = await itemsDAO.findOne({ _id: open._id } as never);
        expect(after?.energy).toBeUndefined();
    });
});
