/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts presence before using ! */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { maintenanceRoutes } from '../routes/maintenance.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/maintenance', maintenanceRoutes);

// ─── Lifecycle ──────────────────────────────────────────────────────────────

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
        db.collection('operations').deleteMany({}),
        db.collection('deviceSyncState').deleteMany({}),
        db.collection('pushSubscriptions').deleteMany({}),
        db.collection('deviceUsers').deleteMany({}),
        db.collection('items').deleteMany({}),
        db.collection('routines').deleteMany({}),
    ]);
    vi.restoreAllMocks();
});

// ─── Local helpers ──────────────────────────────────────────────────────────

async function loginAsAlice(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    return sessionCookie!;
}

async function loginAsBob(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'github', { email: 'bob@example.com', login: 'bob-gh' });
    return sessionCookie!;
}

async function getUserId(sessionCookie: string): Promise<string> {
    const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
}

/** Inserts an operation row directly with an explicit (ts, _id) so floor control is deterministic. */
async function seedOp(opts: { id: string; userId: string; entityId: string; ts: string; opType?: string; snapshot: Record<string, unknown> | null }) {
    await db.collection('operations').insertOne({
        _id: opts.id,
        user: opts.userId,
        deviceId: 'seed-dev',
        ts: opts.ts,
        entityType: 'item',
        entityId: opts.entityId,
        opType: opts.opType ?? 'update',
        snapshot: opts.snapshot,
    });
}

// lastSeenTs defaults to now() so a seeded device isn't accidentally swept by the 90-day stale
// cutoff — the floor-holding rows in these tests must survive a default purge. Tests exercising
// stale-device removal pass an explicit old lastSeenTs.
async function seedDeviceSyncState(opts: { deviceId: string; userId: string; lastSyncedTs: string; lastSyncedId?: string; lastSeenTs?: string }) {
    await db.collection('deviceSyncState').insertOne({
        _id: `${opts.deviceId}::${opts.userId}`,
        deviceId: opts.deviceId,
        user: opts.userId,
        lastSyncedTs: opts.lastSyncedTs,
        ...(opts.lastSyncedId !== undefined ? { lastSyncedId: opts.lastSyncedId } : {}),
        lastSeenTs: opts.lastSeenTs ?? dayjs().toISOString(),
    });
}

function snap(entityId: string, ts: string, title = 'T') {
    return { _id: entityId, user: 'u', status: 'inbox', title, createdTs: '2024-01-01T00:00:00.000Z', updatedTs: ts };
}

async function purge(sessionCookie: string, body: { staleDeviceDays?: number } = {}) {
    return authenticatedRequest(app, { method: 'POST', path: '/maintenance/purge-operations', sessionCookie, body });
}

async function dedup(sessionCookie: string) {
    return authenticatedRequest(app, { method: 'POST', path: '/maintenance/dedup-operations', sessionCookie, body: {} });
}

// ─── POST /maintenance/purge-operations ───────────────────────────────────────

