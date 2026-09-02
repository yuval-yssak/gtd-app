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
import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { pauseRoutine, resumeRoutine } from '../lib/routineComposites.js';
import { propagateRoutineEditToItems } from '../lib/routineEditPropagation.js';
import { advanceRoutineAfterDisposal, buildRoutineItemSnapshot, ensureFirstRoutineItem } from '../lib/routineItemGeneration.js';
import { propagateRoutineContentToItems, regenerateFutureRoutineItems } from '../lib/routineItemRegeneration.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ItemsRoutes } from '../routes/v1/items.js';
import { v1OperationsRoutes } from '../routes/v1/operations.js';
import { v1RoutinesRoutes } from '../routes/v1/routines.js';
import type { ApiTokenScope, ItemInterface, RoutineInterface } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

// Mount routines, items, and operations routers so a single test can create a routine, dispose of
// its item (via /complete, /trash, or an operations/batch replay), and inspect the resulting items
// in one app instance. Without this, tests had to maintain separate app handles.
const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/v1', v1RoutinesRoutes)
    .route('/v1', v1ItemsRoutes)
    .route('/v1', v1OperationsRoutes);

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
        db.collection('deviceSyncState').deleteMany({}),
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

async function patchJson(path: string, token: string, body: unknown): Promise<Response> {
    return app.fetch(
        new Request(`http://localhost:4000${path}`, {
            method: 'PATCH',
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
        // the first occurrence is today. With no device timezone report seeded, the user's local
        // day resolves to the UTC fallback (see resolveUserTimezone) — so assert against UTC.
        const today = dayjs.utc().format('YYYY-MM-DD');
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
        // No timezone report seeded → the anchor falls back to the UTC calendar day.
        const today = dayjs.utc().format('YYYY-MM-DD');
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

// ── PATCH /v1/routines/:id: re-stamp first item on startDate change ──────────

describe('PATCH /v1/routines/:id — re-stamp first item on startDate change', () => {
    it('moving startDate forward re-stamps the open first item expectedBy + ignoreBefore', async () => {
        // The original bug: create-without-startDate stamps the first item at today, then a later
        // startDate PATCH leaves it stranded. The re-stamp pushes it to the new first occurrence.
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=MONTHLY' });
        const today = dayjs.utc().format('YYYY-MM-DD');
        const before = await getItemsForRoutine(userId, routine._id);
        expect(before[0]!.expectedBy).toBe(today);

        const futureStart = dayjs.utc().add(20, 'day').format('YYYY-MM-DD');
        const res = await patchJson(`/v1/routines/${routine._id}`, token, { startDate: futureStart });
        expect(res.status).toBe(200);

        const after = await getItemsForRoutine(userId, routine._id);
        // Still exactly one open item — re-stamped, not duplicated.
        expect(after.filter((i) => i.status === 'nextAction')).toHaveLength(1);
        expect(after[0]!._id).toBe(before[0]!._id);
        expect(after[0]!.expectedBy).toBe(futureStart);
        expect(after[0]!.ignoreBefore).toBe(futureStart);
    });

    it('PATCH that does not change startDate leaves the first item untouched', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=MONTHLY' });
        const before = await getItemsForRoutine(userId, routine._id);
        const originalExpectedBy = before[0]!.expectedBy;

        const res = await patchJson(`/v1/routines/${routine._id}`, token, { title: 'renamed' });
        expect(res.status).toBe(200);

        const after = await getItemsForRoutine(userId, routine._id);
        expect(after[0]!.expectedBy).toBe(originalExpectedBy);
    });

    it('re-stamps even a user-edited item — schedule edits win over manual date tweaks', async () => {
        // Agreed semantics (routineEditPropagation.ts): a schedule-shaped edit (startDate/rrule)
        // recomputes the open item's dates unconditionally. The old only-if-untouched guard
        // (expectedBy === ignoreBefore) is gone.
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=MONTHLY' });
        const before = await getItemsForRoutine(userId, routine._id);
        const itemId = before[0]!._id!;
        // Simulate a user editing the tickler so expectedBy !== ignoreBefore.
        await itemsDAO.replaceById(itemId, { ...before[0]!, ignoreBefore: '2020-01-01' });

        const futureStart = dayjs.utc().add(20, 'day').format('YYYY-MM-DD');
        const res = await patchJson(`/v1/routines/${routine._id}`, token, { startDate: futureStart });
        expect(res.status).toBe(200);

        const after = await itemsDAO.findByOwnerAndId(itemId, userId);
        expect(after?.expectedBy).toBe(futureStart);
        expect(after?.ignoreBefore).toBe(futureStart);
    });

    it('rejects clearing startDate via null and leaves the open item untouched', async () => {
        // The routine schema models startDate as `isoDate.optional()` — it accepts a date or its
        // absence, but `null` is not a valid value, so the public API has no way to UNSET startDate.
        // A failed validation must reject the whole PATCH (no routine write, no re-stamp).
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const futureStart = dayjs.utc().add(20, 'day').format('YYYY-MM-DD');
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=MONTHLY', startDate: futureStart });

        const res = await patchJson(`/v1/routines/${routine._id}`, token, { startDate: null });
        expect(res.status).toBe(400);

        const after = await getItemsForRoutine(userId, routine._id);
        expect(after[0]!.expectedBy).toBe(futureStart);
        expect(after[0]!.ignoreBefore).toBe(futureStart);
    });

    it('startDate moved past UNTIL: exhausted schedule trashes the pending item and deactivates', async () => {
        // If the new startDate pushes the first occurrence past the rule's UNTIL, the rule is
        // exhausted. Agreed semantics: the pending item is trashed (explicitly, so the client can
        // surface it) and the routine deactivates — the PATCH itself never throws.
        // Seed routine + item directly: UNTIL is in the past relative to "today", so going through
        // createRoutineViaApi would exhaust at create time and never materialize a first item.
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const routineId = 'r-restamp-exhaust';
        const seededExpectedBy = '2019-06-15';
        await routinesDAO.insertOne({
            _id: routineId,
            user: userId,
            title: 'Exhaust on restamp',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY;UNTIL=20191231T000000Z',
            template: {},
            active: true,
            startDate: '2019-06-15',
            createdTs: '2019-06-01T00:00:00.000Z',
            updatedTs: '2019-06-01T00:00:00.000Z',
        });
        await itemsDAO.insertOne({
            _id: 'i-restamp-exhaust',
            user: userId,
            status: 'nextAction',
            title: 'Exhaust on restamp',
            routineId,
            expectedBy: seededExpectedBy,
            ignoreBefore: seededExpectedBy,
            createdTs: '2019-06-15T00:00:00.000Z',
            updatedTs: '2019-06-15T00:00:00.000Z',
        });

        // startDate after UNTIL → computeFirstOccurrenceDate throws RruleExhaustedError inside the recompute.
        const res = await patchJson(`/v1/routines/${routineId}`, token, { startDate: '2020-01-01' });
        expect(res.status).toBe(200);

        // Pending item trashed (date preserved on the trashed row) and the routine deactivated.
        const after = await getItemsForRoutine(userId, routineId);
        expect(after.filter((i) => i.status === 'nextAction')).toHaveLength(0);
        expect(after.filter((i) => i.status === 'trash')).toHaveLength(1);
        expect(after[0]!.expectedBy).toBe(seededExpectedBy);
        const stored = await routinesDAO.findByOwnerAndId(routineId, userId);
        expect(stored?.active).toBe(false);
    });

    it('re-stamp publishes an item update op tagged api:<tokenId>', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write']);
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=MONTHLY' });
        const itemId = (await getItemsForRoutine(userId, routine._id))[0]!._id!;

        const futureStart = dayjs.utc().add(20, 'day').format('YYYY-MM-DD');
        await patchJson(`/v1/routines/${routine._id}`, token, { startDate: futureStart });

        const ops = await db
            .collection<{ opType: string; deviceId: string }>('operations')
            .find({ entityId: itemId } as never)
            .toArray();
        const updateOp = ops.find((o) => o.opType === 'update');
        expect(updateOp).toBeDefined();
        expect(updateOp?.deviceId.startsWith('api:')).toBe(true);
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

// ── POST /v1/items/:id/trash: advancement on disposal ────────────────────────

describe('POST /v1/items/:id/trash — advance routine', () => {
    it('trashes the first item and produces a second nextAction item (parity with /complete)', async () => {
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write', 'items.write']);
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=DAILY' });
        const before = await getItemsForRoutine(userId, routine._id);
        expect(before).toHaveLength(1);
        const firstId = before[0]!._id!;

        const res = await postJson(`/v1/items/${firstId}/trash`, token, {});
        expect(res.status).toBe(200);

        const after = await getItemsForRoutine(userId, routine._id);
        // After trash: one `trash` item and one new `nextAction` item — the series advances even
        // when the disposal is a trash (mirrors the client's clarifyToTrash → maybeCreateNextRoutineItem).
        expect(after).toHaveLength(2);
        const trashed = after.find((i) => i._id === firstId);
        const next = after.find((i) => i._id !== firstId);
        expect(trashed?.status).toBe('trash');
        expect(next?.status).toBe('nextAction');
    });

    it('replaying a client-originated trash op via /operations/batch does NOT advance (no double-create)', async () => {
        // Invariant pinned by the comments in items.ts: a `trash` snapshot arriving through
        // /operations/batch is a REPLAY of a client trash — the client already ran its own
        // maybeCreateNextRoutineItem locally, so the server must NOT advance again. The /trash
        // endpoint is the only server-side path that advances on trash.
        const userId = await login();
        const token = await tokenWith(userId, ['routines.write', 'items.write']);
        const routine = await createRoutineViaApi(token, { rrule: 'FREQ=DAILY' });
        const before = await getItemsForRoutine(userId, routine._id);
        expect(before).toHaveLength(1);
        const first = before[0]!;

        const trashSnapshot = { ...first, status: 'trash', updatedTs: dayjs().toISOString() };
        const res = await postJson('/v1/operations/batch', token, {
            ops: [{ entityType: 'item', opType: 'update', entityId: first._id, snapshot: trashSnapshot }],
        });
        expect(res.status).toBe(200);

        const after = await getItemsForRoutine(userId, routine._id);
        // Still exactly one item (now trashed) — the batch replay must not have generated a tail.
        expect(after).toHaveLength(1);
        expect(after[0]!.status).toBe('trash');
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

// `regenerateFutureRoutineItems` reconciles by occurrence date rather than trashing-and-recreating
// the whole future set. The load-bearing property is idempotency: a re-run with an UNCHANGED schedule
// must be a no-op (no ops, no churn). The prior trash-all-then-recreate implementation rewrote every
// item each call, which — under a routine whose rrule oscillated every GCal sync — produced the
// duplicate-rows + web-push storm this fix addresses.
describe('regenerateFutureRoutineItems — idempotency & delta reconciliation', () => {
    const TZ = 'Asia/Jerusalem';

    async function seedDailyCalendarRoutine(userId: string, overrides: Partial<RoutineInterface> = {}): Promise<RoutineInterface> {
        const now = dayjs().toISOString();
        const routine: RoutineInterface = {
            _id: 'regen-idem-routine',
            user: userId,
            title: 'Daily standup',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: now,
            updatedTs: now,
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            calendarEventId: 'regen-idem-master',
            ...overrides,
        };
        await routinesDAO.insertOne(routine);
        return routine;
    }

    it('a second run with an unchanged schedule emits zero ops and keeps every item id', async () => {
        const userId = await login();
        const routine = await seedDailyCalendarRoutine(userId);

        const firstOps = await regenerateFutureRoutineItems(routine, userId, dayjs().toISOString(), TZ);
        expect(firstOps.length).toBeGreaterThan(0);
        const seededIds = (await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' })).map((i) => i._id).sort();

        const secondOps = await regenerateFutureRoutineItems(routine, userId, dayjs().toISOString(), TZ);
        // No-op: nothing trashed, nothing created.
        expect(secondOps).toHaveLength(0);
        const liveIds = (await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' })).map((i) => i._id).sort();
        expect(liveIds).toEqual(seededIds);
        const trashed = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'trash' });
        expect(trashed).toHaveLength(0);
    });

    it('a time-of-day change reconciles items (drifted rows trashed, fresh rows created)', async () => {
        const userId = await login();
        const routine = await seedDailyCalendarRoutine(userId);
        await regenerateFutureRoutineItems(routine, userId, dayjs().toISOString(), TZ);
        const before = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' });
        expect(before.length).toBeGreaterThan(0);
        expect(before.every((i) => (i.timeStart ?? '').endsWith('T09:00:00'))).toBe(true);

        // Shift the master time → every existing item drifts and must be replaced at the new time.
        const moved: RoutineInterface = { ...routine, calendarItemTemplate: { timeOfDay: '14:30', duration: 30 } };
        await regenerateFutureRoutineItems(moved, userId, dayjs().toISOString(), TZ);

        const live = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' });
        expect(live.length).toBe(before.length);
        expect(live.every((i) => (i.timeStart ?? '').endsWith('T14:30:00'))).toBe(true);
        // The old 09:00 rows were trashed, not left as duplicates alongside the new 14:30 rows.
        const trashed = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'trash' });
        expect(trashed.length).toBe(before.length);
    });

    it('a paused routine trashes future items and creates none', async () => {
        const userId = await login();
        const routine = await seedDailyCalendarRoutine(userId);
        await regenerateFutureRoutineItems(routine, userId, dayjs().toISOString(), TZ);
        expect((await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' })).length).toBeGreaterThan(0);

        const paused: RoutineInterface = { ...routine, active: false };
        await regenerateFutureRoutineItems(paused, userId, dayjs().toISOString(), TZ);

        expect(await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' })).toHaveLength(0);
        expect((await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'trash' })).length).toBeGreaterThan(0);
    });

    // Invariant: a `done` item keeps its date claim even when a drifted live row is co-located on the
    // same date — the end state is exactly one `done` row and zero recreated `calendar` rows there. Two
    // layers enforce this: (1) the veto query (`dateSetClaimedByDisposedItems`) excludes the date from
    // `required` so the live row is trashed-not-recreated, and (2) the `(user, calendarInstanceEventId)`
    // unique index backstops recreation since the done row keeps its instance id. This pins the invariant
    // regardless of which layer fires.
    it('a done item on a required date is never duplicated, even alongside a co-located live item', async () => {
        const userId = await login();
        const routine = await seedDailyCalendarRoutine(userId);
        await regenerateFutureRoutineItems(routine, userId, dayjs().toISOString(), TZ);
        const live = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' });
        const [first] = live;
        if (!first?._id) throw new Error('expected at least one generated item');
        const claimedDate = (first.timeStart ?? '').slice(0, 10);
        // Mark this occurrence done — it now holds the date claim (kept forever).
        await itemsDAO.replaceById(first._id, { ...first, status: 'done', updatedTs: dayjs().toISOString() });
        // Co-locate a SEPARATE live calendar row on the same date, drifted off the 09:00 schedule. This is
        // the row whose date the old code wrongly un-vetoed, then recreated beside the done one.
        await itemsDAO.insertOne({
            ...first,
            _id: randomUUID(),
            status: 'calendar',
            timeStart: `${claimedDate}T07:00:00`,
            timeEnd: `${claimedDate}T07:30:00`,
            calendarInstanceEventId: undefined,
            updatedTs: dayjs().toISOString(),
        });

        await regenerateFutureRoutineItems(routine, userId, dayjs().toISOString(), TZ);

        // The co-located live row is trashed and nothing is recreated on the done date; the done item
        // stands alone there.
        const onDate = await itemsDAO.findArray({
            user: userId,
            routineId: routine._id,
            timeStart: { $gte: `${claimedDate}T00:00:00`, $lt: `${claimedDate}T23:59:59` },
        });
        expect(onDate.filter((i) => i.status === 'calendar')).toHaveLength(0);
        expect(onDate.filter((i) => i.status === 'done')).toHaveLength(1);
    });

    // A drifted-AND-required date must yield exactly ONE fresh live row — the stale one trashed, a single
    // replacement created — never a duplicate and never a gap.
    it('a drifted required date yields exactly one fresh live row', async () => {
        const userId = await login();
        const routine = await seedDailyCalendarRoutine(userId);
        await regenerateFutureRoutineItems(routine, userId, dayjs().toISOString(), TZ);
        const moved: RoutineInterface = { ...routine, calendarItemTemplate: { timeOfDay: '14:30', duration: 30 } };
        await regenerateFutureRoutineItems(moved, userId, dayjs().toISOString(), TZ);

        const live = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' });
        const datesWithMultipleLive = [...Map.groupBy(live, (i) => (i.timeStart ?? '').slice(0, 10))].filter(([, items]) => items.length > 1);
        expect(datesWithMultipleLive).toHaveLength(0);
        expect(live.every((i) => (i.timeStart ?? '').endsWith('T14:30:00'))).toBe(true);
    });

    // All-day routines exercise the date-only instance-id path, where freeing calendarInstanceEventId on
    // trash is strictly required (the date-only id collides on the partial-on-presence unique index).
    it('an all-day routine is idempotent and frees the instance id on drift', async () => {
        const userId = await login();
        const routine = await seedDailyCalendarRoutine(userId, { calendarItemTemplate: { allDay: true } });
        const firstOps = await regenerateFutureRoutineItems(routine, userId, dayjs().toISOString(), TZ);
        expect(firstOps.length).toBeGreaterThan(0);
        const seeded = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' });
        expect(seeded.every((i) => i.allDay === true && typeof i.calendarInstanceEventId === 'string')).toBe(true);

        // Re-run unchanged → no-op.
        const secondOps = await regenerateFutureRoutineItems(routine, userId, dayjs().toISOString(), TZ);
        expect(secondOps).toHaveLength(0);

        // Shift the rrule weekday so every date drifts → old all-day rows trashed with their instance id freed.
        const moved: RoutineInterface = { ...routine, rrule: 'FREQ=WEEKLY;BYDAY=MO' };
        await regenerateFutureRoutineItems(moved, userId, dayjs().toISOString(), TZ);
        const trashed = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'trash' });
        expect(trashed.length).toBeGreaterThan(0);
        expect(trashed.every((i) => i.calendarInstanceEventId === undefined)).toBe(true);
    });
});

// ── Exception-moved rows ─────────────────────────────────────────────────────
// Staging incident ("ALL HANDS"): GCal moved the week-1 occurrence onto the week-2 date AND cancelled
// the regular week-2 occurrence. Regeneration keyed live rows by the date they SIT on, so the moved
// row read as an orphan of the (skipped) week-2 date: trashed, instance id freed, and the next
// exception sync orphan-created it again. Rows a `modified` exception pins are keyed by the
// occurrence they stand for and left alone by the reconcile.

describe('regenerateFutureRoutineItems — exception-moved rows', () => {
    const TZ = 'Asia/Jerusalem';

    async function seedDailyLinkedRoutine(userId: string): Promise<RoutineInterface> {
        const now = dayjs().toISOString();
        const routine: RoutineInterface = {
            _id: 'regen-moved-routine',
            user: userId,
            title: 'ALL HANDS',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: now,
            updatedTs: now,
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            calendarEventId: 'regen-moved-master',
        };
        await routinesDAO.insertOne(routine);
        return routine;
    }

    /** Generates the horizon, then mirrors what exception sync does for "week-1 moved onto cancelled week-2". */
    async function seedMovedOntoCancelled(userId: string, routine: RoutineInterface) {
        await regenerateFutureRoutineItems(routine, userId, dayjs().toISOString(), TZ);
        const movedFrom = dayjs().add(2, 'day').format('YYYY-MM-DD');
        const cancelled = dayjs().add(9, 'day').format('YYYY-MM-DD');
        const movedTimeStart = `${cancelled}T15:00:00+03:00`;
        const rows = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' });
        const movedRow = rows.find((row) => row.timeStart?.startsWith(movedFrom));
        const cancelledRow = rows.find((row) => row.timeStart?.startsWith(cancelled));
        if (!movedRow || !cancelledRow) throw new Error('expected generated rows on both dates');
        // The moved row keeps its instance id and takes the exception's time; the cancelled row is trashed with its id freed.
        await db.collection('items').updateOne({ _id: movedRow._id }, { $set: { timeStart: movedTimeStart, timeEnd: `${cancelled}T15:30:00+03:00` } });
        await db.collection('items').updateOne({ _id: cancelledRow._id }, { $set: { status: 'trash' }, $unset: { calendarInstanceEventId: '' } });
        const withExceptions: RoutineInterface = {
            ...routine,
            routineExceptions: [
                { date: movedFrom, type: 'modified', newTimeStart: movedTimeStart, newTimeEnd: `${cancelled}T15:30:00+03:00` },
                { date: cancelled, type: 'skipped' },
            ],
        };
        return { withExceptions, movedFrom, cancelled, movedTimeStart, movedRow };
    }

    it('keeps a row moved onto a cancelled date across an unchanged re-run AND a master time change', async () => {
        const userId = await login();
        const routine = await seedDailyLinkedRoutine(userId);
        const { withExceptions, movedFrom, cancelled, movedTimeStart, movedRow } = await seedMovedOntoCancelled(userId, routine);

        // Unchanged schedule: the moved row is NOT an orphan of the skipped date it sits on.
        expect(await regenerateFutureRoutineItems(withExceptions, userId, dayjs().toISOString(), TZ)).toHaveLength(0);

        // Master time change: every other row reconciles, the pinned row is untouched.
        const rescheduled: RoutineInterface = { ...withExceptions, calendarItemTemplate: { timeOfDay: '10:00', duration: 30 } };
        await regenerateFutureRoutineItems(rescheduled, userId, dayjs().toISOString(), TZ);
        const live = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' });
        const survivor = live.find((row) => row._id === movedRow._id);
        expect(survivor?.timeStart).toBe(movedTimeStart);
        expect(survivor?.calendarInstanceEventId).toBe(movedRow.calendarInstanceEventId);
        // Only the moved row lands on the cancelled date; the origin date is not regenerated.
        expect(live.filter((row) => row.timeStart?.startsWith(cancelled)).map((row) => row._id)).toEqual([movedRow._id]);
        expect(live.filter((row) => row.timeStart?.startsWith(movedFrom))).toHaveLength(0);
        expect(live.filter((row) => row._id !== movedRow._id).every((row) => row.timeStart?.endsWith('T10:00:00'))).toBe(true);

        // And the new schedule is idempotent again.
        expect(await regenerateFutureRoutineItems(rescheduled, userId, dayjs().toISOString(), TZ)).toHaveLength(0);
    });

    it('a paused routine still trashes the moved row (pause means no future occurrences at all)', async () => {
        const userId = await login();
        const routine = await seedDailyLinkedRoutine(userId);
        const { withExceptions, movedRow } = await seedMovedOntoCancelled(userId, routine);

        await regenerateFutureRoutineItems({ ...withExceptions, active: false }, userId, dayjs().toISOString(), TZ);
        expect(await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' })).toHaveLength(0);
        const trashedMoved = await itemsDAO.findOne({ _id: movedRow._id });
        expect(trashedMoved?.status).toBe('trash');
    });

    it('content propagation keeps the moved row’s per-instance title override (keyed by its origin date)', async () => {
        const userId = await login();
        const routine = await seedDailyLinkedRoutine(userId);
        const { withExceptions, movedFrom, movedRow } = await seedMovedOntoCancelled(userId, routine);
        const overriddenTitle = 'ALL HANDS (moved — extended agenda)';
        await db.collection('items').updateOne({ _id: movedRow._id }, { $set: { title: overriddenTitle } });
        const exceptions = (withExceptions.routineExceptions ?? []).map((e) => (e.date === movedFrom ? { ...e, title: overriddenTitle } : e));

        await propagateRoutineContentToItems({ ...withExceptions, routineExceptions: exceptions, title: 'ALL HANDS (renamed)' }, userId, dayjs().toISOString());

        const live = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' });
        expect(live.find((row) => row._id === movedRow._id)?.title).toBe(overriddenTitle);
        expect(live.filter((row) => row._id !== movedRow._id).every((row) => row.title === 'ALL HANDS (renamed)')).toBe(true);
    });
});

// ── Timezone-aware stamping ──────────────────────────────────────────────────
// The tickler boundary is the USER's local midnight: expectedBy/ignoreBefore must land on the
// user's calendar day (per the device-reported timezone), not the server's UTC day.
//
// The clock is PINNED to 10:30Z — the one hour of the day when BOTH fixture zones disagree with
// UTC: Kiritimati (UTC+14) already reads tomorrow and Pago Pago (UTC-11) still reads yesterday.
// Pinning + literal-date assertions keep every test discriminating: an expectation derived from
// the same live clock the code reads would pass with the timezone resolution broken whenever the
// fixture zone happened to agree with UTC (which Kiritimati does 11 hours a day).

describe('timezone-aware generation', () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-08-30T10:30:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const genCtx = (userId: string) => ({ userId, deviceId: 'server' });

    async function reportTimezone(userId: string, deviceId: string, timezone: string, reportedTs: string) {
        await deviceSyncStateDAO.upsert({
            _id: `${deviceId}::${userId}`,
            deviceId,
            user: userId,
            lastSyncedTs: dayjs(0).toISOString(),
            lastSyncedId: '',
            lastSeenTs: dayjs().toISOString(),
            timezone,
            timezoneReportedTs: reportedTs,
        });
    }

    async function seedDailyRoutine(userId: string, _id: string, overrides: Partial<RoutineInterface> = {}): Promise<RoutineInterface> {
        const now = dayjs().toISOString();
        const routine: RoutineInterface = {
            _id,
            user: userId,
            title: 'tz routine',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: now,
            updatedTs: now,
            ...overrides,
        };
        await routinesDAO.insertOne(routine);
        return routine;
    }

    it('bootstrap stamps expectedBy on the user-local day — UTC+14 already reads tomorrow', async () => {
        await reportTimezone('u-tz-ahead', 'dev', 'Pacific/Kiritimati', dayjs().toISOString());
        const routine = await seedDailyRoutine('u-tz-ahead', 'r-tz-ahead');

        await ensureFirstRoutineItem(genCtx('u-tz-ahead'), routine);

        const items = await getItemsForRoutine('u-tz-ahead', 'r-tz-ahead');
        expect(items).toHaveLength(1);
        expect(items[0]!.expectedBy).toBe('2026-08-31'); // Kiritimati local date at 10:30Z
        expect(items[0]!.ignoreBefore).toBe('2026-08-31');
    });

    it('bootstrap stamps expectedBy on the user-local day — UTC-11 still reads yesterday', async () => {
        await reportTimezone('u-tz-behind', 'dev', 'Pacific/Pago_Pago', dayjs().toISOString());
        const routine = await seedDailyRoutine('u-tz-behind', 'r-tz-behind');

        await ensureFirstRoutineItem(genCtx('u-tz-behind'), routine);

        const items = await getItemsForRoutine('u-tz-behind', 'r-tz-behind');
        expect(items[0]!.expectedBy).toBe('2026-08-29'); // Pago Pago local date at 10:30Z
    });

    it('the most recently reporting device decides the timezone', async () => {
        await reportTimezone('u-tz-two', 'dev-old', 'Pacific/Pago_Pago', dayjs().subtract(1, 'day').toISOString());
        await reportTimezone('u-tz-two', 'dev-new', 'Pacific/Kiritimati', dayjs().toISOString());
        const routine = await seedDailyRoutine('u-tz-two', 'r-tz-two');

        await ensureFirstRoutineItem(genCtx('u-tz-two'), routine);

        const items = await getItemsForRoutine('u-tz-two', 'r-tz-two');
        expect(items[0]!.expectedBy).toBe('2026-08-31'); // Kiritimati wins, not Pago Pago's 08-29
    });

    it('disposal anchors on the LOCAL date, not the disposal instant', async () => {
        // Kiritimati already reads Aug 31 at 10:30Z. Anchoring on the raw instant (UTC Aug 30)
        // would regenerate for Aug 31 — the day the user is already living in — re-showing the
        // task they just completed. Anchoring on the local date advances to Sep 1.
        await reportTimezone('u-tz-disposal', 'dev', 'Pacific/Kiritimati', dayjs().toISOString());
        const routine = await seedDailyRoutine('u-tz-disposal', 'r-tz-disposal');

        await advanceRoutineAfterDisposal(genCtx('u-tz-disposal'), routine, new Date());

        const items = await getItemsForRoutine('u-tz-disposal', 'r-tz-disposal');
        expect(items).toHaveLength(1);
        expect(items[0]!.expectedBy).toBe('2026-09-01');
    });

    it('pause judges "future" against the user-local day — a locally past-due item survives', async () => {
        // Kiritimati local today is Aug 31, so an item expected Aug 30 is PAST-DUE for the user
        // and must survive the pause (the invariant is forward-looking). Under a UTC cutoff the
        // same item reads as due "today" (Aug 30 >= Aug 30) and would be wrongly trashed.
        await reportTimezone('u-tz-pause', 'dev', 'Pacific/Kiritimati', dayjs().toISOString());
        const routine = await seedDailyRoutine('u-tz-pause', 'r-tz-pause');
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'i-tz-pause',
            user: 'u-tz-pause',
            status: 'nextAction',
            title: 'tz routine',
            routineId: routine._id,
            expectedBy: '2026-08-30',
            ignoreBefore: '2026-08-30',
            createdTs: now,
            updatedTs: now,
        });

        const result = await pauseRoutine({ userId: 'u-tz-pause', tokenId: 'test-token' }, routine._id);
        expect(result.ok).toBe(true);

        const item = await itemsDAO.findByOwnerAndId('i-tz-pause', 'u-tz-pause');
        expect(item?.status).toBe('nextAction');
        const stored = await routinesDAO.findByOwnerAndId(routine._id, 'u-tz-pause');
        expect(stored?.active).toBe(false);
    });

    it('resume stamps startDate on the user-local tomorrow', async () => {
        await reportTimezone('u-tz-resume', 'dev', 'Pacific/Kiritimati', dayjs().toISOString());
        const routine = await seedDailyRoutine('u-tz-resume', 'r-tz-resume', { active: false });

        const result = await resumeRoutine({ userId: 'u-tz-resume', tokenId: 'test-token' }, routine._id);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('resume failed');
        expect(result.routine.startDate).toBe('2026-09-01'); // local tomorrow, not UTC's Aug 31
    });

    it('BYDAY weekday math runs on the user-local weekday, not the UTC weekday', async () => {
        // The subtlest consequence of the floating-date scheme: at 10:30Z it is Sunday Aug 30 in
        // UTC but already MONDAY Aug 31 on Kiritimati. For FREQ=WEEKLY;BYDAY=SU with
        // includeAnchor=true, a UTC anchor lands on the anchor itself (2026-08-30); the correct
        // local anchor has just missed Sunday and must jump a week to 2026-09-06.
        await reportTimezone('u-tz-byday', 'dev', 'Pacific/Kiritimati', dayjs().toISOString());
        const routine = await seedDailyRoutine('u-tz-byday', 'r-tz-byday', { rrule: 'FREQ=WEEKLY;BYDAY=SU' });

        await ensureFirstRoutineItem(genCtx('u-tz-byday'), routine);

        const items = await getItemsForRoutine('u-tz-byday', 'r-tz-byday');
        expect(items).toHaveLength(1);
        expect(items[0]!.expectedBy).toBe('2026-09-06');
        expect(items[0]!.ignoreBefore).toBe('2026-09-06');
    });

    it('edit-propagation schedule recompute restamps the open item on the user-local day', async () => {
        // The one converted path with no tz coverage elsewhere: a schedule-shaped routine edit
        // recomputes the open item's expectedBy/ignoreBefore via userLocalDate. Under Kiritimati
        // the first DAILY;INTERVAL=2 occurrence is local today 2026-08-31; a UTC recompute would
        // stamp 2026-08-30.
        await reportTimezone('u-tz-edit', 'dev', 'Pacific/Kiritimati', dayjs().toISOString());
        const previous = await seedDailyRoutine('u-tz-edit', 'r-tz-edit');
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'i-tz-edit',
            user: 'u-tz-edit',
            status: 'nextAction',
            title: 'tz routine',
            routineId: previous._id,
            expectedBy: '2026-08-20',
            ignoreBefore: '2026-08-20',
            createdTs: now,
            updatedTs: now,
        });

        const next: RoutineInterface = { ...previous, rrule: 'FREQ=DAILY;INTERVAL=2', updatedTs: now };
        await propagateRoutineEditToItems(genCtx('u-tz-edit'), previous, next);

        const item = await itemsDAO.findByOwnerAndId('i-tz-edit', 'u-tz-edit');
        expect(item?.expectedBy).toBe('2026-08-31');
        expect(item?.ignoreBefore).toBe('2026-08-31');
    });

    it('a garbage stored timezone degrades to UTC-day stamps instead of crashing generation', async () => {
        // F1 regression: dayjs().tz('Not/AZone') throws RangeError, and the tz resolution runs
        // BEFORE the never-fail try in both generators. The reportTimezone helper writes the row
        // directly, bypassing the route validation — the exact shape of a manual mongosh edit or
        // an ICU upgrade retiring an alias that validated at report time.
        await reportTimezone('u-tz-bad', 'dev', 'Not/AZone', dayjs().toISOString());
        const routine = await seedDailyRoutine('u-tz-bad', 'r-tz-bad');

        await ensureFirstRoutineItem(genCtx('u-tz-bad'), routine);
        const [first] = await getItemsForRoutine('u-tz-bad', 'r-tz-bad');
        if (!first?._id) throw new Error('expected the bootstrap item');
        expect(first.expectedBy).toBe('2026-08-30'); // UTC day at 10:30Z — not a throw, not local

        // Dispose it and advance — the second converted path must survive the same row.
        await itemsDAO.replaceById(first._id, { ...first, status: 'done', updatedTs: dayjs().toISOString() });
        await advanceRoutineAfterDisposal(genCtx('u-tz-bad'), routine, new Date());
        const items = await getItemsForRoutine('u-tz-bad', 'r-tz-bad');
        const created = items.find((i) => i._id !== first._id);
        expect(created?.expectedBy).toBe('2026-08-31'); // strict-after UTC Aug 30
    });

    it('a garbage stored timezone does not 500 pause — the composite has no error handling of its own', async () => {
        // Unlike the generators (which swallow errors), pauseRoutine/resumeRoutine would surface a
        // RangeError straight to the route handler — the resolver's UTC fallback is their only guard.
        await reportTimezone('u-tz-bad-pause', 'dev', 'Not/AZone', dayjs().toISOString());
        const routine = await seedDailyRoutine('u-tz-bad-pause', 'r-tz-bad-pause');
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'i-tz-bad-pause',
            user: 'u-tz-bad-pause',
            status: 'nextAction',
            title: 'tz routine',
            routineId: routine._id,
            expectedBy: '2026-08-31',
            ignoreBefore: '2026-08-31',
            createdTs: now,
            updatedTs: now,
        });

        const result = await pauseRoutine({ userId: 'u-tz-bad-pause', tokenId: 'test-token' }, routine._id);
        expect(result.ok).toBe(true);

        // UTC-day cutoff (2026-08-30): the Aug 31 item is "future" and gets trashed by the pause.
        const item = await itemsDAO.findByOwnerAndId('i-tz-bad-pause', 'u-tz-bad-pause');
        expect(item?.status).toBe('trash');
    });
});
