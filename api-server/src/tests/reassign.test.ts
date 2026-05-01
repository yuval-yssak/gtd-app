/** biome-ignore-all lint/style/noNonNullAssertion: tests assert preconditions before using ! */
import { createHmac } from 'node:crypto';
import { generateId } from 'better-auth';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import * as buildCalendarProviderModule from '../lib/buildCalendarProvider.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { syncRoutes } from '../routes/sync.js';
import type { ItemInterface, PersonInterface, RoutineInterface, WorkContextInterface } from '../types/entities.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/sync', syncRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test_reassign');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('user').deleteMany({}),
        db.collection('session').deleteMany({}),
        db.collection('items').deleteMany({}),
        db.collection('routines').deleteMany({}),
        db.collection('people').deleteMany({}),
        db.collection('workContexts').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('calendarIntegrations').deleteMany({}),
        db.collection('calendarSyncConfigs').deleteMany({}),
    ]);
    vi.restoreAllMocks();
});

// ── Multi-session cookie helpers (mirror allSyncConfigs.test.ts / syncEventsAuth.test.ts) ──

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

function buildMultiSessionCookieHeader(active: SeedSessionResult, all: SeedSessionResult[]): string {
    const pairs = [
        `${SESSION_COOKIE_NAME}=${active.signedToken}`,
        ...all.map((s) => `${SESSION_COOKIE_NAME}_multi-${s.rawToken.toLowerCase()}=${s.signedToken}`),
    ];
    return pairs.join('; ');
}