describe('POST /maintenance/purge-operations', () => {
    it('deletes ops at-or-below the compound floor but keeps ops above the slowest device cursor', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);

        // Two ops: one below the floor (T1), one above it (T2).
        await seedOp({ id: 'op-below', userId, entityId: 'e1', ts: '2024-01-01T00:00:00.000Z', snapshot: snap('e1', '2024-01-01T00:00:00.000Z') });
        await seedOp({ id: 'op-above', userId, entityId: 'e1', ts: '2024-03-01T00:00:00.000Z', snapshot: snap('e1', '2024-03-01T00:00:00.000Z') });
        // Slowest device floor sits at (op-below.ts, op-below._id) → only op-below is purgeable.
        await seedDeviceSyncState({ deviceId: 'dev-1', userId, lastSyncedTs: '2024-01-01T00:00:00.000Z', lastSyncedId: 'op-below' });

        const res = await purge(cookie);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { deletedStaleDevices: number; deletedOps: number; floor: { ts: string; id: string } };
        expect(body.deletedOps).toBe(1);
        expect(body.floor).toEqual({ ts: '2024-01-01T00:00:00.000Z', id: 'op-below' });
        expect(await db.collection('operations').countDocuments({ _id: 'op-below' })).toBe(0);
        expect(await db.collection('operations').countDocuments({ _id: 'op-above' })).toBe(1);
    });

    it('removes stale devices at the configurable cutoff and unblocks the purge floor', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);

        const staleTs = dayjs().subtract(20, 'day').toISOString();
        // A device stale by a 10-day cutoff (but not the 90-day default) pinned at epoch holds the floor.
        await seedDeviceSyncState({ deviceId: 'dev-stale', userId, lastSyncedTs: dayjs(0).toISOString(), lastSyncedId: '', lastSeenTs: staleTs });
        await seedDeviceSyncState({ deviceId: 'dev-active', userId, lastSyncedTs: '2024-02-01T00:00:00.000Z', lastSyncedId: '￿' });
        await seedOp({ id: 'op-1', userId, entityId: 'e1', ts: '2024-01-15T00:00:00.000Z', snapshot: snap('e1', '2024-01-15T00:00:00.000Z') });

        // Default 90-day cutoff: dev-stale survives (only 20 days old) → floor stuck at epoch → no purge.
        const noopRes = await purge(cookie);
        const noopBody = (await noopRes.json()) as { deletedStaleDevices: number; deletedOps: number };
        expect(noopBody.deletedStaleDevices).toBe(0);
        expect(noopBody.deletedOps).toBe(0);

        // 10-day cutoff: dev-stale (lastSeenTs AND lastSyncedTs both older) is pruned, floor advances.
        const res = await purge(cookie, { staleDeviceDays: 10 });
        const body = (await res.json()) as { deletedStaleDevices: number; deletedOps: number };
        expect(body.deletedStaleDevices).toBe(1);
        expect(body.deletedOps).toBe(1);
        expect(await db.collection('deviceSyncState').countDocuments({ deviceId: 'dev-stale' })).toBe(0);
    });

    it('returns floor=null and deletes nothing when the user has no device rows', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedOp({ id: 'op-orphan', userId, entityId: 'e1', ts: '2024-01-01T00:00:00.000Z', snapshot: snap('e1', '2024-01-01T00:00:00.000Z') });

        const res = await purge(cookie);
        const body = (await res.json()) as { deletedOps: number; floor: null };
        expect(body.floor).toBeNull();
        expect(body.deletedOps).toBe(0);
        expect(await db.collection('operations').countDocuments({ _id: 'op-orphan' })).toBe(1);
    });

    it('only touches the calling user’s ops (second user untouched)', async () => {
        const aliceCookie = await loginAsAlice();
        const aliceId = await getUserId(aliceCookie);
        vi.restoreAllMocks();
        const bobCookie = await loginAsBob();
        const bobId = await getUserId(bobCookie);

        await seedOp({ id: 'alice-op', userId: aliceId, entityId: 'a1', ts: '2024-01-01T00:00:00.000Z', snapshot: snap('a1', '2024-01-01T00:00:00.000Z') });
        await seedOp({ id: 'bob-op', userId: bobId, entityId: 'b1', ts: '2024-01-01T00:00:00.000Z', snapshot: snap('b1', '2024-01-01T00:00:00.000Z') });
        await seedDeviceSyncState({ deviceId: 'dev-a', userId: aliceId, lastSyncedTs: '2024-02-01T00:00:00.000Z', lastSyncedId: '￿' });
        await seedDeviceSyncState({ deviceId: 'dev-b', userId: bobId, lastSyncedTs: '2024-02-01T00:00:00.000Z', lastSyncedId: '￿' });

        await purge(aliceCookie);

        expect(await db.collection('operations').countDocuments({ _id: 'alice-op' })).toBe(0);
        expect(await db.collection('operations').countDocuments({ _id: 'bob-op' })).toBe(1);
    });

    it('rejects unauthenticated requests with 401', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/maintenance/purge-operations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }),
        );
        expect(res.status).toBe(401);
    });
});

// ─── POST /maintenance/dedup-operations ───────────────────────────────────────

