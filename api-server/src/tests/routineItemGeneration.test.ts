/**
 * Server-side routine item generation: bootstrap, disposal, and resume paths. Covers
 * `ensureFirstRoutineItem` and `advanceRoutineAfterDisposal` end-to-end through their
 * public-API entry points (POST /v1/routines, POST /v1/items/:id/complete, /pause + /resume),
 * plus a unit-level check on `buildRoutineItemSnapshot` field shape.
 *
 * These tests pin the server's parity with the client generator so MCP/API-created routines
 * produce items the client would also produce.
 */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { pauseRoutine } from '../lib/routineComposites.js';
import { buildRoutineItemSnapshot } from '../lib/routineItemGeneration.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ItemsRoutes } from '../routes/v1/items.js';
import { v1RoutinesRoutes } from '../routes/v1/routines.js';
import type { ApiTokenScope, ItemInterface, RoutineInterface } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

// Mount both routers so a single test can create a routine, complete its item, and inspect the
// resulting items in one app instance. Without this, tests had to maintain two app handles.
const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/v1', v1RoutinesRoutes)
    .route('/v1', v1ItemsRoutes);

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

async function tokenWith(userId: string, scopes: ApiTokenScope[]): Promise<string> {
    const { plaintext } = await issueApiToken(userId, 't', scopes);
    return plaintext;
}

