/** biome-ignore-all lint/style/noNonNullAssertion: tests assert preconditions before using ! */
import { createHmac } from 'node:crypto';
import { generateId } from 'better-auth';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
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

dayjs.extend(utc);

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
        // Step 2 of the fan-out fix series: the routine reassign relies on the source-leg delete's
        // pushRoutineDeletion cascade to (a) hard-delete the GCal recurring master event and
        // (b) trash every status='calendar' generated item under fromUserId. We pin the cascade's
        // visible side-effects here so a future refactor can't silently revert to the old "move
        // generated items to the target" behavior (which would inherit broken state on Bob).
        it('hard-deletes the source GCal master via pushRoutineDeletion and trashes source-side calendar items — cascade still fires', async () => {
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
            const routine = makeRoutine(alice.userId, {
                routineType: 'calendar',
                calendarEventId: 'gcal-master-routine',
                calendarIntegrationId: 'int-a',
                calendarSyncConfigId: 'cfg-a',
                calendarItemTemplate: { timeOfDay: '10:00', duration: 30 },
            });
            await routinesDAO.insertOne(routine);
            const generated = makeItem(alice.userId, {
                routineId: routine._id,
                status: 'calendar',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T10:30:00Z',
            });
            await itemsDAO.insertOne(generated);

            const deleteRecurringEvent = vi.fn().mockResolvedValue(undefined);
            const stubProvider = {
                deleteRecurringEvent,
                createEvent: vi.fn(),
                updateEvent: vi.fn(),
                deleteEvent: vi.fn(),
                getCalendarTimeZone: vi.fn().mockResolvedValue('UTC'),
            };
            const buildSpy = vi.spyOn(buildCalendarProviderModule, 'buildCalendarProvider').mockImplementation(() => stubProvider as never);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'routine', entityId: routine._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            // Routine moved to Bob. Calendar links stripped on Bob's copy so he doesn't push to Alice's GCal.
            const movedRoutine = await routinesDAO.findByOwnerAndId(routine._id, bob.userId);
            expect(movedRoutine).not.toBeNull();
            expect(movedRoutine?.calendarEventId).toBeUndefined();
            expect(movedRoutine?.calendarIntegrationId).toBeUndefined();
            // Cascade fired: GCal master hard-deleted, source calendar items trashed (poll briefly because notifyChange's
            // pushback leg is fire-and-forget on the calendarPushback path).
            const deadline = Date.now() + 1500;
            while (Date.now() < deadline && deleteRecurringEvent.mock.calls.length === 0) {
                await new Promise<void>((r) => setTimeout(r, 20));
            }
            expect(deleteRecurringEvent).toHaveBeenCalledWith('gcal-master-routine', 'primary');
            const sourceItem = await itemsDAO.findByOwnerAndId(generated._id!, alice.userId);
            expect(sourceItem?.status).toBe('trash');
            buildSpy.mockRestore();
        });

        it('moves the routine and trashes source-side generated items via the cascade — Bob inherits no historical items', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId);
            await routinesDAO.insertOne(routine);
            // Two generated items: one open calendar (cascade target), one already done.
            const item1 = makeItem(alice.userId, {
                routineId: routine._id,
                status: 'calendar',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
                calendarInstanceEventId: 'gcal-master-routine_20300101T100000Z',
            });
            const item2 = makeItem(alice.userId, { routineId: routine._id, status: 'done' });
            await Promise.all([itemsDAO.insertOne(item1), itemsDAO.insertOne(item2)]);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'routine', entityId: routine._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            expect(await routinesDAO.findByOwnerAndId(routine._id, alice.userId)).toBeNull();
            expect(await routinesDAO.findByOwnerAndId(routine._id, bob.userId)).not.toBeNull();
            // Cascade: open calendar items under Alice flip to 'trash' (recoverable, not 'done').
            // The historical 'done' item is left as-is — `trashGeneratedCalendarItems` only touches
            // status='calendar' rows, by design (matrix A8).
            const aliceItem1 = await itemsDAO.findByOwnerAndId(item1._id!, alice.userId);
            expect(aliceItem1?.status).toBe('trash');
            // The trashed item releases its instance id so a re-import can't be E11000-blocked by it.
            expect(aliceItem1?.calendarInstanceEventId).toBeUndefined();
            const aliceItem2 = await itemsDAO.findByOwnerAndId(item2._id!, alice.userId);
            expect(aliceItem2?.status).toBe('done');
            // Bob inherits NO historical generated items — the routine starts fresh on his side.
            expect(await itemsDAO.findByOwnerAndId(item1._id!, bob.userId)).toBeNull();
            expect(await itemsDAO.findByOwnerAndId(item2._id!, bob.userId)).toBeNull();
        });

        it('seeds the first nextAction item for the new owner — the moved routine must not sit itemless', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId, { rrule: 'FREQ=DAILY' });
            await routinesDAO.insertOne(routine);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'routine', entityId: routine._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const bobItems = await itemsDAO.findArray({ user: bob.userId, routineId: routine._id, status: 'nextAction' });
            expect(bobItems).toHaveLength(1);
            const [seeded] = bobItems;
            if (!seeded) throw new Error('expected one seeded nextAction item');
            expect(seeded.title).toBe(routine.title);
            // Routine-generated items are ticklered until their due date; daily rrule lands today.
            expect(seeded.expectedBy).toBe(dayjs.utc().format('YYYY-MM-DD'));
            expect(seeded.ignoreBefore).toBe(seeded.expectedBy);
            // The seed op must be recorded on Bob's op log so his devices pull the item.
            const seededOps = await operationsDAO.findArray({ user: bob.userId, entityType: 'item', entityId: seeded._id });
            expect(seededOps).toHaveLength(1);
            const [seedOp] = seededOps;
            if (!seedOp) throw new Error('expected one seed op');
            // The in-app /sync/reassign path stamps 'server' (not api:<tokenId>) — the exact
            // behavior the deviceId-context refactor exists to preserve.
            expect(seedOp.deviceId).toBe('server');
        });

        it('seeds calendar items to the horizon for the new owner of a calendar routine', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId, {
                routineType: 'calendar',
                rrule: 'FREQ=DAILY',
                calendarItemTemplate: { timeOfDay: '10:00', duration: 60 },
            });
            await routinesDAO.insertOne(routine);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'routine', entityId: routine._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const bobItems = await itemsDAO.findArray({ user: bob.userId, routineId: routine._id, status: 'calendar' });
            expect(bobItems.length).toBeGreaterThan(0);
            for (const item of bobItems) {
                expect(item.timeStart).toMatch(/T10:00:00$/);
                // The moved routine is never GCal-linked, so seeded items carry no link fields.
                expect(item.calendarInstanceEventId).toBeUndefined();
                expect(item.calendarIntegrationId).toBeUndefined();
            }
        });

        it('does not seed items for an inactive moved routine', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId, { rrule: 'FREQ=DAILY', active: false });
            await routinesDAO.insertOne(routine);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'routine', entityId: routine._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            expect(await itemsDAO.findArray({ user: bob.userId, routineId: routine._id })).toHaveLength(0);
        });
    });

    describe('person / workContext are not reassignable', () => {
        // The previous "move the entity + report dangling refs" gesture has been replaced by
        // automatic find-or-create on the item/routine reassign path. People and workContexts
        // are intentionally NOT directly reassignable — the source user keeps their address
        // book and context list intact when handing off an item.
        it('rejects entityType=person with 400 validation_failed and leaves the person under fromUserId', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const person = makePerson(alice.userId);
            await peopleDAO.insertOne(person);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'person', entityId: person._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(400);
            const body = (await res.json()) as { error: string };
            expect(body.error).toMatch(/cannot be reassigned/);
            // Person is untouched on both sides.
            expect(await peopleDAO.findByOwnerAndId(person._id, alice.userId)).not.toBeNull();
            expect(await peopleDAO.findByOwnerAndId(person._id, bob.userId)).toBeNull();
        });

        it('rejects entityType=workContext with 400 validation_failed and leaves the workContext under fromUserId', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const wc = makeWorkContext(alice.userId);
            await workContextsDAO.insertOne(wc);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'workContext', entityId: wc._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(400);
            const body = (await res.json()) as { error: string };
            expect(body.error).toMatch(/cannot be reassigned/);
            expect(await workContextsDAO.findByOwnerAndId(wc._id, alice.userId)).not.toBeNull();
            expect(await workContextsDAO.findByOwnerAndId(wc._id, bob.userId)).toBeNull();
        });
    });

    describe('item reference relinking', () => {
        // Every item-reassign that carries peopleIds / workContextIds / waitingForPersonId must
        // resolve each ref into the target user's account: reuse an existing record by email or
        // name, otherwise create a mirror. The source user's people/workContexts are NEVER
        // mutated — they keep their address book intact across the move.

        it('creates a mirror person under toUserId when the target has no match, rewrites peopleIds to the new id, and leaves the source person intact', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const alicePerson = makePerson(alice.userId, { name: 'Sam', email: 'sam@example.com' });
            await peopleDAO.insertOne(alicePerson);
            const item = makeItem(alice.userId, { status: 'nextAction', peopleIds: [alicePerson._id] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            // Source person is untouched.
            const aliceSam = await peopleDAO.findByOwnerAndId(alicePerson._id, alice.userId);
            expect(aliceSam).not.toBeNull();
            expect(aliceSam?.email).toBe('sam@example.com');
            // Bob has a new mirror person with the same name + email but a new _id.
            const bobPeople = await peopleDAO.findArray({ user: bob.userId });
            expect(bobPeople).toHaveLength(1);
            const [bobSam] = bobPeople;
            if (!bobSam) throw new Error('expected one mirror person under bob');
            expect(bobSam._id).not.toBe(alicePerson._id);
            expect(bobSam.name).toBe('Sam');
            expect(bobSam.email).toBe('sam@example.com');
            // Item under bob now points at the mirror.
            const movedItem = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(movedItem?.peopleIds).toEqual([bobSam._id]);
        });

        it('reuses an existing person under toUserId when emails match exactly, no mirror created', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const alicePerson = makePerson(alice.userId, { name: 'Sam', email: 'sam@example.com' });
            // Bob already has a person with the same email — different name + different _id.
            const bobPerson = makePerson(bob.userId, { name: 'Samuel', email: 'sam@example.com' });
            await Promise.all([peopleDAO.insertOne(alicePerson), peopleDAO.insertOne(bobPerson)]);
            const item = makeItem(alice.userId, { status: 'nextAction', peopleIds: [alicePerson._id] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const bobPeople = await peopleDAO.findArray({ user: bob.userId });
            // No mirror created — bob still has exactly the one record he started with.
            expect(bobPeople).toHaveLength(1);
            const movedItem = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(movedItem?.peopleIds).toEqual([bobPerson._id]);
        });

        it('falls back to name match when source has no email but the target has a same-named person', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const alicePerson = makePerson(alice.userId, { name: 'Sam' });
            const bobPerson = makePerson(bob.userId, { name: 'Sam' });
            await Promise.all([peopleDAO.insertOne(alicePerson), peopleDAO.insertOne(bobPerson)]);
            const item = makeItem(alice.userId, { status: 'nextAction', peopleIds: [alicePerson._id] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const bobPeople = await peopleDAO.findArray({ user: bob.userId });
            expect(bobPeople).toHaveLength(1);
            const movedItem = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(movedItem?.peopleIds).toEqual([bobPerson._id]);
        });

        it('prefers email match over name match — different name same email beats same name different email', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const alicePerson = makePerson(alice.userId, { name: 'Sam', email: 'sam@example.com' });
            // Two candidates under bob: one by name (no email), one by email (different name).
            // Email-first policy must pick the email match.
            const bobByName = makePerson(bob.userId, { name: 'Sam' });
            const bobByEmail = makePerson(bob.userId, { name: 'Samuel', email: 'sam@example.com' });
            await Promise.all([peopleDAO.insertOne(alicePerson), peopleDAO.insertOne(bobByName), peopleDAO.insertOne(bobByEmail)]);
            const item = makeItem(alice.userId, { status: 'nextAction', peopleIds: [alicePerson._id] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const movedItem = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(movedItem?.peopleIds).toEqual([bobByEmail._id]);
        });

        it('relinks workContextIds — reuses by name match', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const aliceCtx = makeWorkContext(alice.userId, { name: 'at desk' });
            const bobCtx = makeWorkContext(bob.userId, { name: 'at desk' });
            await Promise.all([workContextsDAO.insertOne(aliceCtx), workContextsDAO.insertOne(bobCtx)]);
            const item = makeItem(alice.userId, { status: 'nextAction', workContextIds: [aliceCtx._id] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const bobContexts = await workContextsDAO.findArray({ user: bob.userId });
            // No mirror created — bob's existing context wins.
            expect(bobContexts).toHaveLength(1);
            const movedItem = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(movedItem?.workContextIds).toEqual([bobCtx._id]);
        });

        it('relinks workContextIds — creates mirror when bob has no match, leaves alice context intact', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const aliceCtx = makeWorkContext(alice.userId, { name: 'with family' });
            await workContextsDAO.insertOne(aliceCtx);
            const item = makeItem(alice.userId, { status: 'nextAction', workContextIds: [aliceCtx._id] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            // Alice still owns hers.
            expect(await workContextsDAO.findByOwnerAndId(aliceCtx._id, alice.userId)).not.toBeNull();
            // Bob has a brand-new mirror with the same name and a new _id.
            const bobContexts = await workContextsDAO.findArray({ user: bob.userId });
            expect(bobContexts).toHaveLength(1);
            const [bobCtx] = bobContexts;
            if (!bobCtx) throw new Error('expected one mirror context under bob');
            expect(bobCtx._id).not.toBe(aliceCtx._id);
            expect(bobCtx.name).toBe('with family');
            const movedItem = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(movedItem?.workContextIds).toEqual([bobCtx._id]);
        });

        it('relinks waitingForPersonId on a waitingFor item — creates mirror under bob', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const alicePerson = makePerson(alice.userId, { name: 'Wendy', email: 'wendy@example.com' });
            await peopleDAO.insertOne(alicePerson);
            const item = makeItem(alice.userId, { status: 'waitingFor', waitingForPersonId: alicePerson._id });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const bobPeople = await peopleDAO.findArray({ user: bob.userId });
            expect(bobPeople).toHaveLength(1);
            const [bobWendy] = bobPeople;
            if (!bobWendy) throw new Error('expected one mirror person under bob');
            expect(bobWendy.email).toBe('wendy@example.com');
            const movedItem = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(movedItem?.waitingForPersonId).toBe(bobWendy._id);
            expect(movedItem?.waitingForPersonId).not.toBe(alicePerson._id);
        });

        it('passes through ids that point at people the source user does not own (no spurious creates)', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            // peopleIds contains a stale id — neither alice nor bob owns this person.
            const item = makeItem(alice.userId, { status: 'nextAction', peopleIds: ['stale-uuid-from-elsewhere'] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            // No mirror person created — there was no source row to mirror.
            expect(await peopleDAO.findArray({ user: bob.userId })).toHaveLength(0);
            const movedItem = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(movedItem?.peopleIds).toEqual(['stale-uuid-from-elsewhere']);
        });

        it('mixes reuse + create in a single item — one matching person, one missing context', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const alicePerson = makePerson(alice.userId, { name: 'Sam', email: 'sam@example.com' });
            const bobPerson = makePerson(bob.userId, { name: 'Sam', email: 'sam@example.com' });
            const aliceCtx = makeWorkContext(alice.userId, { name: 'focused at laptop' });
            await Promise.all([peopleDAO.insertOne(alicePerson), peopleDAO.insertOne(bobPerson), workContextsDAO.insertOne(aliceCtx)]);
            const item = makeItem(alice.userId, { status: 'nextAction', peopleIds: [alicePerson._id], workContextIds: [aliceCtx._id] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            // Person reused.
            expect(await peopleDAO.findArray({ user: bob.userId })).toHaveLength(1);
            // Context mirror created.
            const bobContexts = await workContextsDAO.findArray({ user: bob.userId });
            expect(bobContexts).toHaveLength(1);
            const [bobCtx] = bobContexts;
            if (!bobCtx) throw new Error('expected one mirror context under bob');
            const movedItem = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(movedItem?.peopleIds).toEqual([bobPerson._id]);
            expect(movedItem?.workContextIds).toEqual([bobCtx._id]);
        });
    });

    describe('item reference relinking — in-batch dedupe + precondition ordering', () => {
        it('dedupes the same id repeated in peopleIds — creates one mirror, points both slots at it', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const alicePerson = makePerson(alice.userId, { name: 'Dup', email: 'dup@example.com' });
            await peopleDAO.insertOne(alicePerson);
            // Same id appears twice — Promise.all would race two creates; sequential + cache returns the same new id.
            const item = makeItem(alice.userId, { status: 'nextAction', peopleIds: [alicePerson._id, alicePerson._id] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const bobPeople = await peopleDAO.findArray({ user: bob.userId });
            expect(bobPeople).toHaveLength(1);
            const [bobDup] = bobPeople;
            if (!bobDup) throw new Error('expected one mirror person');
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.peopleIds).toEqual([bobDup._id, bobDup._id]);
        });

        it('dedupes by email across two different source ids that share an email — single mirror, both refs point at it', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            // Two separate alice persons with the same email. After relink, bob should end up
            // with ONE mirror person, not two.
            const alice1 = makePerson(alice.userId, { name: 'Sam1', email: 'shared@example.com' });
            const alice2 = makePerson(alice.userId, { name: 'Sam2', email: 'shared@example.com' });
            await Promise.all([peopleDAO.insertOne(alice1), peopleDAO.insertOne(alice2)]);
            const item = makeItem(alice.userId, { status: 'nextAction', peopleIds: [alice1._id, alice2._id] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const bobPeople = await peopleDAO.findArray({ user: bob.userId });
            expect(bobPeople).toHaveLength(1);
            const [bobShared] = bobPeople;
            if (!bobShared) throw new Error('expected one mirror person from shared email');
            expect(bobShared.email).toBe('shared@example.com');
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            // Both slots point at the same single mirror.
            expect(moved?.peopleIds).toEqual([bobShared._id, bobShared._id]);
        });

        it('dedupes workContextIds by name across two distinct source ids', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const ctx1 = makeWorkContext(alice.userId, { name: 'shared-name' });
            const ctx2 = makeWorkContext(alice.userId, { name: 'shared-name' });
            await Promise.all([workContextsDAO.insertOne(ctx1), workContextsDAO.insertOne(ctx2)]);
            const item = makeItem(alice.userId, { status: 'nextAction', workContextIds: [ctx1._id, ctx2._id] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const bobContexts = await workContextsDAO.findArray({ user: bob.userId });
            expect(bobContexts).toHaveLength(1);
        });

        it('rejects calendar-linked item missing targetCalendar BEFORE creating any mirror entities', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            // Seed an alice person so we can detect any bug where mirrors are created during the
            // doomed reassign — pins the precondition-before-relink ordering.
            const alicePerson = makePerson(alice.userId, { name: 'Cal', email: 'cal@example.com' });
            await peopleDAO.insertOne(alicePerson);
            const item = makeItem(alice.userId, {
                status: 'calendar',
                calendarEventId: 'gcal-evt-x',
                calendarIntegrationId: 'int-x',
                calendarSyncConfigId: 'cfg-x',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(400);
            // Pinned guarantee: no mirror entities exist under bob.
            expect(await peopleDAO.findArray({ user: bob.userId })).toHaveLength(0);
            expect(await workContextsDAO.findArray({ user: bob.userId })).toHaveLength(0);
        });
    });

    describe('routine reference relinking', () => {
        it('relinks template.peopleIds + template.workContextIds when reassigning a routine', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const alicePerson = makePerson(alice.userId, { name: 'Pat', email: 'pat@example.com' });
            const aliceCtx = makeWorkContext(alice.userId, { name: 'at desk' });
            await Promise.all([peopleDAO.insertOne(alicePerson), workContextsDAO.insertOne(aliceCtx)]);
            const routine = makeRoutine(alice.userId, {
                template: { peopleIds: [alicePerson._id], workContextIds: [aliceCtx._id] },
            });
            await routinesDAO.insertOne(routine);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'routine', entityId: routine._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            // Bob ends up with mirror person + mirror context.
            const bobPeople = await peopleDAO.findArray({ user: bob.userId });
            const bobContexts = await workContextsDAO.findArray({ user: bob.userId });
            expect(bobPeople).toHaveLength(1);
            expect(bobContexts).toHaveLength(1);
            const [bobPat] = bobPeople;
            const [bobCtx] = bobContexts;
            if (!bobPat || !bobCtx) throw new Error('expected mirror records under bob');
            // Routine template under bob points at the new ids.
            const movedRoutine = await routinesDAO.findByOwnerAndId(routine._id, bob.userId);
            expect(movedRoutine?.template.peopleIds).toEqual([bobPat._id]);
            expect(movedRoutine?.template.workContextIds).toEqual([bobCtx._id]);
            // Alice still owns hers.
            expect(await peopleDAO.findByOwnerAndId(alicePerson._id, alice.userId)).not.toBeNull();
            expect(await workContextsDAO.findByOwnerAndId(aliceCtx._id, alice.userId)).not.toBeNull();
        });

        it('dedupes the routine template.peopleIds + template.workContextIds (same name twice) to a single mirror each', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const aliceP1 = makePerson(alice.userId, { name: 'Pat', email: 'pat@example.com' });
            const aliceP2 = makePerson(alice.userId, { name: 'Pat2', email: 'pat@example.com' });
            const aliceCtx1 = makeWorkContext(alice.userId, { name: 'at desk' });
            const aliceCtx2 = makeWorkContext(alice.userId, { name: 'at desk' });
            await Promise.all([
                peopleDAO.insertOne(aliceP1),
                peopleDAO.insertOne(aliceP2),
                workContextsDAO.insertOne(aliceCtx1),
                workContextsDAO.insertOne(aliceCtx2),
            ]);
            const routine = makeRoutine(alice.userId, {
                template: { peopleIds: [aliceP1._id, aliceP2._id], workContextIds: [aliceCtx1._id, aliceCtx2._id] },
            });
            await routinesDAO.insertOne(routine);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'routine', entityId: routine._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            // Single mirror for each kind — same email dedupes people, same name dedupes contexts.
            expect(await peopleDAO.findArray({ user: bob.userId })).toHaveLength(1);
            expect(await workContextsDAO.findArray({ user: bob.userId })).toHaveLength(1);
        });
    });

    describe('item reference relinking — cross-field cache sharing', () => {
        it('waitingForPersonId and peopleIds[0] pointing at the same source person resolve to one mirror', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const alicePerson = makePerson(alice.userId, { name: 'Wen', email: 'wen@example.com' });
            await peopleDAO.insertOne(alicePerson);
            // waitingForPersonId is a separate code path from peopleIds[] but shares the same
            // relink cache via buildRelinkContext — pins that no duplicate mirror is created when
            // the same id appears in both fields.
            const item = makeItem(alice.userId, {
                status: 'waitingFor',
                waitingForPersonId: alicePerson._id,
                peopleIds: [alicePerson._id],
            });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const bobPeople = await peopleDAO.findArray({ user: bob.userId });
            expect(bobPeople).toHaveLength(1);
            const [bobWen] = bobPeople;
            if (!bobWen) throw new Error('expected one mirror person');
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.peopleIds).toEqual([bobWen._id]);
            expect(moved?.waitingForPersonId).toBe(bobWen._id);
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
                // Stale GCal-owned deep link pointing at the source event — the move deletes that
                // event, so the moved item must carry the NEW event's htmlLink instead.
                htmlLink: 'https://calendar.google.com/calendar/event?eid=source-stale',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            await itemsDAO.insertOne(item);

            // Mock the provider so create returns a new event id and delete is a no-op.
            const createEvent = vi.fn().mockResolvedValue({ eventId: 'gcal-evt-new', htmlLink: 'https://calendar.google.com/calendar/event?eid=target-new' });
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
            // Item now under bob with the new event id, and the stale source htmlLink replaced by
            // the target event's link.
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.calendarEventId).toBe('gcal-evt-new');
            expect(moved?.calendarIntegrationId).toBe('int-b');
            expect(moved?.htmlLink).toBe('https://calendar.google.com/calendar/event?eid=target-new');
            buildSpy.mockRestore();
        });

        // Regression: notifyChange's GCal pushback leg must NOT fire on either reassign leg —
        // the create-on-target was already pushed inline (via createEvent above), and the source
        // delete already nuked the event (via deleteEvent). Without the suppressGCalPushback knob
        // threaded by persistItemMove, the create-leg fan-out would re-push the moved item to
        // Bob's GCal via maybePushToGCal → pushExistingItemToGCal → provider.updateEvent —
        // producing a duplicate write per cross-account move.
        it('does NOT call provider.updateEvent during reassign — suppressGCalPushback prevents the redundant fan-out push', async () => {
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
                calendarEventId: 'gcal-evt-suppress',
                calendarIntegrationId: 'int-a',
                calendarSyncConfigId: 'cfg-a',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            await itemsDAO.insertOne(item);

            const createEvent = vi.fn().mockResolvedValue({ eventId: 'gcal-evt-new' });
            const deleteEvent = vi.fn().mockResolvedValue(undefined);
            const updateEvent = vi.fn().mockResolvedValue(undefined);
            const stubProvider = { createEvent, deleteEvent, updateEvent, getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') };
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
            // Inline GCal moves still fired (create on target, delete on source). The fan-out's
            // would-be redundant updateEvent must NOT fire — that's the load-bearing assertion.
            expect(createEvent).toHaveBeenCalledTimes(1);
            expect(deleteEvent).toHaveBeenCalledTimes(1);
            expect(updateEvent).not.toHaveBeenCalled();
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
            // It also carries a stale htmlLink; the target create below reports none, so the moved
            // item must NOT keep pointing at the (deleted) source event.
            const item = makeItem(alice.userId, {
                status: 'calendar',
                calendarEventId: 'gcal-evt-orig',
                calendarIntegrationId: 'int-a-stale',
                calendarSyncConfigId: 'cfg-a-stale',
                htmlLink: 'https://calendar.google.com/calendar/event?eid=source-stale',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            await itemsDAO.insertOne(item);

            const createEvent = vi.fn().mockResolvedValue({ eventId: 'gcal-evt-new' });
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
            // Create reported no htmlLink → the stale source link is dropped, not carried over.
            expect(moved?.htmlLink).toBeUndefined();
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

            const createEvent = vi.fn().mockResolvedValue({ eventId: 'gcal-evt-new' });
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

            const createEvent = vi.fn().mockResolvedValue({ eventId: 'gcal-evt-new' });
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

        it('applies nextAction patch fields (workContextIds, peopleIds, energy, time, urgent, focus, expectedBy, ignoreBefore)', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { status: 'nextAction' });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            // `waitingForPersonId` is gated to status='waitingFor' by the status×field matrix —
            // covered separately in the waitingFor edit-patch test below to keep this case clean.
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
            });
        });

        it('applies waitingForPersonId on a waitingFor item (status×field matrix isolation)', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const item = makeItem(alice.userId, { status: 'waitingFor' });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editPatch: { waitingForPersonId: 'p-2' },
            });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved?.waitingForPersonId).toBe('p-2');
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

            const createEvent = vi.fn().mockResolvedValue({ eventId: 'gcal-evt-new' });
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
            // `urgent` is a nextAction-status field — use status='nextAction' so the snapshot
            // satisfies the status×field matrix that strict-mode validation enforces.
            const item = makeItem(alice.userId, { status: 'nextAction', title: 'kept', notes: 'also kept', urgent: true });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved).toMatchObject({ title: 'kept', notes: 'also kept', urgent: true });
        });

        // allDay editPatch round-trip is covered by a focused unit test on `applyItemEditPatch` in
        // `applyItemEditPatch.allday.test.ts` — that test isolates the patch shape without needing
        // the full calendar-reassign integration scaffolding (real integration + sync-config rows on
        // both alice and bob plus a provider mock), which would dwarf the assertion it's making.
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

        it('source-side generated items are not transplanted when editRoutinePatch is provided — Bob starts fresh', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId);
            await routinesDAO.insertOne(routine);
            // A generated `nextAction` item. Reassign always deletes the source-side routine (even
            // with editRoutinePatch — the patch only affects the target-side create), which fires
            // pushRoutineDeletion's cascade: the item is trashed under Alice, not transplanted to Bob.
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
            // Source-side generated next-action item is trashed by the routine-delete cascade
            // (fire-and-forget — poll briefly for it to land).
            await waitFor(async () => (await itemsDAO.findByOwnerAndId(generated._id!, alice.userId))?.status === 'trash');
            const stillAlice = await itemsDAO.findByOwnerAndId(generated._id!, alice.userId);
            expect(stillAlice?.status).toBe('trash');
            // Bob has no historical generated items.
            expect(await itemsDAO.findByOwnerAndId(generated._id!, bob.userId)).toBeNull();
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

        // Regression: applyRoutineEditPatch spreads the source routine into `next` first, so a
        // routineType switch away from nextAction must explicitly CLEAR an inherited
        // recurrenceAnchor — otherwise the stale value rides along and fails RoutineSnapshotSchema's
        // superRefine on the target-side create, breaking the reassign entirely.
        it('switching routineType to calendar clears a stale recurrenceAnchor instead of failing the reassign', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId, { routineType: 'nextAction', rrule: 'FREQ=MONTHLY;BYMONTHDAY=8', recurrenceAnchor: 'fixed' });
            await routinesDAO.insertOne(routine);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'routine',
                entityId: routine._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editRoutinePatch: { routineType: 'calendar', calendarItemTemplate: { timeOfDay: '09:00', duration: 30 } },
            });

            expect(res.status).toBe(200);
            const moved = await routinesDAO.findByOwnerAndId(routine._id, bob.userId);
            expect(moved?.routineType).toBe('calendar');
            expect(moved?.recurrenceAnchor).toBeUndefined();
        });

        // Same spread-inheritance hazard as recurrenceAnchor, for the GCal master-mirror fields:
        // a calendar→nextAction switch must shed organizer/attendees/… or the target-side create
        // fails RoutineSnapshotSchema's superRefine on the inherited fields.
        it('switching routineType to nextAction sheds inherited GCal master-mirror fields', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const routine = makeRoutine(alice.userId, {
                routineType: 'calendar',
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
                organizer: { email: 'boss@example.com' },
                attendees: [{ email: 'boss@example.com', responseStatus: 'accepted' }],
            });
            await routinesDAO.insertOne(routine);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'routine',
                entityId: routine._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                editRoutinePatch: { routineType: 'nextAction' },
            });

            expect(res.status).toBe(200);
            const moved = await routinesDAO.findByOwnerAndId(routine._id, bob.userId);
            expect(moved?.routineType).toBe('nextAction');
            expect(moved?.organizer).toBeUndefined();
            expect(moved?.attendees).toBeUndefined();
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

/** GCal pushback (including the routine-delete item cascade) is fire-and-forget under the hood —
 *  poll briefly for its effect to land rather than racing the assertion against it. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('waitFor: predicate never became true');
}