describe('POST /maintenance/dedup-operations', () => {
    // A floor high enough that every seeded op below sits at-or-below it.
    const HIGH_FLOOR_TS = '2024-12-31T00:00:00.000Z';

    async function seedHighFloorDevice(userId: string) {
        await seedDeviceSyncState({ deviceId: 'dev-1', userId, lastSyncedTs: HIGH_FLOOR_TS, lastSyncedId: '￿' });
    }

    it('collapses consecutive-identical snapshots below the floor, keeping first and latest', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedHighFloorDevice(userId);

        // Five ops for one entity: X, X, X, X, Y. Identical snapshot X four times, then a distinct Y.
        const x = snap('e1', '2024-01-01T00:00:00.000Z', 'same');
        await seedOp({ id: 'o1', userId, entityId: 'e1', ts: '2024-01-01T00:00:01.000Z', snapshot: x });
        await seedOp({ id: 'o2', userId, entityId: 'e1', ts: '2024-01-01T00:00:02.000Z', snapshot: x });
        await seedOp({ id: 'o3', userId, entityId: 'e1', ts: '2024-01-01T00:00:03.000Z', snapshot: x });
        await seedOp({ id: 'o4', userId, entityId: 'e1', ts: '2024-01-01T00:00:04.000Z', snapshot: x });
        await seedOp({ id: 'o5', userId, entityId: 'e1', ts: '2024-01-01T00:00:05.000Z', snapshot: snap('e1', '2024-01-01T00:00:05.000Z', 'different') });

        const res = await dedup(cookie);
        const body = (await res.json()) as { deletedOps: number; scannedEntities: number };
        expect(body.deletedOps).toBe(3); // o2, o3, o4 collapsed; o1 (first) and o5 (distinct/latest) kept
        expect(body.scannedEntities).toBe(1);
        const survivors = await db.collection('operations').find({}).project({ _id: 1 }).toArray();
        expect(survivors.map((o) => o._id).sort()).toEqual(['o1', 'o5']);
    });

    it('keeps the latest op per entity even when it duplicates the prior snapshot', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedHighFloorDevice(userId);

        const x = snap('e1', '2024-01-01T00:00:00.000Z', 'same');
        await seedOp({ id: 'o1', userId, entityId: 'e1', ts: '2024-01-01T00:00:01.000Z', snapshot: x });
        await seedOp({ id: 'o2', userId, entityId: 'e1', ts: '2024-01-01T00:00:02.000Z', snapshot: x });
        await seedOp({ id: 'o3', userId, entityId: 'e1', ts: '2024-01-01T00:00:03.000Z', snapshot: x });

        await dedup(cookie);
        const survivors = await db.collection('operations').find({}).project({ _id: 1 }).toArray();
        // o1 (first kept anchor) and o3 (latest) survive; only o2 collapses.
        expect(survivors.map((o) => o._id).sort()).toEqual(['o1', 'o3']);
    });

    it('never deletes a delete op even when surrounded by identical snapshots', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedHighFloorDevice(userId);

        const x = snap('e1', '2024-01-01T00:00:00.000Z', 'same');
        await seedOp({ id: 'o1', userId, entityId: 'e1', ts: '2024-01-01T00:00:01.000Z', snapshot: x });
        await seedOp({ id: 'o2', userId, entityId: 'e1', ts: '2024-01-01T00:00:02.000Z', snapshot: x });
        await seedOp({ id: 'o3-del', userId, entityId: 'e1', ts: '2024-01-01T00:00:03.000Z', opType: 'delete', snapshot: null });

        await dedup(cookie);
        const survivors = await db.collection('operations').find({}).project({ _id: 1 }).toArray();
        // o2 collapses (dup of o1); o1 kept as anchor; o3-del always kept.
        expect(survivors.map((o) => o._id).sort()).toEqual(['o1', 'o3-del']);
    });

    it('never collapses consecutive rsvp ops (snapshot null, not idempotent snapshot replacements)', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedHighFloorDevice(userId);

        // Two consecutive rsvp ops for the same entity, both with snapshot null. They drive events.patch
        // via replay — collapsing them would drop a distinct intent, so dedup must keep both.
        await seedOp({ id: 'r1', userId, entityId: 'e1', ts: '2024-01-01T00:00:01.000Z', opType: 'rsvp', snapshot: null });
        await seedOp({ id: 'r2', userId, entityId: 'e1', ts: '2024-01-01T00:00:02.000Z', opType: 'rsvp', snapshot: null });

        const res = await dedup(cookie);
        const body = (await res.json()) as { deletedOps: number };
        expect(body.deletedOps).toBe(0);
        const survivors = await db.collection('operations').find({}).project({ _id: 1 }).toArray();
        expect(survivors.map((o) => o._id).sort()).toEqual(['r1', 'r2']);
    });

    it('resets the dedup anchor per entity so the first entity’s held op survives when the next begins', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedHighFloorDevice(userId);

        // Two entities, each [X, X] with the SAME snapshot X shared across both entities. Sorted by
        // (entityId, ts, _id), e1's two ops arrive contiguously, then e2's. e1's latest (e1o2) is "held"
        // when e2o1 starts a new entity — the per-entity anchor reset must keep e1o2, not flush it.
        const x = snap('shared', '2024-01-01T00:00:00.000Z', 'same');
        await seedOp({ id: 'e1o1', userId, entityId: 'e1', ts: '2024-01-01T00:00:01.000Z', snapshot: x });
        await seedOp({ id: 'e1o2', userId, entityId: 'e1', ts: '2024-01-01T00:00:02.000Z', snapshot: x });
        await seedOp({ id: 'e2o1', userId, entityId: 'e2', ts: '2024-01-01T00:00:03.000Z', snapshot: x });
        await seedOp({ id: 'e2o2', userId, entityId: 'e2', ts: '2024-01-01T00:00:04.000Z', snapshot: x });

        const res = await dedup(cookie);
        const body = (await res.json()) as { deletedOps: number; scannedEntities: number };
        // Each entity independently keeps first + latest → nothing collapses (only 2 ops per entity).
        expect(body.deletedOps).toBe(0);
        expect(body.scannedEntities).toBe(2);
        const survivors = await db.collection('operations').find({}).project({ _id: 1 }).toArray();
        expect(survivors.map((o) => o._id).sort()).toEqual(['e1o1', 'e1o2', 'e2o1', 'e2o2']);
    });

    it('treats a floor-holding device with no lastSyncedId as floor id ""', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        // Legacy device row lacking lastSyncedId entirely — must read as '' (lowest id) so the boundary
        // ms is held back. Pin it at a high ts but with id '' so it's the slowest under (ts, id).
        await seedDeviceSyncState({ deviceId: 'dev-legacy', userId, lastSyncedTs: HIGH_FLOOR_TS });

        // op-eq sits exactly at (HIGH_FLOOR_TS, '...') — its _id is lexicographically above '' so the
        // floor id '' means op-zzz at the same ts is NOT at-or-below the floor and survives.
        await seedOp({ id: 'op-below', userId, entityId: 'e1', ts: '2024-06-01T00:00:00.000Z', snapshot: snap('e1', '2024-06-01T00:00:00.000Z') });
        await seedOp({ id: 'op-at-floor-ms', userId, entityId: 'e1', ts: HIGH_FLOOR_TS, snapshot: snap('e1', HIGH_FLOOR_TS) });

        const res = await purge(cookie);
        const body = (await res.json()) as { deletedOps: number; floor: { ts: string; id: string } };
        // Floor id resolves to '' → only ops strictly below the floor ts purge; the at-floor-ms op
        // (id > '') is preserved because '' is the lowest possible id.
        expect(body.floor).toEqual({ ts: HIGH_FLOOR_TS, id: '' });
        expect(body.deletedOps).toBe(1);
        expect(await db.collection('operations').countDocuments({ _id: 'op-below' })).toBe(0);
        expect(await db.collection('operations').countDocuments({ _id: 'op-at-floor-ms' })).toBe(1);
    });

    it('leaves above-floor ops untouched', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        // Floor pinned low so the identical ops sit ABOVE it (still in-flight) → must not be touched.
        await seedDeviceSyncState({ deviceId: 'dev-1', userId, lastSyncedTs: '2024-01-01T00:00:00.000Z', lastSyncedId: '' });

        const x = snap('e1', '2024-06-01T00:00:00.000Z', 'same');
        await seedOp({ id: 'o1', userId, entityId: 'e1', ts: '2024-06-01T00:00:01.000Z', snapshot: x });
        await seedOp({ id: 'o2', userId, entityId: 'e1', ts: '2024-06-01T00:00:02.000Z', snapshot: x });
        await seedOp({ id: 'o3', userId, entityId: 'e1', ts: '2024-06-01T00:00:03.000Z', snapshot: x });

        const res = await dedup(cookie);
        const body = (await res.json()) as { deletedOps: number };
        expect(body.deletedOps).toBe(0);
        expect(await db.collection('operations').countDocuments({ entityId: 'e1' })).toBe(3);
    });

    it('only touches the calling user’s ops (second user untouched)', async () => {
        const aliceCookie = await loginAsAlice();
        const aliceId = await getUserId(aliceCookie);
        vi.restoreAllMocks();
        const bobCookie = await loginAsBob();
        const bobId = await getUserId(bobCookie);

        await seedHighFloorDevice(aliceId);
        await seedDeviceSyncState({ deviceId: 'dev-b', userId: bobId, lastSyncedTs: HIGH_FLOOR_TS, lastSyncedId: '￿' });

        const ax = snap('a1', '2024-01-01T00:00:00.000Z', 'a');
        await seedOp({ id: 'a1op1', userId: aliceId, entityId: 'a1', ts: '2024-01-01T00:00:01.000Z', snapshot: ax });
        await seedOp({ id: 'a1op2', userId: aliceId, entityId: 'a1', ts: '2024-01-01T00:00:02.000Z', snapshot: ax });
        await seedOp({ id: 'a1op3', userId: aliceId, entityId: 'a1', ts: '2024-01-01T00:00:03.000Z', snapshot: ax });

        // Bob has the same duplicate pattern — must be left untouched by Alice's dedup.
        const bx = snap('b1', '2024-01-01T00:00:00.000Z', 'b');
        await seedOp({ id: 'b1op1', userId: bobId, entityId: 'b1', ts: '2024-01-01T00:00:01.000Z', snapshot: bx });
        await seedOp({ id: 'b1op2', userId: bobId, entityId: 'b1', ts: '2024-01-01T00:00:02.000Z', snapshot: bx });
        await seedOp({ id: 'b1op3', userId: bobId, entityId: 'b1', ts: '2024-01-01T00:00:03.000Z', snapshot: bx });

        const res = await dedup(aliceCookie);
        const body = (await res.json()) as { deletedOps: number; scannedEntities: number };
        expect(body.deletedOps).toBe(1); // only Alice's a1op2
        expect(body.scannedEntities).toBe(1); // only Alice's one entity scanned
        expect(await db.collection('operations').countDocuments({ user: bobId })).toBe(3);
    });

    it('rejects unauthenticated requests with 401', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/maintenance/dedup-operations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }),
        );
        expect(res.status).toBe(401);
    });
});