async function postJson(path: string, token: string, body: unknown): Promise<Response> {
    return app.fetch(
        new Request(`http://localhost:4000${path}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

async function getItemsForRoutine(userId: string, routineId: string): Promise<ItemInterface[]> {
    return itemsDAO.findArray({ user: userId, routineId } as never);
}

interface CreateRoutineOverrides {
    title?: string;
    rrule?: string;
    routineType?: 'nextAction' | 'calendar';
    startDate?: string;
    active?: boolean;
    template?: RoutineInterface['template'];
    calendarItemTemplate?: RoutineInterface['calendarItemTemplate'];
}

interface CreatedRoutine {
    _id: string;
    title: string;
    routineType: 'nextAction' | 'calendar';
    rrule: string;
    active: boolean;
}

async function createRoutineViaApi(token: string, overrides: CreateRoutineOverrides = {}): Promise<CreatedRoutine> {
    const body = {
        title: overrides.title ?? 'r',
        routineType: overrides.routineType ?? 'nextAction',
        rrule: overrides.rrule ?? 'FREQ=DAILY',
        template: overrides.template ?? {},
        active: overrides.active ?? true,
        ...(overrides.startDate !== undefined ? { startDate: overrides.startDate } : {}),
        ...(overrides.calendarItemTemplate ? { calendarItemTemplate: overrides.calendarItemTemplate } : {}),
    };
    const res = await postJson('/v1/routines', token, body);
    expect(res.status).toBe(201);
    return (await res.json()) as CreatedRoutine;
}

// ── Unit: snapshot shape ────────────────────────────────────────────────────

describe('buildRoutineItemSnapshot', () => {
    it('produces a nextAction item with routineId, tickler ignoreBefore, and template fields', () => {
        const routine: RoutineInterface = {
            _id: 'r-1',
            user: 'u-1',
            title: 'Daily review',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: { workContextIds: ['wc1'], energy: 'low', time: 15, focus: true, notes: 'hello' },
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        };
        const item = buildRoutineItemSnapshot(routine, '2026-05-15', '2026-05-10T00:00:00.000Z');
        expect(item.status).toBe('nextAction');
        expect(item.routineId).toBe('r-1');
        expect(item.title).toBe('Daily review');
        expect(item.user).toBe('u-1');
        expect(item.expectedBy).toBe('2026-05-15');
        // Tickler invariant: ignoreBefore === expectedBy so the item is hidden until due.
        expect(item.ignoreBefore).toBe('2026-05-15');
        expect(item.workContextIds).toEqual(['wc1']);
        expect(item.energy).toBe('low');
        expect(item.time).toBe(15);
        expect(item.focus).toBe(true);
        expect(item.notes).toBe('hello');
        expect(item.createdTs).toBe('2026-05-10T00:00:00.000Z');
        expect(item.updatedTs).toBe('2026-05-10T00:00:00.000Z');
    });

    it('omits template fields that are not set on the routine', () => {
        const routine: RoutineInterface = {
            _id: 'r-2',
            user: 'u-1',
            title: 'Bare',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        };
        const item = buildRoutineItemSnapshot(routine, '2026-05-15', '2026-05-10T00:00:00.000Z');
        expect(item.workContextIds).toBeUndefined();
        expect(item.peopleIds).toBeUndefined();
        expect(item.energy).toBeUndefined();
        expect(item.notes).toBeUndefined();
    });
});

// ── POST /v1/routines: bootstrap on create ───────────────────────────────────

describe('POST /v1/routines — bootstrap first item', () => {
    it('future startDate: creates one item with expectedBy === startDate', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const futureStart = dayjs.utc().add(7, 'day').format('YYYY-MM-DD');
        // BIWEEKLY: startDate is the natural first occurrence with includeAnchor=true.
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=WEEKLY;INTERVAL=2', startDate: futureStart });
        const items = await getItemsForRoutine(userId, routine._id);
        expect(items).toHaveLength(1);
        const first = items[0]!;
        expect(first.status).toBe('nextAction');
        expect(first.routineId).toBe(routine._id);
        expect(first.expectedBy).toBe(futureStart);
        expect(first.ignoreBefore).toBe(futureStart);
    });

    it('past startDate: first item lands on or after today, not in the past', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const pastStart = dayjs.utc().subtract(30, 'day').format('YYYY-MM-DD');
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=DAILY', startDate: pastStart });
        const items = await getItemsForRoutine(userId, routine._id);
        expect(items).toHaveLength(1);
        const first = items[0]!;
        // For FREQ=DAILY with includeAnchor=true and anchor=today (since past start is clamped),
        // the first occurrence is today. `computeFirstAnchor` uses the server's LOCAL calendar
        // date (intentional, per its docstring), so we mirror that here — using `dayjs.utc()`
        // would make this test fail on dev machines where local date diverges from UTC.
        const today = dayjs().format('YYYY-MM-DD');
        expect(first.expectedBy).toBe(today);
        // expectedBy must not be before today.
        expect(first.expectedBy! >= today).toBe(true);
    });

    it('no startDate: anchors at today', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=DAILY' });
        const items = await getItemsForRoutine(userId, routine._id);
        expect(items).toHaveLength(1);
        const today = dayjs().format('YYYY-MM-DD');
        expect(items[0]!.expectedBy).toBe(today);
    });

    it('calendar routine: no item generated', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const routine = await createRoutineViaApi(token, {
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
        });
        const items = await getItemsForRoutine(userId, routine._id);
        // Calendar-routine items are produced client-side (horizon-based); server stays out of it.
        expect(items).toHaveLength(0);
    });

    it('inactive routine: no item generated', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const routine = await createRoutineViaApi(token, { active: false });
        const items = await getItemsForRoutine(userId, routine._id);
        expect(items).toHaveLength(0);
    });

    it('item op is recorded and tagged with the api:<tokenId> deviceId', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const routine = await createRoutineViaApi(token);
        const items = await getItemsForRoutine(userId, routine._id);
        const itemId = items[0]!._id;
        const op = await db.collection<{ opType: string; deviceId: string }>('operations').findOne({ entityId: itemId } as never);
        expect(op?.opType).toBe('create');
        expect(op?.deviceId.startsWith('api:')).toBe(true);
    });
});

// ── POST /v1/items/:id/complete: advancement on disposal ─────────────────────

describe('POST /v1/items/:id/complete — advance routine', () => {
    it('completes the first item and produces a second item with a later expectedBy', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write', 'items.write']);
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=DAILY' });
        const before = await getItemsForRoutine(userId, routine._id);
        expect(before).toHaveLength(1);
        const firstId = before[0]!._id!;

        const res = await postJson(`/v1/items/${firstId}/complete`, token, {});
        expect(res.status).toBe(200);

        const after = await getItemsForRoutine(userId, routine._id);
        // After complete: one `done` item and one new `nextAction` item.
        expect(after).toHaveLength(2);
        const done = after.find((i) => i._id === firstId);
        const next = after.find((i) => i._id !== firstId);
        expect(done?.status).toBe('done');
        expect(next?.status).toBe('nextAction');
        // Next-occurrence expectedBy is strictly after today (FREQ=DAILY + includeAnchor=false).
        const today = dayjs.utc().format('YYYY-MM-DD');
        expect(next!.expectedBy! > today).toBe(true);
    });

    it('PATCH /v1/items/:id with status=done advances the series (parity with /complete)', async () => {
        // The /complete shortcut isn't the only path to disposal — a PATCH that flips status to
        // 'done' must also advance the routine. Without this hook, integrations that prefer the
        // general PATCH surface would silently break the series.
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write', 'items.write']);
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=DAILY' });
        const before = await getItemsForRoutine(userId, routine._id);
        const firstId = before[0]!._id!;

        const res = await app.fetch(
            new Request(`http://localhost:4000/v1/items/${firstId}`, {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'done' }),
            }),
        );
        expect(res.status).toBe(200);

        const after = await getItemsForRoutine(userId, routine._id);
        expect(after).toHaveLength(2);
        const done = after.find((i) => i._id === firstId);
        const tail = after.find((i) => i._id !== firstId);
        expect(done?.status).toBe('done');
        expect(tail?.status).toBe('nextAction');
    });

    it('PATCH that does not change status: no advancement', async () => {
        // A PATCH that only changes title (not status) must NOT create a tail. Without the
        // `existing.status !== 'done'` guard, a re-PATCH on an already-done routine item would
        // double-advance.
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write', 'items.write']);
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=DAILY' });
        const before = await getItemsForRoutine(userId, routine._id);
        const firstId = before[0]!._id!;
        const res = await app.fetch(
            new Request(`http://localhost:4000/v1/items/${firstId}`, {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'renamed' }),
            }),
        );
        expect(res.status).toBe(200);
        const after = await getItemsForRoutine(userId, routine._id);
        expect(after).toHaveLength(1);
        expect(after[0]!.title).toBe('renamed');
    });

    it('non-routine item: completing does not create a tail', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write', 'items.capture', 'items.write']);
        // Capture a plain inbox item (no routineId).
        const capture = await postJson('/v1/items', token, { title: 'plain' });
        const created = (await capture.json()) as ItemInterface;
        const before = await db.collection('items').countDocuments({ user: userId } as never);
        const res = await postJson(`/v1/items/${created._id}/complete`, token, {});
        expect(res.status).toBe(200);
        const after = await db.collection('items').countDocuments({ user: userId } as never);
        expect(after).toBe(before);
    });

    it('series exhausted (UNTIL in the past): completion deactivates the routine and skips creating a tail', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write', 'items.write']);
        // Seed a routine + its first item directly so we don't depend on the future-occurrence
        // bootstrap (which would otherwise see no future date and deactivate at create time).
        const routine: RoutineInterface = {
            _id: 'r-exhaust',
            user: userId,
            title: 'Exhausted',
            routineType: 'nextAction',
            // UNTIL well in the past — rule.after(today) returns null.
            rrule: 'FREQ=DAILY;UNTIL=20200101T000000Z',
            template: {},
            active: true,
            createdTs: '2019-01-01T00:00:00.000Z',
            updatedTs: '2019-01-01T00:00:00.000Z',
        };
        await routinesDAO.insertOne(routine);
        const itemId = 'i-last';
        await itemsDAO.insertOne({
            _id: itemId,
            user: userId,
            status: 'nextAction',
            title: 'last',
            routineId: routine._id,
            expectedBy: '2019-12-31',
            ignoreBefore: '2019-12-31',
            createdTs: '2019-12-31T00:00:00.000Z',
            updatedTs: '2019-12-31T00:00:00.000Z',
        });

        const res = await postJson(`/v1/items/${itemId}/complete`, token, {});
        expect(res.status).toBe(200);
        const items = await getItemsForRoutine(userId, routine._id);
        // Only the original (now `done`) item — no tail was created.
        expect(items).toHaveLength(1);
        expect(items[0]!.status).toBe('done');
        // Routine has been deactivated by the exhaustion handler.
        const stored = await routinesDAO.findByOwnerAndId(routine._id, userId);
        expect(stored?.active).toBe(false);
    });
});