async function postReassign(cookieHeader: string, body: unknown): Promise<Response> {
    return app.fetch(
        new Request('http://localhost:4000/sync/reassign', {
            method: 'POST',
            headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

// ── Fixture builders ───────────────────────────────────────────────────────────

function makeItem(userId: string, overrides: Partial<ItemInterface> = {}): ItemInterface {
    const now = dayjs().toISOString();
    return {
        _id: generateId(16),
        user: userId,
        status: 'inbox',
        title: 'Test item',
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

function makeRoutine(userId: string, overrides: Partial<RoutineInterface> = {}): RoutineInterface {
    const now = dayjs().toISOString();
    return {
        _id: generateId(16),
        user: userId,
        title: 'Test routine',
        routineType: 'nextAction',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        template: {},
        active: true,
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

function makePerson(userId: string, overrides: Partial<PersonInterface> = {}): PersonInterface {
    const now = dayjs().toISOString();
    return {
        _id: generateId(16),
        user: userId,
        name: 'Sam',
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

function makeWorkContext(userId: string, overrides: Partial<WorkContextInterface> = {}): WorkContextInterface {
    const now = dayjs().toISOString();
    return {
        _id: generateId(16),
        user: userId,
        name: 'at desk',
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /sync/reassign', () => {
    describe('plain item', () => {
        it('moves the item from source to target user, records both ops, preserves _id', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId);
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            // Item moved: gone under source, present under target with same _id
            expect(await itemsDAO.findByOwnerAndId(item._id!, alice.userId)).toBeNull();
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?._id).toBe(item._id);
            expect(moved?.user).toBe(bob.userId);
            // Op log: delete on source, create on target
            const deleteOps = await operationsDAO.findArray({ user: alice.userId, entityId: item._id, opType: 'delete' });
            const createOps = await operationsDAO.findArray({ user: bob.userId, entityId: item._id, opType: 'create' });
            expect(deleteOps).toHaveLength(1);
            expect(createOps).toHaveLength(1);
        });

        it('returns 400 when reassigning a routine-generated item (must edit the routine instead)', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { routineId: 'routine-xyz' });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(400);
            // Item stays put under source — no DB writes.
            expect(await itemsDAO.findByOwnerAndId(item._id!, alice.userId)).not.toBeNull();
            expect(await itemsDAO.findByOwnerAndId(item._id!, bob.userId)).toBeNull();
        });

        it('returns 400 when reassigning a calendar-linked item without targetCalendar', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, {
                status: 'calendar',
                calendarEventId: 'gcal-evt-1',
                calendarIntegrationId: 'int-a',
                calendarSyncConfigId: 'cfg-a',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(400);
            expect(await itemsDAO.findByOwnerAndId(item._id!, alice.userId)).not.toBeNull();
        });

        it('returns 404 when the entity does not exist under fromUserId', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: 'does-not-exist', fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(404);
        });
    });

    describe('routine', () => {
        it('moves the routine and every generated item with it', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId);
            await routinesDAO.insertOne(routine);
            // Two generated items: one calendar (status='calendar'), one done.
            const item1 = makeItem(alice.userId, {
                routineId: routine._id,
                status: 'calendar',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            const item2 = makeItem(alice.userId, { routineId: routine._id, status: 'done' });
            await Promise.all([itemsDAO.insertOne(item1), itemsDAO.insertOne(item2)]);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'routine', entityId: routine._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            expect(await routinesDAO.findByOwnerAndId(routine._id, alice.userId)).toBeNull();
            expect(await routinesDAO.findByOwnerAndId(routine._id, bob.userId)).not.toBeNull();
            // Both generated items moved with the routine.
            expect(await itemsDAO.findByOwnerAndId(item1._id!, alice.userId)).toBeNull();
            expect(await itemsDAO.findByOwnerAndId(item2._id!, alice.userId)).toBeNull();
            expect(await itemsDAO.findByOwnerAndId(item1._id!, bob.userId)).not.toBeNull();
            expect(await itemsDAO.findByOwnerAndId(item2._id!, bob.userId)).not.toBeNull();
        });
    });

    describe('person / workContext', () => {
        it('moves a person and reports cross-user references for items still under the source user', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const person = makePerson(alice.userId);
            await peopleDAO.insertOne(person);
            // An item under alice references the person — after the move, the item still references the same _id but
            // the person now lives under bob's account.
            const referencingItem = makeItem(alice.userId, { peopleIds: [person._id] });
            await itemsDAO.insertOne(referencingItem);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'person', entityId: person._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const body = (await res.json()) as { ok: boolean; crossUserReferences?: { peopleIds?: string[] } };
            expect(body.ok).toBe(true);
            expect(body.crossUserReferences?.peopleIds).toEqual([referencingItem._id]);
            expect(await peopleDAO.findByOwnerAndId(person._id, alice.userId)).toBeNull();
            expect(await peopleDAO.findByOwnerAndId(person._id, bob.userId)).not.toBeNull();
        });

        it('moves a workContext and reports cross-user references', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const wc = makeWorkContext(alice.userId);
            await workContextsDAO.insertOne(wc);
            const referencingItem = makeItem(alice.userId, { workContextIds: [wc._id] });
            await itemsDAO.insertOne(referencingItem);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'workContext', entityId: wc._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const body = (await res.json()) as { ok: boolean; crossUserReferences?: { workContextIds?: string[] } };
            expect(body.crossUserReferences?.workContextIds).toEqual([referencingItem._id]);
        });
    });

    describe('calendar-linked item with GCal', () => {
        it('creates on target then deletes on source via the provider, then persists DB move', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');

            // Seed encrypted integration + sync configs for both users so resolveDecrypted works.
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-a',
                user: alice.userId,
                provider: 'google',
                accessToken: 'at-a',
                refreshToken: 'rt-a',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-b',
                user: bob.userId,
                provider: 'google',
                accessToken: 'at-b',
                refreshToken: 'rt-b',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-a',
                integrationId: 'int-a',
                user: alice.userId,
                calendarId: 'primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-b',
                integrationId: 'int-b',
                user: bob.userId,
                calendarId: 'primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });

            const item = makeItem(alice.userId, {
                status: 'calendar',
                calendarEventId: 'gcal-evt-original',
                calendarIntegrationId: 'int-a',
                calendarSyncConfigId: 'cfg-a',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            await itemsDAO.insertOne(item);

            // Mock the provider so create returns a new event id and delete is a no-op.
            const createEvent = vi.fn().mockResolvedValue('gcal-evt-new');
            const deleteEvent = vi.fn().mockResolvedValue(undefined);
            const stubProvider = { createEvent, deleteEvent, getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') };
            const buildSpy = vi.spyOn(buildCalendarProviderModule, 'buildCalendarProvider').mockImplementation(() => stubProvider as never);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
            });

            expect(res.status).toBe(200);
            // Provider was called in the right order — create on target first, then delete on source.
            expect(createEvent).toHaveBeenCalledTimes(1);
            expect(deleteEvent).toHaveBeenCalledTimes(1);
            const createOrder = createEvent.mock.invocationCallOrder[0];
            const deleteOrder = deleteEvent.mock.invocationCallOrder[0];
            expect(createOrder).toBeDefined();
            expect(deleteOrder).toBeDefined();
            expect(createOrder!).toBeLessThan(deleteOrder!);
            // Item now under bob with the new event id.
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.calendarEventId).toBe('gcal-evt-new');
            expect(moved?.calendarIntegrationId).toBe('int-b');
            buildSpy.mockRestore();
        });

        it('returns 502 with no DB writes when create-on-target fails', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-a',
                user: alice.userId,
                provider: 'google',
                accessToken: 'at-a',
                refreshToken: 'rt-a',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-b',
                user: bob.userId,
                provider: 'google',
                accessToken: 'at-b',
                refreshToken: 'rt-b',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-a',
                integrationId: 'int-a',
                user: alice.userId,
                calendarId: 'primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-b',
                integrationId: 'int-b',
                user: bob.userId,
                calendarId: 'primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });

            const item = makeItem(alice.userId, {
                status: 'calendar',
                calendarEventId: 'gcal-evt-orig',
                calendarIntegrationId: 'int-a',
                calendarSyncConfigId: 'cfg-a',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            await itemsDAO.insertOne(item);

            const createEvent = vi.fn().mockRejectedValue(new Error('Google rejected the create'));
            const deleteEvent = vi.fn();
            const buildSpy = vi
                .spyOn(buildCalendarProviderModule, 'buildCalendarProvider')
                .mockImplementation(() => ({ createEvent, deleteEvent, getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') }) as never);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
            });

            expect(res.status).toBe(502);
            // No DB changes — item still belongs to alice, no ops recorded.
            expect(await itemsDAO.findByOwnerAndId(item._id!, alice.userId)).not.toBeNull();
            expect(await itemsDAO.findByOwnerAndId(item._id!, bob.userId)).toBeNull();
            expect(await operationsDAO.findArray({ entityId: item._id })).toHaveLength(0);
            // delete-on-source must not have been called when create-on-target failed.
            expect(deleteEvent).not.toHaveBeenCalled();
            buildSpy.mockRestore();
        });

        // Real-world bug: an item carried a stale calendarIntegrationId pointing at an integration
        // that no longer resolves under fromUserId (e.g. cleanup script removed it, or the id was
        // never valid). Without the fallback, the GCal event would survive on the source calendar
        // and the user sees the event "duplicated" across both accounts. The fallback walks every
        // integration of fromUserId and tries deleteEvent until one succeeds.
        it('falls back to probing every sync config of fromUserId until one matches when the stored source ids are stale', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            // Alice owns one Google integration ((user, provider) is unique) but two sync configs
            // — a "wrong" calendar (the event isn't there → 404) and the "real" one. The fallback
            // must iterate past the failing config and find the right one.
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-a',
                user: alice.userId,
                provider: 'google',
                accessToken: 'at-a',
                refreshToken: 'rt-a',
                status: 'active',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-b',
                user: bob.userId,
                provider: 'google',
                accessToken: 'at-b',
                refreshToken: 'rt-b',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-a-wrong',
                integrationId: 'int-a',
                user: alice.userId,
                calendarId: 'alice-other',
                isDefault: false,
                enabled: true,
                timeZone: 'UTC',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-a-real',
                integrationId: 'int-a',
                user: alice.userId,
                calendarId: 'alice-primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-b',
                integrationId: 'int-b',
                user: bob.userId,
                calendarId: 'bob-primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });

            // Item carries STALE source ids that don't resolve under alice — primary lookup fails.
            const item = makeItem(alice.userId, {
                status: 'calendar',
                calendarEventId: 'gcal-evt-orig',
                calendarIntegrationId: 'int-a-stale',
                calendarSyncConfigId: 'cfg-a-stale',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            await itemsDAO.insertOne(item);

            const createEvent = vi.fn().mockResolvedValue('gcal-evt-new');
            // Reject deletes against the wrong calendar (mimics GCal 404), succeed on the real one.
            // This makes the test concretely exercise the per-attempt try/catch — the fallback must
            // skip past the failing wrong-calendar attempt and continue to the matching one.
            const deleteEvent = vi.fn().mockImplementation(async (calendarId: string) => {
                if (calendarId === 'alice-other') {
                    throw Object.assign(new Error('Not Found'), { code: 404 });
                }
            });
            const stubProvider = { createEvent, deleteEvent, getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') };
            const buildSpy = vi.spyOn(buildCalendarProviderModule, 'buildCalendarProvider').mockImplementation(() => stubProvider as never);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
            });

            expect(res.status).toBe(200);
            expect(createEvent).toHaveBeenCalledTimes(1);
            expect(createEvent.mock.calls[0]?.[0]).toBe('bob-primary');
            // The fallback hit BOTH alice calendars — the wrong one threw, the real one succeeded.
            const deleteCalls = deleteEvent.mock.calls.map((c) => c[0]);
            expect(deleteCalls).toContain('alice-other');
            expect(deleteCalls).toContain('alice-primary');
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.calendarEventId).toBe('gcal-evt-new');
            buildSpy.mockRestore();
        });

        // Bail branch: fromUserId has no integrations at all. The move on target still succeeds —
        // the source GCal event is left as a stub and the warning is logged. No exception escapes.
        it('logs a stub-event warning and completes the move when fromUserId has no integrations', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            // Only bob has an integration — alice has none.
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-b',
                user: bob.userId,
                provider: 'google',
                accessToken: 'at-b',
                refreshToken: 'rt-b',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-b',
                integrationId: 'int-b',
                user: bob.userId,
                calendarId: 'bob-primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });

            const item = makeItem(alice.userId, {
                status: 'calendar',
                calendarEventId: 'gcal-evt-orig',
                calendarIntegrationId: 'int-a-stale',
                calendarSyncConfigId: 'cfg-a-stale',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            await itemsDAO.insertOne(item);

            const createEvent = vi.fn().mockResolvedValue('gcal-evt-new');
            const deleteEvent = vi.fn();
            const stubProvider = { createEvent, deleteEvent, getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') };
            const buildSpy = vi.spyOn(buildCalendarProviderModule, 'buildCalendarProvider').mockImplementation(() => stubProvider as never);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
            });

            expect(res.status).toBe(200);
            expect(createEvent).toHaveBeenCalledTimes(1);
            expect(deleteEvent).not.toHaveBeenCalled();
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.calendarEventId).toBe('gcal-evt-new');
            buildSpy.mockRestore();
        });

        // Bail branch: every probe attempt throws. The move still succeeds, the warn includes the
        // last error, and no exception escapes the reassign call.
        it('logs the last error and completes the move when every fallback probe throws', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-a',
                user: alice.userId,
                provider: 'google',
                accessToken: 'at-a',
                refreshToken: 'rt-a',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-b',
                user: bob.userId,
                provider: 'google',
                accessToken: 'at-b',
                refreshToken: 'rt-b',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-a',
                integrationId: 'int-a',
                user: alice.userId,
                calendarId: 'alice-primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-b',
                integrationId: 'int-b',
                user: bob.userId,
                calendarId: 'bob-primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });

            const item = makeItem(alice.userId, {
                status: 'calendar',
                calendarEventId: 'gcal-evt-orig',
                calendarIntegrationId: 'int-a-stale',
                calendarSyncConfigId: 'cfg-a-stale',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            await itemsDAO.insertOne(item);

            const createEvent = vi.fn().mockResolvedValue('gcal-evt-new');
            const deleteEvent = vi.fn().mockImplementation(async (calendarId: string) => {
                if (calendarId === 'alice-primary') {
                    throw new Error('invalid_grant');
                }
            });
            const stubProvider = { createEvent, deleteEvent, getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') };
            const buildSpy = vi.spyOn(buildCalendarProviderModule, 'buildCalendarProvider').mockImplementation(() => stubProvider as never);
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
            });

            expect(res.status).toBe(200);
            // Probe was attempted on alice's calendar; it threw. No success log; aggregate warn includes the error.
            expect(deleteEvent).toHaveBeenCalledWith('alice-primary', 'gcal-evt-orig');
            const aggregateWarn = warnSpy.mock.calls.find((args) => typeof args[0] === 'string' && args[0].includes('fallback probes did not find event'));
            expect(aggregateWarn?.[0]).toContain('invalid_grant');
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.calendarEventId).toBe('gcal-evt-new');
            buildSpy.mockRestore();
            warnSpy.mockRestore();
        });
    });

    describe('session validation', () => {
        it('rejects with 403 when fromUserId is not a session on this device', async () => {
            const alice = await seedUserSession('alice@example.com');
            const eve = await seedUserSession('eve@example.com');
            const bob = await seedUserSession('bob@example.com');
            // Cookie carries alice + bob; eve's session is in the DB but NOT in this device's session set.
            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);

            const res = await postReassign(cookie, { entityType: 'item', entityId: 'whatever', fromUserId: eve.userId, toUserId: bob.userId });
            expect(res.status).toBe(403);
        });

        it('rejects with 403 when toUserId is not a session on this device', async () => {
            const alice = await seedUserSession('alice@example.com');
            const eve = await seedUserSession('eve@example.com');
            const cookie = buildMultiSessionCookieHeader(alice, [alice]);

            const res = await postReassign(cookie, { entityType: 'item', entityId: 'whatever', fromUserId: alice.userId, toUserId: eve.userId });
            expect(res.status).toBe(403);
        });

        it('rejects with 400 when fromUserId equals toUserId', async () => {
            const alice = await seedUserSession('alice@example.com');
            const cookie = buildMultiSessionCookieHeader(alice, [alice]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: 'whatever', fromUserId: alice.userId, toUserId: alice.userId });
            expect(res.status).toBe(400);
        });

        it('returns 401 when no session is present', async () => {
            const res = await app.fetch(
                new Request('http://localhost:4000/sync/reassign', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ entityType: 'item', entityId: 'x', fromUserId: 'a', toUserId: 'b' }),
                }),
            );
            expect(res.status).toBe(401);
        });
    });

    // editPatch: lets the dialog edit + move atomically. Without this, the dialog had to write
    // the source-user copy first (which silently corrupted data when the active session was the
    // target). Now the server is the only writer for cross-account edits.
    describe('editPatch (item)', () => {
        it('applies title/notes patch to the persisted snapshot under toUserId', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { title: 'Original', notes: 'old notes' });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editPatch: { title: 'Renamed', notes: 'new notes' },
            });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.title).toBe('Renamed');
            expect(moved?.notes).toBe('new notes');
        });

        it('applies nextAction patch fields (workContextIds, peopleIds, energy, time, urgent, focus, expectedBy, ignoreBefore, waitingForPersonId)', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { status: 'nextAction' });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editPatch: {
                    workContextIds: ['ctx-1', 'ctx-2'],
                    peopleIds: ['p-1'],
                    energy: 'high',
                    time: 30,
                    urgent: true,
                    focus: true,
                    expectedBy: '2026-12-31',
                    ignoreBefore: '2026-12-01',
                    waitingForPersonId: 'p-2',
                },
            });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved).toMatchObject({
                workContextIds: ['ctx-1', 'ctx-2'],
                peopleIds: ['p-1'],
                energy: 'high',
                time: 30,
                urgent: true,
                focus: true,
                expectedBy: '2026-12-31',
                ignoreBefore: '2026-12-01',
                waitingForPersonId: 'p-2',
            });
        });

        it('drops forged whitelist-violating fields (user, _id, updatedTs, routineId)', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { title: 'orig' });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                // Cast to suppress the type error — the test verifies runtime drop behaviour for
                // fields that are deliberately not on ReassignItemEditPatch.
                editPatch: {
                    title: 'renamed',
                    user: 'malicious-user-id',
                    _id: 'malicious-id',
                    updatedTs: '1970-01-01T00:00:00Z',
                    routineId: 'malicious-routine',
                } as never,
            });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.title).toBe('renamed');
            expect(moved?.user).toBe(bob.userId);
            expect(moved?._id).toBe(item._id);
            expect(moved?.updatedTs).not.toBe('1970-01-01T00:00:00Z');
            expect(moved?.routineId).toBeUndefined();
        });

        it('applies editPatch to GCal createEvent for calendar-linked items so the new event reflects user edits', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-a',
                user: alice.userId,
                provider: 'google',
                accessToken: 'at-a',
                refreshToken: 'rt-a',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-b',
                user: bob.userId,
                provider: 'google',
                accessToken: 'at-b',
                refreshToken: 'rt-b',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-a',
                integrationId: 'int-a',
                user: alice.userId,
                calendarId: 'primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-b',
                integrationId: 'int-b',
                user: bob.userId,
                calendarId: 'primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: dayjs().toISOString(),
                updatedTs: dayjs().toISOString(),
            });

            const item = makeItem(alice.userId, {
                status: 'calendar',
                title: 'Old title',
                notes: 'old notes',
                calendarEventId: 'gcal-evt-orig',
                calendarIntegrationId: 'int-a',
                calendarSyncConfigId: 'cfg-a',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            await itemsDAO.insertOne(item);

            const createEvent = vi.fn().mockResolvedValue('gcal-evt-new');
            const deleteEvent = vi.fn().mockResolvedValue(undefined);
            const buildSpy = vi
                .spyOn(buildCalendarProviderModule, 'buildCalendarProvider')
                .mockImplementation(() => ({ createEvent, deleteEvent, getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') }) as never);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
                editPatch: {
                    title: 'New title',
                    notes: 'new notes',
                    timeStart: '2030-01-01T12:00:00Z',
                    timeEnd: '2030-01-01T13:30:00Z',
                },
            });

            expect(res.status).toBe(200);
            // createEvent receives the patched title + times so the new GCal event reflects user edits.
            expect(createEvent).toHaveBeenCalledTimes(1);
            const [, evt] = createEvent.mock.calls[0]!;
            expect(evt).toMatchObject({ title: 'New title', timeStart: '2030-01-01T12:00:00Z', timeEnd: '2030-01-01T13:30:00Z' });
            // Persisted snapshot also reflects the edits + new event id + target calendar refs.
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved).toMatchObject({
                title: 'New title',
                notes: 'new notes',
                calendarEventId: 'gcal-evt-new',
                calendarIntegrationId: 'int-b',
                calendarSyncConfigId: 'cfg-b',
            });
            buildSpy.mockRestore();
        });

        it('omitting editPatch leaves all editable fields unchanged', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { title: 'kept', notes: 'also kept', urgent: true });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved).toMatchObject({ title: 'kept', notes: 'also kept', urgent: true });
        });
    });

    describe('editRoutinePatch', () => {
        it('applies title, rrule, startDate, routineType, and template to the persisted routine snapshot', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId, { title: 'orig', rrule: 'FREQ=WEEKLY;BYDAY=MO' });
            await routinesDAO.insertOne(routine);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'routine',
                entityId: routine._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editRoutinePatch: {
                    title: 'renamed',
                    rrule: 'FREQ=DAILY;INTERVAL=1',
                    startDate: '2026-06-01',
                    routineType: 'calendar',
                    template: { energy: 'high', time: 45 },
                    calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
                    active: false,
                },
            });

            expect(res.status).toBe(200);
            const moved = await routinesDAO.findByOwnerAndId(routine._id, bob.userId);
            expect(moved).toMatchObject({
                title: 'renamed',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                startDate: '2026-06-01',
                routineType: 'calendar',
                template: { energy: 'high', time: 45 },
                calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
                active: false,
            });
        });

        it('drops forged whitelist-violating routine fields (user, _id, updatedTs)', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId);
            await routinesDAO.insertOne(routine);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'routine',
                entityId: routine._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editRoutinePatch: { title: 'renamed', user: 'mal', _id: 'mal-id', updatedTs: '1970-01-01T00:00:00Z' } as never,
            });

            expect(res.status).toBe(200);
            const moved = await routinesDAO.findByOwnerAndId(routine._id, bob.userId);
            expect(moved?.title).toBe('renamed');
            expect(moved?.user).toBe(bob.userId);
            expect(moved?._id).toBe(routine._id);
            expect(moved?.updatedTs).not.toBe('1970-01-01T00:00:00Z');
        });

        it('still moves generated items when editRoutinePatch is provided', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId);
            await routinesDAO.insertOne(routine);
            const generated = makeItem(alice.userId, { routineId: routine._id, status: 'nextAction' });
            await itemsDAO.insertOne(generated);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'routine',
                entityId: routine._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editRoutinePatch: { title: 'renamed' },
            });

            expect(res.status).toBe(200);
            // Generated item moved with the routine and kept its routineId link.
            expect(await itemsDAO.findByOwnerAndId(generated._id!, alice.userId)).toBeNull();
            const movedGenerated = await itemsDAO.findByOwnerAndId(generated._id!, bob.userId);
            expect(movedGenerated?.routineId).toBe(routine._id);
        });

        it('startDate="" clears the routine startDate (empty-string convention)', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId, { startDate: '2026-01-01' });
            await routinesDAO.insertOne(routine);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'routine',
                entityId: routine._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editRoutinePatch: { startDate: '' },
            });

            expect(res.status).toBe(200);
            const moved = await routinesDAO.findByOwnerAndId(routine._id, bob.userId);
            expect(moved?.startDate).toBeUndefined();
        });

        it('ignores invalid routineType values (must be "nextAction" | "calendar")', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId, { routineType: 'nextAction' });
            await routinesDAO.insertOne(routine);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'routine',
                entityId: routine._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editRoutinePatch: { routineType: 'somethingElse' as never },
            });

            expect(res.status).toBe(200);
            const moved = await routinesDAO.findByOwnerAndId(routine._id, bob.userId);
            expect(moved?.routineType).toBe('nextAction');
        });
    });

    // Edge cases for the editPatch whitelist that aren't covered above. These lock in the
    // empty-string-clears / invalid-value-ignored semantics so a future refactor can't silently
    // change the contract.
    describe('editPatch whitelist edge cases', () => {
        it('notes="" clears the notes field on the moved item', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { notes: 'old notes' });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editPatch: { notes: '' },
            });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.notes).toBeUndefined();
        });

        it('peopleIds=[] clears the peopleIds field on the moved item', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { status: 'nextAction', peopleIds: ['p-1', 'p-2'] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editPatch: { peopleIds: [] },
            });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.peopleIds).toBeUndefined();
        });

        it('energy="" clears a previously-set energy', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { status: 'nextAction', energy: 'high' });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editPatch: { energy: '' },
            });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.energy).toBeUndefined();
        });

        it('time="" clears a previously-set time estimate', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { status: 'nextAction', time: 30 });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editPatch: { time: '' },
            });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.time).toBeUndefined();
        });

        it('ignores invalid energy values and non-finite time values', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { status: 'nextAction', energy: 'medium', time: 30 });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editPatch: { energy: 'banana' as never, time: Number.NaN },
            });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.energy).toBe('medium');
            expect(moved?.time).toBe(30);
        });

        it('omitting urgent/focus in the patch leaves the prior boolean values untouched', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { status: 'nextAction', urgent: true, focus: true });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editPatch: { title: 'unchanged-elsewhere' },
            });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.urgent).toBe(true);
            expect(moved?.focus).toBe(true);
        });

        it('urgent: false in the patch flips an urgent item to not-urgent', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { status: 'nextAction', urgent: true });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editPatch: { urgent: false },
            });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.urgent).toBe(false);
        });
    });
});