// ─── POST /maintenance/heal-duplicate-calendar-items ──────────────────────────

// Duplicate live items violate uniq_calendar_item_per_event — the heal endpoint exists precisely to
// clean data that predates the index. Drop it so the duplicate fixtures can be seeded; loadDataAccess
// rebuilds it for the next test file.
async function dropCalendarItemIndex() {
    await db
        .collection('items')
        .dropIndex('uniq_calendar_item_per_event')
        .catch(() => undefined);
}

async function seedItem(opts: { id: string; userId: string; calendarEventId?: string; status?: string; updatedTs: string }) {
    await db.collection('items').insertOne({
        _id: opts.id,
        user: opts.userId,
        status: opts.status ?? 'calendar',
        title: 'Meeting',
        timeStart: '2026-06-01T09:00:00Z',
        timeEnd: '2026-06-01T09:30:00Z',
        ...(opts.calendarEventId !== undefined ? { calendarEventId: opts.calendarEventId } : {}),
        calendarIntegrationId: 'int-1',
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: opts.updatedTs,
    });
}

describe('POST /maintenance/heal-duplicate-calendar-items', () => {
    async function heal(sessionCookie: string) {
        return authenticatedRequest(app, { method: 'POST', path: '/maintenance/heal-duplicate-calendar-items', sessionCookie, body: {} });
    }

    it('trashes all but the most-recent live item per event and records an op per loser', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await dropCalendarItemIndex();
        await seedItem({ id: 'keep', userId, calendarEventId: 'evt-1', updatedTs: '2026-03-01T00:00:00.000Z' });
        await seedItem({ id: 'loser', userId, calendarEventId: 'evt-1', updatedTs: '2026-01-01T00:00:00.000Z' });

        const res = await heal(cookie);
        const body = (await res.json()) as { trashedItems: number };
        expect(body.trashedItems).toBe(1);
        expect((await db.collection('items').findOne({ _id: 'keep' }))?.status).toBe('calendar');
        expect((await db.collection('items').findOne({ _id: 'loser' }))?.status).toBe('trash');
        // The trash is recorded as an item update op so other devices converge.
        const ops = await db.collection('operations').find({ entityId: 'loser', entityType: 'item' }).toArray();
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one trash op');
        expect(op.opType).toBe('update');
    });

    it('is idempotent and leaves a single live item untouched', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedItem({ id: 'solo', userId, calendarEventId: 'evt-solo', updatedTs: '2026-01-01T00:00:00.000Z' });

        await heal(cookie);
        const second = (await heal(cookie)).clone();
        const body = (await second.json()) as { trashedItems: number };
        expect(body.trashedItems).toBe(0);
        expect((await db.collection('items').findOne({ _id: 'solo' }))?.status).toBe('calendar');
    });

    it('only touches the calling user’s items', async () => {
        const aliceCookie = await loginAsAlice();
        vi.restoreAllMocks();
        const bobCookie = await loginAsBob();
        const bobId = await getUserId(bobCookie);
        await dropCalendarItemIndex();
        await seedItem({ id: 'b-keep', userId: bobId, calendarEventId: 'evt-b', updatedTs: '2026-03-01T00:00:00.000Z' });
        await seedItem({ id: 'b-loser', userId: bobId, calendarEventId: 'evt-b', updatedTs: '2026-01-01T00:00:00.000Z' });

        const res = await heal(aliceCookie);
        const body = (await res.json()) as { trashedItems: number };
        expect(body.trashedItems).toBe(0);
        expect((await db.collection('items').findOne({ _id: 'b-loser' }))?.status).toBe('calendar');
    });

    it('rejects unauthenticated requests with 401', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/maintenance/heal-duplicate-calendar-items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }),
        );
        expect(res.status).toBe(401);
    });
});