// ── Pause + resume ───────────────────────────────────────────────────────────

describe('Pause + resume composite — item generation', () => {
    it('resume materializes a fresh item with expectedBy >= tomorrow', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=DAILY' });
        // Pause trashes the bootstrap item.
        const pauseRes = await postJson(`/v1/routines/${routine._id}/pause`, token, {});
        expect(pauseRes.status).toBe(200);
        const afterPause = await getItemsForRoutine(userId, routine._id);
        // The single bootstrap item now sits in trash.
        expect(afterPause.filter((i) => i.status === 'nextAction')).toHaveLength(0);

        // Resume should flip active=true, stamp startDate=tomorrow, and generate one fresh item.
        const resumeRes = await postJson(`/v1/routines/${routine._id}/resume`, token, {});
        expect(resumeRes.status).toBe(200);

        const afterResume = await getItemsForRoutine(userId, routine._id);
        const open = afterResume.filter((i) => i.status === 'nextAction');
        expect(open).toHaveLength(1);
        const tomorrow = dayjs.utc().add(1, 'day').format('YYYY-MM-DD');
        expect(open[0]!.expectedBy! >= tomorrow).toBe(true);
        // Tickler invariant preserved on resume-generated items.
        expect(open[0]!.ignoreBefore).toBe(open[0]!.expectedBy);
    });

    it('pausing a GCal-linked routine frees calendarInstanceEventId on its trashed future items', async () => {
        // GAP-1 regression: the app-side pause path (trashFutureOpenItemsForRoutine) must release the
        // instance id, mirroring the GCal-sync deactivate path. Otherwise resume — or a later split
        // successor on the same master — can't regenerate the occurrence (silent E11000 → invisible).
        const userId = await login();
        const master = 'gcal-paused-master';
        const routineId = 'routine-paused-gcal';
        const now = dayjs().toISOString();
        await routinesDAO.insertOne({
            _id: routineId,
            user: userId,
            title: 'Daily standup',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: now,
            updatedTs: now,
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            calendarEventId: master,
        });
        const futureDate = dayjs().add(2, 'day').format('YYYY-MM-DD');
        await itemsDAO.insertOne({
            _id: 'paused-future-item',
            user: userId,
            status: 'calendar',
            title: 'Daily standup',
            timeStart: `${futureDate}T09:00:00`,
            timeEnd: `${futureDate}T09:30:00`,
            routineId,
            calendarEventId: master,
            calendarInstanceEventId: `${master}_${futureDate.replace(/-/g, '')}T060000Z`,
            createdTs: now,
            updatedTs: now,
        });

        const result = await pauseRoutine({ userId, tokenId: 'test-token' }, routineId);
        expect(result.ok).toBe(true);

        const item = await itemsDAO.findByOwnerAndId('paused-future-item', userId);
        expect(item?.status).toBe('trash');
        expect(item?.calendarInstanceEventId).toBeUndefined();
    });

    it('resume is idempotent for an already-active routine with an open item', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=DAILY' });
        const beforeIds = (await getItemsForRoutine(userId, routine._id)).map((i) => i._id);
        // Resume an active routine with an open item — should NOT create a duplicate.
        const res = await postJson(`/v1/routines/${routine._id}/resume`, token, {});
        expect(res.status).toBe(200);
        const after = await getItemsForRoutine(userId, routine._id);
        // Same set of items; no new one inserted.
        expect(after.map((i) => i._id).sort()).toEqual(beforeIds.sort());
    });
});
