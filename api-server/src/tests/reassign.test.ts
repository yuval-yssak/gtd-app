/** biome-ignore-all lint/style/noNonNullAssertion: tests assert preconditions before using ! */
import { createHmac } from 'node:crypto';
import { generateId } from 'better-auth';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';
import { buildDeterministicGCalId } from '../calendarProviders/GoogleCalendarProvider.js';
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
        db.collection('entityMoves').deleteMany({}),
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
            // Cascade fired: GCal master hard-deleted, source calendar items trashed. waitFor because
            // notifyChange's pushback leg (which drives the cascade) is fire-and-forget.
            await vi.waitFor(() => expect(deleteRecurringEvent).toHaveBeenCalledWith('gcal-master-routine', 'primary'));
            await vi.waitFor(async () => expect((await itemsDAO.findByOwnerAndId(generated._id!, alice.userId))?.status).toBe('trash'));
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
            // status='calendar' rows, by design (matrix A8). waitFor because the cascade rides the
            // fire-and-forget pushback leg of the delete-leg op's notifyChange.
            await vi.waitFor(async () => expect((await itemsDAO.findByOwnerAndId(item1._id!, alice.userId))?.status).toBe('trash'));
            const aliceItem1 = await itemsDAO.findByOwnerAndId(item1._id!, alice.userId);
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
            // "Today" is the LOCAL calendar date — routineItemGeneration floors occurrences on
            // dayjs().format('YYYY-MM-DD'); asserting dayjs.utc() flaked nightly between local
            // midnight and UTC midnight (expected the previous UTC day).
            expect(seeded.expectedBy).toBe(dayjs().format('YYYY-MM-DD'));
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

        it('mirrors the archived flag — an archived person/context must not resurrect as active under toUserId', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const parkedPerson = makePerson(alice.userId, { name: 'Retired Rita', archived: true });
            await peopleDAO.insertOne(parkedPerson);
            const parkedContext = makeWorkContext(alice.userId, { name: '@fax machine', archived: true });
            await workContextsDAO.insertOne(parkedContext);
            const item = makeItem(alice.userId, { status: 'nextAction', peopleIds: [parkedPerson._id], workContextIds: [parkedContext._id] });
            await itemsDAO.insertOne(item);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(200);
            const [bobRita] = await peopleDAO.findArray({ user: bob.userId });
            if (!bobRita) throw new Error('expected one mirror person under bob');
            expect(bobRita.archived).toBe(true);
            const [bobFax] = await workContextsDAO.findArray({ user: bob.userId });
            if (!bobFax) throw new Error('expected one mirror context under bob');
            expect(bobFax.archived).toBe(true);
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

    describe('calendar-linked item with GCal (op-driven)', () => {
        /** Seeds alice + bob sessions, one integration + default sync config each, and the shared cookie. */
        async function seedTwoCalendarUsers() {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const now = dayjs().toISOString();
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-a',
                user: alice.userId,
                provider: 'google',
                accessToken: 'at-a',
                refreshToken: 'rt-a',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: now,
                updatedTs: now,
            });
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-b',
                user: bob.userId,
                provider: 'google',
                accessToken: 'at-b',
                refreshToken: 'rt-b',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: now,
                updatedTs: now,
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-a',
                integrationId: 'int-a',
                user: alice.userId,
                calendarId: 'alice-primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: now,
                updatedTs: now,
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-b',
                integrationId: 'int-b',
                user: bob.userId,
                calendarId: 'bob-primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: now,
                updatedTs: now,
            });
            return { alice, bob, cookie: buildMultiSessionCookieHeader(alice, [alice, bob]) };
        }

        /** Stubs buildCalendarProvider with spies for the calls the op-driven pushback makes. */
        function stubGCalProvider() {
            const createEvent = vi.fn().mockResolvedValue({ eventId: 'gcal-evt-new', htmlLink: 'https://calendar.google.com/calendar/event?eid=target-new' });
            const deleteEvent = vi.fn().mockResolvedValue(undefined);
            const updateEvent = vi.fn().mockResolvedValue(undefined);
            const stub = { createEvent, deleteEvent, updateEvent, getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') };
            vi.spyOn(buildCalendarProviderModule, 'buildCalendarProvider').mockImplementation(() => stub as never);
            return { createEvent, deleteEvent, updateEvent };
        }

        function makeLinkedItem(userId: string) {
            return makeItem(userId, {
                status: 'calendar',
                calendarEventId: 'gcal-evt-original',
                calendarIntegrationId: 'int-a',
                calendarSyncConfigId: 'cfg-a',
                htmlLink: 'https://calendar.google.com/calendar/event?eid=source-stale',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
        }

        it('flips ownership atomically; GCal side effects are op-driven — create on target calendar (deterministic id) + delete on source, both after the flip', async () => {
            const { alice, bob, cookie } = await seedTwoCalendarUsers();
            const item = makeLinkedItem(alice.userId);
            await itemsDAO.insertOne(item);
            const { createEvent, deleteEvent } = stubGCalProvider();

            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
            });

            expect(res.status).toBe(200);
            expect(((await res.json()) as { alreadyMoved?: boolean }).alreadyMoved).toBeUndefined();
            // The flip is synchronous with the response: the row already belongs to bob even if
            // the (async) GCal pushes haven't fired yet.
            expect(await itemsDAO.findByOwnerAndId(item._id!, bob.userId)).not.toBeNull();
            expect(await itemsDAO.findByOwnerAndId(item._id!, alice.userId)).toBeNull();

            // Both op-log legs exist: delete under alice carrying the PRE-move snapshot (drives the
            // async source-event deletion), create under bob with the source link stripped and the
            // target calendar stamped (drives the async target-event creation).
            const [deleteOp] = await operationsDAO.findArray({ user: alice.userId, entityId: item._id, opType: 'delete' });
            expect((deleteOp?.snapshot as ItemInterface | null)?.calendarEventId).toBe('gcal-evt-original');
            const [createOp] = await operationsDAO.findArray({ user: bob.userId, entityId: item._id, opType: 'create' });
            const createSnapshot = createOp?.snapshot as ItemInterface | null;
            expect(createSnapshot?.calendarEventId).toBeUndefined();
            expect(createSnapshot?.calendarIntegrationId).toBe('int-b');
            expect(createSnapshot?.calendarSyncConfigId).toBe('cfg-b');

            // Async pushback: create on bob's chosen calendar with the deterministic id (retries
            // idempotent via 409-relink), delete of the original event on alice's calendar.
            await vi.waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
            const [createCalendarId, , , createOpts] = createEvent.mock.calls[0]!;
            expect(createCalendarId).toBe('bob-primary');
            expect(createOpts).toMatchObject({ id: buildDeterministicGCalId(item._id!, 'int-b') });
            await vi.waitFor(() => expect(deleteEvent).toHaveBeenCalledWith('alice-primary', 'gcal-evt-original'));

            // The pushback linked the moved item to the fresh target event.
            await vi.waitFor(async () => {
                const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
                expect(moved?.calendarEventId).toBe('gcal-evt-new');
                expect(moved?.calendarIntegrationId).toBe('int-b');
                expect(moved?.htmlLink).toBe('https://calendar.google.com/calendar/event?eid=target-new');
            });
        });

        it('retry of a completed move returns alreadyMoved and never creates a second GCal event', async () => {
            const { alice, bob, cookie } = await seedTwoCalendarUsers();
            const item = makeLinkedItem(alice.userId);
            await itemsDAO.insertOne(item);
            const { createEvent, updateEvent } = stubGCalProvider();
            const body = {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
            };

            const first = await postReassign(cookie, body);
            expect(first.status).toBe(200);
            await vi.waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
            await vi.waitFor(async () => expect((await itemsDAO.findByOwnerAndId(item._id!, bob.userId))?.calendarEventId).toBe('gcal-evt-new'));

            const retry = await postReassign(cookie, body);
            expect(retry.status).toBe(200);
            expect(((await retry.json()) as { alreadyMoved?: boolean }).alreadyMoved).toBe(true);
            // The re-emitted create leg carries the CURRENT (already-linked) row, so pushback takes
            // the update path — never a second create.
            await vi.waitFor(() => expect(updateEvent).toHaveBeenCalled());
            expect(createEvent).toHaveBeenCalledTimes(1);
            expect(await itemsDAO.findByOwnerAndId(item._id!, bob.userId)).not.toBeNull();
            expect(await itemsDAO.findByOwnerAndId(item._id!, alice.userId)).toBeNull();
        });

        it('rejects with 400 and zero writes when targetCalendar does not resolve under toUserId', async () => {
            const { alice, bob, cookie } = await seedTwoCalendarUsers();
            const item = makeLinkedItem(alice.userId);
            await itemsDAO.insertOne(item);
            const { createEvent, deleteEvent } = stubGCalProvider();

            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                // cfg-a belongs to alice, so it must not validate under bob.
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-a' },
            });

            expect(res.status).toBe(400);
            expect(await itemsDAO.findByOwnerAndId(item._id!, alice.userId)).not.toBeNull();
            expect(await itemsDAO.findByOwnerAndId(item._id!, bob.userId)).toBeNull();
            expect(await operationsDAO.findArray({ entityId: item._id })).toHaveLength(0);
            expect(createEvent).not.toHaveBeenCalled();
            expect(deleteEvent).not.toHaveBeenCalled();
        });

        it('heals a crash between the flip and the op-log inserts: entity lands under toUser; retry re-derives both log legs', async () => {
            const { alice, bob, cookie } = await seedTwoCalendarUsers();
            const item = makeLinkedItem(alice.userId);
            await itemsDAO.insertOne(item);
            stubGCalProvider();
            const body = {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
            };

            // Simulate a crash right after the atomic flip: the first op-log insert throws.
            const insertSpy = vi.spyOn(operationsDAO, 'insertOne').mockRejectedValueOnce(new Error('simulated crash'));
            const crashed = await postReassign(cookie, body);
            expect(crashed.status).toBe(500);
            // Flip-first ordering: the server's ground truth is already correct …
            expect(await itemsDAO.findByOwnerAndId(item._id!, bob.userId)).not.toBeNull();
            expect(await itemsDAO.findByOwnerAndId(item._id!, alice.userId)).toBeNull();
            // … but no op-log legs were written.
            expect(await operationsDAO.findArray({ entityId: item._id })).toHaveLength(0);

            // Retry heals: alreadyMoved + both legs re-derived (delete leg snapshot:null, create leg = current row).
            const retry = await postReassign(cookie, body);
            expect(retry.status).toBe(200);
            expect(((await retry.json()) as { alreadyMoved?: boolean }).alreadyMoved).toBe(true);
            const [healedDelete] = await operationsDAO.findArray({ user: alice.userId, entityId: item._id, opType: 'delete' });
            if (!healedDelete) throw new Error('expected a healed delete op');
            expect(healedDelete.snapshot).toBeNull();
            const [healedCreate] = await operationsDAO.findArray({ user: bob.userId, entityId: item._id, opType: 'create' });
            expect((healedCreate?.snapshot as ItemInterface | null)?.user).toBe(bob.userId);
            insertSpy.mockRestore();
        });

        it('two concurrent reassigns of the same entity resolve as one move + one alreadyMoved', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const item = makeItem(alice.userId, { title: 'Race me' });
            await itemsDAO.insertOne(item);
            const body = { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId };

            const [res1, res2] = await Promise.all([postReassign(cookie, body), postReassign(cookie, body)]);
            expect(res1.status).toBe(200);
            expect(res2.status).toBe(200);
            const bodies = [(await res1.json()) as { alreadyMoved?: boolean }, (await res2.json()) as { alreadyMoved?: boolean }];
            expect(bodies.filter((b) => b.alreadyMoved).length).toBe(1);
            expect(await itemsDAO.findByOwnerAndId(item._id!, bob.userId)).not.toBeNull();
            expect(await itemsDAO.findByOwnerAndId(item._id!, alice.userId)).toBeNull();
            // Pin the accepted op-log shape: the winner writes one delete + one create leg, the
            // alreadyMoved loser re-emits both — four legs total, two per user. Re-emission is an
            // accepted property (snapshot ops are LWW-idempotent on clients); this assertion is
            // here so a future change that turns 4 into N is a deliberate decision, not drift.
            const legs = await operationsDAO.findArray({ entityId: item._id });
            const shape = legs.map((op) => `${op.user === alice.userId ? 'alice' : 'bob'}:${op.opType}`).sort();
            expect(shape).toEqual(['alice:delete', 'alice:delete', 'bob:create', 'bob:create']);
        });
    });

    describe('already-moved provenance gate (tenant isolation)', () => {
        // Without the move receipt, "not under fromUserId but present under toUserId" is equally
        // true of an entity toUserId has ALWAYS owned — and answering alreadyMoved there would
        // forge op-log legs on both users and republish the target's private snapshot.
        it('item that has always belonged to toUserId → 404, zero ops written for either user', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const item = makeItem(bob.userId, { title: "bob's private item" });
            await itemsDAO.insertOne(item);

            const res = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(404);
            expect(await operationsDAO.findArray({ entityId: item._id })).toHaveLength(0);
            expect((await itemsDAO.findByOwnerAndId(item._id!, bob.userId))?.title).toBe("bob's private item");
        });

        it('routine that has always belonged to toUserId → 404, zero ops written for either user', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const routine = makeRoutine(bob.userId, { title: "bob's private routine" });
            await routinesDAO.insertOne(routine);

            const res = await postReassign(cookie, { entityType: 'routine', entityId: routine._id, fromUserId: alice.userId, toUserId: bob.userId });

            expect(res.status).toBe(404);
            expect(await operationsDAO.findArray({ entityId: routine._id })).toHaveLength(0);
            expect((await routinesDAO.findByOwnerAndId(routine._id, bob.userId))?.title).toBe("bob's private routine");
        });
    });

    describe('push-failure surfacing (surfacePushFailure)', () => {
        // The op-driven create's failure is categorized so the SyncIssuesPanel offers the RIGHT
        // remediation — a dead credential must say "Reconnect", never an endless Retry.
        async function moveWithFailingCreate(createError: Error) {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const now = dayjs().toISOString();
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-b',
                user: bob.userId,
                provider: 'google',
                accessToken: 'at-b',
                refreshToken: 'rt-b',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: now,
                updatedTs: now,
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-b',
                integrationId: 'int-b',
                user: bob.userId,
                calendarId: 'bob-primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: now,
                updatedTs: now,
            });
            const item = makeItem(alice.userId, {
                status: 'calendar',
                timeStart: '2030-01-01T10:00:00Z',
                timeEnd: '2030-01-01T11:00:00Z',
            });
            await itemsDAO.insertOne(item);
            const createEvent = vi.fn().mockRejectedValue(createError);
            const stub = { createEvent, deleteEvent: vi.fn(), updateEvent: vi.fn(), getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') };
            vi.spyOn(buildCalendarProviderModule, 'buildCalendarProvider').mockImplementation(() => stub as never);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'item',
                entityId: item._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
            });
            expect(res.status).toBe(200);
            return { itemId: item._id, bobUserId: bob.userId };
        }

        it('invalid_grant on the target create marks the create-leg op syncFailed with scope_missing (Reconnect, not Retry)', async () => {
            const { itemId, bobUserId } = await moveWithFailingCreate(new Error('invalid_grant'));
            await vi.waitFor(async () => {
                const [createOp] = await operationsDAO.findArray({ user: bobUserId, entityId: itemId, opType: 'create' });
                expect(createOp?.syncFailed).toBe(true);
                expect(createOp?.failureReason).toBe('scope_missing');
            });
        });

        it('an unknown/network error on the target create marks the create-leg op transient_exhausted (retryable)', async () => {
            const { itemId, bobUserId } = await moveWithFailingCreate(new Error('socket hang up'));
            await vi.waitFor(async () => {
                const [createOp] = await operationsDAO.findArray({ user: bobUserId, entityId: itemId, opType: 'create' });
                expect(createOp?.syncFailed).toBe(true);
                expect(createOp?.failureReason).toBe('transient_exhausted');
            });
        });
    });

    describe('post-move source-user ops are quarantined (entity_missing)', () => {
        it('a queued source-user update replayed after the move is recorded but not applied, excluded from /sync/pull, and non-retryable in /sync/issues', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const item = makeItem(alice.userId, { title: 'Moves away' });
            await itemsDAO.insertOne(item);

            const moveRes = await postReassign(cookie, { entityType: 'item', entityId: item._id, fromUserId: alice.userId, toUserId: bob.userId });
            expect(moveRes.status).toBe(200);

            // An alice device replays a stale offline edit for the (now-moved) item.
            const aliceCookie = buildMultiSessionCookieHeader(alice, [alice]);
            const staleTs = dayjs().add(1, 'second').toISOString();
            const pushRes = await app.fetch(
                new Request('http://localhost:4000/sync/push', {
                    method: 'POST',
                    headers: { Cookie: aliceCookie, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        deviceId: 'dev-alice',
                        ops: [
                            {
                                entityType: 'item',
                                entityId: item._id,
                                opType: 'update',
                                queuedAt: staleTs,
                                snapshot: {
                                    _id: item._id,
                                    userId: alice.userId,
                                    status: 'inbox',
                                    title: 'stale offline edit',
                                    createdTs: item.createdTs,
                                    updatedTs: staleTs,
                                },
                            },
                        ],
                    }),
                }),
            );
            expect(pushRes.status).toBe(200);

            // Not applied: the entity is NOT resurrected under alice and bob's copy is untouched.
            expect(await itemsDAO.findByOwnerAndId(item._id!, alice.userId)).toBeNull();
            expect((await itemsDAO.findByOwnerAndId(item._id!, bob.userId))?.title).toBe('Moves away');

            // Recorded + quarantined.
            const [quarantined] = await operationsDAO.findArray({ user: alice.userId, entityId: item._id, opType: 'update' });
            if (!quarantined) throw new Error('expected the quarantined op to be recorded');
            expect(quarantined.notApplied).toBe(true);
            expect(quarantined.syncFailed).toBe(true);
            expect(quarantined.failureReason).toBe('entity_missing');

            // Excluded from pull — other alice devices never replay it (no client-side resurrection).
            const pullRes = await app.fetch(
                new Request(`http://localhost:4000/sync/pull?since=${encodeURIComponent(dayjs(0).toISOString())}`, { headers: { Cookie: aliceCookie } }),
            );
            const pulled = (await pullRes.json()) as { ops: Array<{ _id: string }> };
            expect(pulled.ops.some((op) => op._id === quarantined._id)).toBe(false);

            // Surfaced in /sync/issues as non-retryable (Dismiss-only).
            const issuesRes = await app.fetch(new Request('http://localhost:4000/sync/issues', { headers: { Cookie: aliceCookie } }));
            const { issues } = (await issuesRes.json()) as { issues: Array<{ _id: string; failureReason: string; retryable: boolean }> };
            const issue = issues.find((i) => i._id === quarantined._id);
            if (!issue) throw new Error('expected the quarantined op in /sync/issues');
            expect(issue.failureReason).toBe('entity_missing');
            expect(issue.retryable).toBe(false);
        });
    });

    describe('routine with targetCalendar (op-driven series create)', () => {
        it('stamps the target link on the moved routine, retries idempotently, and creates the series asynchronously while the source master is deleted', async () => {
            const alice = await seedUserSession('alice@example.com');
            const bob = await seedUserSession('bob@example.com');
            const now = dayjs().toISOString();
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-a',
                user: alice.userId,
                provider: 'google',
                accessToken: 'at-a',
                refreshToken: 'rt-a',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: now,
                updatedTs: now,
            });
            await calendarIntegrationsDAO.upsertEncrypted({
                _id: 'int-b',
                user: bob.userId,
                provider: 'google',
                accessToken: 'at-b',
                refreshToken: 'rt-b',
                tokenExpiry: dayjs().add(1, 'hour').toISOString(),
                createdTs: now,
                updatedTs: now,
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-a',
                integrationId: 'int-a',
                user: alice.userId,
                calendarId: 'alice-primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: now,
                updatedTs: now,
            });
            await calendarSyncConfigsDAO.insertOne({
                _id: 'cfg-b',
                integrationId: 'int-b',
                user: bob.userId,
                calendarId: 'bob-primary',
                isDefault: true,
                enabled: true,
                timeZone: 'UTC',
                createdTs: now,
                updatedTs: now,
            });
            const routine = makeRoutine(alice.userId, {
                routineType: 'calendar',
                calendarEventId: 'gcal-master-orig',
                calendarIntegrationId: 'int-a',
                calendarSyncConfigId: 'cfg-a',
                calendarItemTemplate: { timeOfDay: '10:00', duration: 30 },
            });
            await routinesDAO.insertOne(routine);

            const createRecurringEvent = vi.fn().mockResolvedValue('gcal-master-new');
            const deleteRecurringEvent = vi.fn().mockResolvedValue(undefined);
            const stub = {
                createRecurringEvent,
                deleteRecurringEvent,
                createEvent: vi.fn(),
                deleteEvent: vi.fn(),
                updateEvent: vi.fn(),
                getCalendarTimeZone: vi.fn().mockResolvedValue('UTC'),
            };
            vi.spyOn(buildCalendarProviderModule, 'buildCalendarProvider').mockImplementation(() => stub as never);

            const cookie = buildMultiSessionCookieHeader(alice, [alice, bob]);
            const res = await postReassign(cookie, {
                entityType: 'routine',
                entityId: routine._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
            });

            expect(res.status).toBe(200);
            // Stamped link (no calendarEventId yet) — the create-leg op drives the series create.
            const moved = await routinesDAO.findByOwnerAndId(routine._id, bob.userId);
            expect(moved?.calendarIntegrationId).toBe('int-b');
            expect(moved?.calendarSyncConfigId).toBe('cfg-b');

            // Async legs: fresh series on bob's calendar (deterministic id), source master deleted.
            await vi.waitFor(() => expect(createRecurringEvent).toHaveBeenCalledTimes(1));
            const [, createCalendarId, , createOpts] = createRecurringEvent.mock.calls[0]!;
            expect(createCalendarId).toBe('bob-primary');
            expect(createOpts).toMatchObject({ id: buildDeterministicGCalId(routine._id, 'int-b') });
            await vi.waitFor(() => expect(deleteRecurringEvent).toHaveBeenCalledWith('gcal-master-orig', 'alice-primary'));
            await vi.waitFor(async () => expect((await routinesDAO.findByOwnerAndId(routine._id, bob.userId))?.calendarEventId).toBe('gcal-master-new'));

            // Retry: alreadyMoved, and no second series create for the (now-linked) routine.
            const retry = await postReassign(cookie, {
                entityType: 'routine',
                entityId: routine._id,
                fromUserId: alice.userId,
                toUserId: bob.userId,
                targetCalendar: { integrationId: 'int-b', syncConfigId: 'cfg-b' },
            });
            expect(retry.status).toBe(200);
            expect(((await retry.json()) as { alreadyMoved?: boolean }).alreadyMoved).toBe(true);
            // Give the retry's fan-out a chance to (incorrectly) fire a second create.
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(createRecurringEvent).toHaveBeenCalledTimes(1);
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
            // Persisted snapshot reflects the edits + target calendar refs synchronously with the flip.
            const moved = await itemsDAO.findByOwnerAndId(item._id!, bob.userId);
            expect(moved).toMatchObject({
                title: 'New title',
                notes: 'new notes',
                calendarIntegrationId: 'int-b',
                calendarSyncConfigId: 'cfg-b',
            });
            // The async op-driven createEvent receives the patched title + times so the new GCal
            // event reflects user edits.
            await vi.waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
            const [, evt] = createEvent.mock.calls[0]!;
            expect(evt).toMatchObject({ title: 'New title', timeStart: '2030-01-01T12:00:00Z', timeEnd: '2030-01-01T13:30:00Z' });
            await vi.waitFor(async () => expect((await itemsDAO.findByOwnerAndId(item._id!, bob.userId))?.calendarEventId).toBe('gcal-evt-new'));
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