// ─── POST /maintenance/heal-stuck-gcal-routines ───────────────────────────────

async function seedRoutine(opts: { id: string; userId: string; rrule: string; active: boolean; calendarEventId?: string; updatedTs?: string }) {
    await db.collection('routines').insertOne({
        _id: opts.id,
        user: opts.userId,
        title: 'Daily sync',
        routineType: 'calendar',
        rrule: opts.rrule,
        template: {},
        active: opts.active,
        calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
        ...(opts.calendarEventId !== undefined ? { calendarEventId: opts.calendarEventId, calendarIntegrationId: 'int-1' } : {}),
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: opts.updatedTs ?? '2026-05-30T00:00:00.000Z',
    });
}

describe('POST /maintenance/heal-stuck-gcal-routines', () => {
    async function heal(sessionCookie: string) {
        return authenticatedRequest(app, { method: 'POST', path: '/maintenance/heal-stuck-gcal-routines', sessionCookie, body: {} });
    }

    it('strips a past UNTIL, reactivates, and records an op', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedRoutine({
            id: 'r-stuck',
            userId,
            rrule: 'FREQ=WEEKLY;WKST=SU;UNTIL=20251210T215959Z;BYDAY=MO,TU,WE',
            active: false,
            calendarEventId: 'evt-r',
        });

        const res = await heal(cookie);
        const body = (await res.json()) as { revivedRoutines: number };
        expect(body.revivedRoutines).toBe(1);
        const routine = await db.collection('routines').findOne({ _id: 'r-stuck' });
        expect(routine?.rrule).toBe('FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE');
        expect(routine?.active).toBe(true);
        const ops = await db.collection('operations').find({ entityId: 'r-stuck', entityType: 'routine' }).toArray();
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one routine revive op');
        expect(op.opType).toBe('update');
        // Reviving an active routine regenerates future calendar items.
        const itemOps = await db.collection('operations').find({ entityType: 'item' }).toArray();
        expect(itemOps.length).toBeGreaterThan(0);
        const liveItems = await db.collection('items').find({ user: userId, routineId: 'r-stuck', status: 'calendar' }).toArray();
        expect(liveItems.length).toBeGreaterThan(0);
    });

    it('leaves a healthy active routine (future UNTIL, active) untouched', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedRoutine({ id: 'r-ok', userId, rrule: 'FREQ=WEEKLY;UNTIL=20990101T000000Z;BYDAY=MO', active: true, calendarEventId: 'evt-ok' });

        const res = await heal(cookie);
        const body = (await res.json()) as { revivedRoutines: number };
        expect(body.revivedRoutines).toBe(0);
        expect((await db.collection('routines').findOne({ _id: 'r-ok' }))?.active).toBe(true);
    });

    it('ignores in-app routines without a calendarEventId', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedRoutine({ id: 'r-inapp', userId, rrule: 'FREQ=DAILY', active: false });

        const res = await heal(cookie);
        const body = (await res.json()) as { revivedRoutines: number };
        expect(body.revivedRoutines).toBe(0);
        expect((await db.collection('routines').findOne({ _id: 'r-inapp' }))?.active).toBe(false);
    });

    it('revives only the most-recent row per series, leaving inactive duplicates inactive', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        // Two inactive rows on the same series (e.g. left by a prior dedupe) — only the most-recent
        // should revive, so the unique-active-series invariant stays satisfiable.
        const stuckRrule = 'FREQ=WEEKLY;UNTIL=20251210T215959Z;BYDAY=MO';
        await seedRoutine({ id: 'r-old', userId, rrule: stuckRrule, active: false, calendarEventId: 'evt-dup', updatedTs: '2026-05-01T00:00:00.000Z' });
        await seedRoutine({ id: 'r-new', userId, rrule: stuckRrule, active: false, calendarEventId: 'evt-dup', updatedTs: '2026-05-30T00:00:00.000Z' });

        const res = await heal(cookie);
        const body = (await res.json()) as { revivedRoutines: number };
        expect(body.revivedRoutines).toBe(1);
        // Only the most-recent row revives — keeps uniq_active_routine_per_gcal_series satisfiable.
        expect((await db.collection('routines').findOne({ _id: 'r-new' }))?.active).toBe(true);
        expect((await db.collection('routines').findOne({ _id: 'r-old' }))?.active).toBe(false);
    });

    it('does not double-activate a series that already has a healthy active sibling (no E11000, returns 200)', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        // The legitimate post-dedupe state: one ACTIVE routine + a NEWER stuck INACTIVE one on the same
        // series. Reviving the most-recent (inactive) one would create a 2nd active row → E11000 against
        // uniq_active_routine_per_gcal_series, 500ing the request and crashing the next boot. The heal
        // must skip it: the active sibling stays the sole active row.
        await seedRoutine({
            id: 'r-active',
            userId,
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            active: true,
            calendarEventId: 'evt-mixed',
            updatedTs: '2026-05-01T00:00:00.000Z',
        });
        await seedRoutine({
            id: 'r-stuck-inactive',
            userId,
            rrule: 'FREQ=WEEKLY;UNTIL=20251210T215959Z;BYDAY=MO',
            active: false,
            calendarEventId: 'evt-mixed',
            updatedTs: '2026-05-30T00:00:00.000Z',
        });

        const res = await heal(cookie);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { revivedRoutines: number };
        expect(body.revivedRoutines).toBe(0);
        expect((await db.collection('routines').findOne({ _id: 'r-active' }))?.active).toBe(true);
        expect((await db.collection('routines').findOne({ _id: 'r-stuck-inactive' }))?.active).toBe(false);
        // Exactly one active row on the series → the unique index stays satisfiable.
        const active = await db.collection('routines').find({ user: userId, calendarEventId: 'evt-mixed', active: true }).toArray();
        expect(active).toHaveLength(1);
    });

    it('rejects unauthenticated requests with 401', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/maintenance/heal-stuck-gcal-routines', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }),
        );
        expect(res.status).toBe(401);
    });
});

// ─── POST /maintenance/heal-split-successor-routines ───────────────────────────

describe('POST /maintenance/heal-split-successor-routines', () => {
    async function heal(sessionCookie: string) {
        return authenticatedRequest(app, { method: 'POST', path: '/maintenance/heal-split-successor-routines', sessionCookie, body: {} });
    }

    it('revives the lone open-rrule paused successor, links it to the capped parent, and regenerates items', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        // The stranded-split state: a capped+paused parent and an open-rrule paused successor on the
        // same series, with NO active routine — exactly what the import bug left behind.
        await seedRoutine({
            id: 'parent-capped',
            userId,
            rrule: 'FREQ=WEEKLY;WKST=SU;UNTIL=20251110T215959Z;BYDAY=MO,TU,WE',
            active: false,
            calendarEventId: 'evt-split',
            updatedTs: '2026-05-01T00:00:00.000Z',
        });
        await seedRoutine({
            id: 'successor-open',
            userId,
            rrule: 'FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE',
            active: false,
            calendarEventId: 'evt-split',
            updatedTs: '2026-05-24T00:00:00.000Z',
        });

        const res = await heal(cookie);
        const body = (await res.json()) as { revivedSuccessors: number };
        expect(body.revivedSuccessors).toBe(1);

        const successor = await db.collection('routines').findOne({ _id: 'successor-open' });
        expect(successor?.active).toBe(true);
        // Parent UNTIL is NEVER stripped — it stays capped (GCal truth) and paused.
        expect(successor?.rrule).toBe('FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE');
        expect(successor?.splitFromRoutineId).toBe('parent-capped');
        const parent = await db.collection('routines').findOne({ _id: 'parent-capped' });
        expect(parent?.active).toBe(false);
        expect(parent?.rrule).toContain('UNTIL=');

        const op = await db.collection('operations').findOne({ entityId: 'successor-open', entityType: 'routine' });
        expect(op?.opType).toBe('update');
        const liveItems = await db.collection('items').find({ user: userId, routineId: 'successor-open', status: 'calendar' }).toArray();
        expect(liveItems.length).toBeGreaterThan(0);
    });

    it('is idempotent — a second run revives nothing', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedRoutine({ id: 'p', userId, rrule: 'FREQ=WEEKLY;UNTIL=20251110T215959Z;BYDAY=MO', active: false, calendarEventId: 'evt-idem' });
        await seedRoutine({
            id: 's',
            userId,
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            active: false,
            calendarEventId: 'evt-idem',
            updatedTs: '2026-05-24T00:00:00.000Z',
        });

        const first = (await (await heal(cookie)).json()) as { revivedSuccessors: number };
        expect(first.revivedSuccessors).toBe(1);
        const second = (await (await heal(cookie)).json()) as { revivedSuccessors: number };
        expect(second.revivedSuccessors).toBe(0);
    });

    it('skips a series that already has an active routine (no double-activation, no E11000)', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedRoutine({ id: 'live', userId, rrule: 'FREQ=WEEKLY;BYDAY=MO', active: true, calendarEventId: 'evt-has-active' });
        await seedRoutine({ id: 'capped', userId, rrule: 'FREQ=WEEKLY;UNTIL=20251110T215959Z;BYDAY=MO', active: false, calendarEventId: 'evt-has-active' });

        const res = await heal(cookie);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { revivedSuccessors: number };
        expect(body.revivedSuccessors).toBe(0);
        const active = await db.collection('routines').find({ user: userId, calendarEventId: 'evt-has-active', active: true }).toArray();
        expect(active).toHaveLength(1);
    });

    it('does not revive when two stranded successors share a series (ambiguous — must not guess)', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        await seedRoutine({ id: 'cap', userId, rrule: 'FREQ=WEEKLY;UNTIL=20251110T215959Z;BYDAY=MO', active: false, calendarEventId: 'evt-ambig' });
        await seedRoutine({
            id: 'succ-a',
            userId,
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            active: false,
            calendarEventId: 'evt-ambig',
            updatedTs: '2026-05-20T00:00:00.000Z',
        });
        await seedRoutine({
            id: 'succ-b',
            userId,
            rrule: 'FREQ=WEEKLY;BYDAY=TU',
            active: false,
            calendarEventId: 'evt-ambig',
            updatedTs: '2026-05-24T00:00:00.000Z',
        });

        const res = await heal(cookie);
        const body = (await res.json()) as { revivedSuccessors: number };
        expect(body.revivedSuccessors).toBe(0);
        const active = await db.collection('routines').find({ user: userId, calendarEventId: 'evt-ambig', active: true }).toArray();
        expect(active).toHaveLength(0);
    });

    it('does not revive a deliberately-paused single routine with no capped sibling', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        // A lone open-rrule paused routine with NO capped sibling is a user-paused routine, not a split tail.
        await seedRoutine({ id: 'user-paused', userId, rrule: 'FREQ=WEEKLY;BYDAY=MO', active: false, calendarEventId: 'evt-lonely' });

        const res = await heal(cookie);
        const body = (await res.json()) as { revivedSuccessors: number };
        expect(body.revivedSuccessors).toBe(0);
        expect((await db.collection('routines').findOne({ _id: 'user-paused' }))?.active).toBe(false);
    });

    it('rejects unauthenticated requests with 401', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/maintenance/heal-split-successor-routines', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }),
        );
        expect(res.status).toBe(401);
    });
});
