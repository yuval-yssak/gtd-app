/** Tests for the /devices surface: POST /devices/signout (pre-signOut join-row cleanup) and the
 *  connected-devices management endpoints — GET / (list with sync-lag figures), PATCH /:deviceId
 *  (rename), DELETE /:deviceId (user-initiated reap + immediate op purge). */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { deviceRoutes } from '../routes/devices.js';
import { syncRoutes } from '../routes/sync.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/devices', deviceRoutes)
    // Mounted so the removal tests can assert the end-to-end contract: a removed device's next
    // /sync/pull answers 409 bootstrapRequired (the same guard that covers reaper-removed rows).
    .route('/sync', syncRoutes);

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
        db.collection('deviceUsers').deleteMany({}),
        db.collection('deviceSyncState').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('pushSubscriptions').deleteMany({}),
    ]);
    vi.restoreAllMocks();
});

async function loginAsAlice(): Promise<{ cookie: string; userId: string }> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    if (!sessionCookie) {
        throw new Error('Failed to obtain session cookie for Alice');
    }
    const sessionRes = await app.fetch(
        new Request('http://localhost:4000/auth/get-session', {
            headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
        }),
    );
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    return { cookie: sessionCookie, userId: user.id };
}

async function loginAsBob(): Promise<{ cookie: string; userId: string }> {
    // GitHub provider with an unrelated email so Bob is a distinct Better Auth user
    const { sessionCookie } = await oauthLogin(app, 'github', { email: 'bob@example.com', login: 'bob-gh' });
    if (!sessionCookie) {
        throw new Error('Failed to obtain session cookie for Bob');
    }
    const sessionRes = await app.fetch(
        new Request('http://localhost:4000/auth/get-session', {
            headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
        }),
    );
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    return { cookie: sessionCookie, userId: user.id };
}

/** Inserts an operation row directly with an explicit (ts, _id) so floor control is deterministic. */
async function seedOp(opts: { id: string; userId: string; ts: string }) {
    await db.collection('operations').insertOne({
        _id: opts.id,
        user: opts.userId,
        deviceId: 'seed-dev',
        ts: opts.ts,
        entityType: 'item',
        entityId: 'e1',
        opType: 'update',
        snapshot: { _id: 'e1', status: 'inbox', title: 'T', createdTs: '2024-01-01T00:00:00.000Z', updatedTs: opts.ts },
    });
}

// lastSeenTs defaults to now() so a seeded device isn't swept by the STALE_DEVICE_DAYS cutoff
// mid-test; tests that need a stale-looking device pass an explicit old lastSeenTs.
async function seedDeviceSyncState(opts: {
    deviceId: string;
    userId: string;
    lastSyncedTs: string;
    lastSyncedId?: string;
    lastSeenTs?: string;
    name?: string;
    autoLabel?: string;
}) {
    await db.collection('deviceSyncState').insertOne({
        _id: `${opts.deviceId}::${opts.userId}`,
        deviceId: opts.deviceId,
        user: opts.userId,
        lastSyncedTs: opts.lastSyncedTs,
        ...(opts.lastSyncedId !== undefined ? { lastSyncedId: opts.lastSyncedId } : {}),
        lastSeenTs: opts.lastSeenTs ?? dayjs().toISOString(),
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.autoLabel ? { autoLabel: opts.autoLabel } : {}),
    });
}

interface ConnectedDeviceJson {
    deviceId: string;
    name?: string;
    autoLabel?: string;
    lastSeenTs: string;
    lastSyncedTs: string;
    opsBehind: number;
    holdsPurgeFloor: boolean;
}

async function listDevices(sessionCookie: string): Promise<{ status: number; devices: ConnectedDeviceJson[]; totalOps: number }> {
    const res = await authenticatedRequest(app, { method: 'GET', path: '/devices', sessionCookie });
    const body = (await res.json()) as { devices: ConnectedDeviceJson[]; totalOps: number };
    return { status: res.status, ...body };
}

// ─── GET /devices ────────────────────────────────────────────────────────────

describe('GET /devices', () => {
    it('rejects unauthenticated requests with 401', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/devices'));
        expect(res.status).toBe(401);
    });

    it('returns an empty list and zero totalOps for a user with no device rows', async () => {
        const alice = await loginAsAlice();
        const { status, devices, totalOps } = await listDevices(alice.cookie);
        expect(status).toBe(200);
        expect(devices).toEqual([]);
        expect(totalOps).toBe(0);
    });

    it('lists only the session user’s devices with labels, sync-lag counts, and the floor holder marked', async () => {
        const alice = await loginAsAlice();
        vi.restoreAllMocks();
        const bob = await loginAsBob();

        await seedOp({ id: 'op-1', userId: alice.userId, ts: '2024-01-01T00:00:00.000Z' });
        await seedOp({ id: 'op-2', userId: alice.userId, ts: '2024-02-01T00:00:00.000Z' });
        await seedOp({ id: 'op-3', userId: alice.userId, ts: '2024-03-01T00:00:00.000Z' });
        // dev-slow acked through op-1; dev-fast through op-2. Bob's row must not appear for Alice.
        await seedDeviceSyncState({
            deviceId: 'dev-slow',
            userId: alice.userId,
            lastSyncedTs: '2024-01-01T00:00:00.000Z',
            lastSyncedId: 'op-1',
            name: 'Old tablet',
        });
        await seedDeviceSyncState({
            deviceId: 'dev-fast',
            userId: alice.userId,
            lastSyncedTs: '2024-02-01T00:00:00.000Z',
            lastSyncedId: 'op-2',
            autoLabel: 'Chrome on macOS',
        });
        await seedDeviceSyncState({ deviceId: 'dev-bob', userId: bob.userId, lastSyncedTs: '2024-01-01T00:00:00.000Z', lastSyncedId: 'op-1' });

        const { devices, totalOps } = await listDevices(alice.cookie);

        expect(totalOps).toBe(3);
        expect(devices.map((d) => d.deviceId).sort()).toEqual(['dev-fast', 'dev-slow']);
        const slow = devices.find((d) => d.deviceId === 'dev-slow');
        const fast = devices.find((d) => d.deviceId === 'dev-fast');
        expect(slow).toMatchObject({ name: 'Old tablet', opsBehind: 2, holdsPurgeFloor: true });
        expect(fast).toMatchObject({ autoLabel: 'Chrome on macOS', opsBehind: 1, holdsPurgeFloor: false });
    });

    it('a legacy row without lastSyncedId reads as id "" and counts the whole boundary ms as behind', async () => {
        const alice = await loginAsAlice();
        const boundaryTs = '2024-01-01T00:00:00.000Z';
        await seedOp({ id: 'op-a', userId: alice.userId, ts: boundaryTs });
        // Row seeded WITHOUT lastSyncedId (pre-compound-cursor shape) — must not crash and must
        // treat the cursor id as '' (lowest), so the same-ms op counts as not-yet-delivered.
        await seedDeviceSyncState({ deviceId: 'dev-legacy', userId: alice.userId, lastSyncedTs: boundaryTs });

        const { devices } = await listDevices(alice.cookie);
        const [device] = devices;
        if (!device) throw new Error('expected one device');
        expect(device.opsBehind).toBe(1);
    });

    it('counts same-millisecond ops past the compound cursor as behind (id component respected)', async () => {
        const alice = await loginAsAlice();
        const boundaryTs = '2024-01-01T00:00:00.000Z';
        await seedOp({ id: 'op-a', userId: alice.userId, ts: boundaryTs });
        await seedOp({ id: 'op-b', userId: alice.userId, ts: boundaryTs });
        // Cursor sits at (boundaryTs, 'op-a') — op-b shares the ms but is past the cursor.
        await seedDeviceSyncState({ deviceId: 'dev-1', userId: alice.userId, lastSyncedTs: boundaryTs, lastSyncedId: 'op-a' });

        const { devices } = await listDevices(alice.cookie);
        const [device] = devices;
        if (!device) throw new Error('expected one device');
        expect(device.opsBehind).toBe(1);
    });
});

// ─── PATCH /devices/:deviceId ────────────────────────────────────────────────

describe('PATCH /devices/:deviceId', () => {
    it('renames the session user’s device and the new name shows up in the list', async () => {
        const alice = await loginAsAlice();
        await seedDeviceSyncState({
            deviceId: 'dev-1',
            userId: alice.userId,
            lastSyncedTs: '2024-01-01T00:00:00.000Z',
            lastSyncedId: '',
            autoLabel: 'Chrome on macOS',
        });

        const res = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/devices/dev-1',
            sessionCookie: alice.cookie,
            body: { name: '  Work laptop  ' },
        });

        expect(res.status).toBe(200);
        const { devices } = await listDevices(alice.cookie);
        expect(devices[0]?.name).toBe('Work laptop'); // trimmed
    });

    it('rejects an empty or over-long name with 400', async () => {
        const alice = await loginAsAlice();
        await seedDeviceSyncState({ deviceId: 'dev-1', userId: alice.userId, lastSyncedTs: '2024-01-01T00:00:00.000Z', lastSyncedId: '' });

        const emptyRes = await authenticatedRequest(app, { method: 'PATCH', path: '/devices/dev-1', sessionCookie: alice.cookie, body: { name: '   ' } });
        expect(emptyRes.status).toBe(400);

        const longRes = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/devices/dev-1',
            sessionCookie: alice.cookie,
            body: { name: 'x'.repeat(65) },
        });
        expect(longRes.status).toBe(400);
    });

    it('answers 404 for an unknown device and never fabricates a sync row', async () => {
        const alice = await loginAsAlice();

        const res = await authenticatedRequest(app, { method: 'PATCH', path: '/devices/dev-ghost', sessionCookie: alice.cookie, body: { name: 'Ghost' } });

        expect(res.status).toBe(404);
        // A fabricated row would sit at an epoch cursor and re-pin the purge floor.
        expect(await db.collection('deviceSyncState').countDocuments({ deviceId: 'dev-ghost' })).toBe(0);
    });

    it('cannot rename another user’s device row (404, row untouched)', async () => {
        const alice = await loginAsAlice();
        vi.restoreAllMocks();
        const bob = await loginAsBob();
        await seedDeviceSyncState({ deviceId: 'dev-bob', userId: bob.userId, lastSyncedTs: '2024-01-01T00:00:00.000Z', lastSyncedId: '', name: 'Bob phone' });

        const res = await authenticatedRequest(app, { method: 'PATCH', path: '/devices/dev-bob', sessionCookie: alice.cookie, body: { name: 'Hijacked' } });

        expect(res.status).toBe(404);
        const bobRow = await db.collection('deviceSyncState').findOne({ _id: `dev-bob::${bob.userId}` } as never);
        expect(bobRow?.name).toBe('Bob phone');
    });
});

// ─── DELETE /devices/:deviceId ───────────────────────────────────────────────

describe('DELETE /devices/:deviceId', () => {
    it('removes the row, purges ops the device was pinning, and reports the freed count', async () => {
        const alice = await loginAsAlice();
        await seedOp({ id: 'op-old', userId: alice.userId, ts: '2024-01-01T00:00:00.000Z' });
        await seedOp({ id: 'op-new', userId: alice.userId, ts: '2024-03-01T00:00:00.000Z' });
        // dev-slow pins the floor at op-old; dev-fast has acked through op-old already.
        await seedDeviceSyncState({ deviceId: 'dev-slow', userId: alice.userId, lastSyncedTs: '2020-01-01T00:00:00.000Z', lastSyncedId: '' });
        await seedDeviceSyncState({ deviceId: 'dev-fast', userId: alice.userId, lastSyncedTs: '2024-01-01T00:00:00.000Z', lastSyncedId: 'op-old' });
        await deviceUsersDAO.upsert('dev-slow', alice.userId);

        const res = await authenticatedRequest(app, { method: 'DELETE', path: '/devices/dev-slow', sessionCookie: alice.cookie });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; purgedOps: number };
        expect(body).toEqual({ ok: true, purgedOps: 1 });
        // Floor advanced to dev-fast's cursor: op-old purged, op-new (past the cursor) kept.
        expect(await db.collection('operations').countDocuments({ user: alice.userId })).toBe(1);
        expect(await db.collection('operations').countDocuments({ _id: 'op-new' } as never)).toBe(1);
        // Sync row and deviceUsers join row are both gone.
        expect(await db.collection('deviceSyncState').countDocuments({ deviceId: 'dev-slow' })).toBe(0);
        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'dev-slow' })).toBe(0);
        const { devices } = await listDevices(alice.cookie);
        expect(devices.map((d) => d.deviceId)).toEqual(['dev-fast']);
    });

    it('purges nothing when the user removes their only device (no floor without rows)', async () => {
        const alice = await loginAsAlice();
        await seedOp({ id: 'op-1', userId: alice.userId, ts: '2024-01-01T00:00:00.000Z' });
        await seedDeviceSyncState({ deviceId: 'dev-only', userId: alice.userId, lastSyncedTs: '2024-02-01T00:00:00.000Z', lastSyncedId: 'op-1' });

        const res = await authenticatedRequest(app, { method: 'DELETE', path: '/devices/dev-only', sessionCookie: alice.cookie });

        const body = (await res.json()) as { purgedOps: number };
        expect(body.purgedOps).toBe(0);
        // No registered rows left → no floor → ops must survive (purging against a fabricated
        // floor could delete ops a future device still needs to see... via bootstrap they won't,
        // but the invariant "no rows → no purge" is what computePurgeFloor guarantees).
        expect(await db.collection('operations').countDocuments({ user: alice.userId })).toBe(1);
    });

    it('answers 404 for an unknown device', async () => {
        const alice = await loginAsAlice();
        const res = await authenticatedRequest(app, { method: 'DELETE', path: '/devices/dev-ghost', sessionCookie: alice.cookie });
        expect(res.status).toBe(404);
    });

    it('cannot remove another user’s device row (404, row and ops untouched)', async () => {
        const alice = await loginAsAlice();
        vi.restoreAllMocks();
        const bob = await loginAsBob();
        await seedDeviceSyncState({ deviceId: 'dev-bob', userId: bob.userId, lastSyncedTs: '2024-01-01T00:00:00.000Z', lastSyncedId: '' });
        await seedOp({ id: 'op-bob', userId: bob.userId, ts: '2024-02-01T00:00:00.000Z' });

        const res = await authenticatedRequest(app, { method: 'DELETE', path: '/devices/dev-bob', sessionCookie: alice.cookie });

        expect(res.status).toBe(404);
        expect(await db.collection('deviceSyncState').countDocuments({ deviceId: 'dev-bob' })).toBe(1);
        expect(await db.collection('operations').countDocuments({ user: bob.userId })).toBe(1);
    });

    it('drops the push subscription only once no account still has a sync row on the device', async () => {
        const alice = await loginAsAlice();
        vi.restoreAllMocks();
        const bob = await loginAsBob();
        // One shared physical device: a single push subscription row keyed by deviceId.
        await db.collection('pushSubscriptions').insertOne({
            _id: 'dev-shared',
            user: alice.userId,
            endpoint: 'https://push.example/e',
            keys: { p256dh: 'k', auth: 'a' },
            updatedTs: dayjs().toISOString(),
        } as never);
        await seedDeviceSyncState({ deviceId: 'dev-shared', userId: alice.userId, lastSyncedTs: '2024-01-01T00:00:00.000Z', lastSyncedId: '' });
        await seedDeviceSyncState({ deviceId: 'dev-shared', userId: bob.userId, lastSyncedTs: '2024-01-01T00:00:00.000Z', lastSyncedId: '' });

        await authenticatedRequest(app, { method: 'DELETE', path: '/devices/dev-shared', sessionCookie: alice.cookie });
        // Bob still syncs on this device — the shared subscription must survive.
        expect(await db.collection('pushSubscriptions').countDocuments({ _id: 'dev-shared' } as never)).toBe(1);

        await authenticatedRequest(app, { method: 'DELETE', path: '/devices/dev-shared', sessionCookie: bob.cookie });
        // Fully drained. The subscription row is user-scoped to its registrar (Alice), so Bob's
        // removal can't delete it — matching the stale reaper's semantics; push-delivery failure
        // cleanup (404/410 → removeAllForDevice) handles the leftover.
        expect(await db.collection('deviceSyncState').countDocuments({ deviceId: 'dev-shared' })).toBe(0);
    });

    it('drops the push subscription when the removing user drains the device and owns the subscription', async () => {
        const alice = await loginAsAlice();
        await db.collection('pushSubscriptions').insertOne({
            _id: 'dev-1',
            user: alice.userId,
            endpoint: 'https://push.example/e',
            keys: { p256dh: 'k', auth: 'a' },
            updatedTs: dayjs().toISOString(),
        } as never);
        await seedDeviceSyncState({ deviceId: 'dev-1', userId: alice.userId, lastSyncedTs: '2024-01-01T00:00:00.000Z', lastSyncedId: '' });

        await authenticatedRequest(app, { method: 'DELETE', path: '/devices/dev-1', sessionCookie: alice.cookie });

        expect(await db.collection('pushSubscriptions').countDocuments({ _id: 'dev-1' } as never)).toBe(0);
    });

    it('a removed device’s next /sync/pull answers 409 bootstrapRequired (recovery contract)', async () => {
        const alice = await loginAsAlice();
        await seedDeviceSyncState({ deviceId: 'dev-1', userId: alice.userId, lastSyncedTs: '2024-01-01T00:00:00.000Z', lastSyncedId: '' });

        await authenticatedRequest(app, { method: 'DELETE', path: '/devices/dev-1', sessionCookie: alice.cookie });

        const pullRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/sync/pull?since=2024-01-01T00:00:00.000Z&deviceId=dev-1',
            sessionCookie: alice.cookie,
        });
        expect(pullRes.status).toBe(409);
        expect(await pullRes.json()).toEqual({ bootstrapRequired: true });
    });
});

// ─── POST /devices/signout ───────────────────────────────────────────────────

describe('POST /devices/signout', () => {
    it('removes only the active user’s (deviceId, userId) row and leaves other users intact', async () => {
        const alice = await loginAsAlice();
        vi.restoreAllMocks();
        const bob = await loginAsBob();

        // Both accounts share the same device — model the multi-account scenario
        await deviceUsersDAO.upsert('dev-shared', alice.userId);
        await deviceUsersDAO.upsert('dev-shared', bob.userId);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/devices/signout',
            sessionCookie: alice.cookie,
            body: { deviceId: 'dev-shared' },
        });

        expect(res.status).toBe(200);
        // Alice's row is gone; Bob's row remains
        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'dev-shared', userId: alice.userId })).toBe(0);
        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'dev-shared', userId: bob.userId })).toBe(1);
    });

    it('returns 200 even when no row exists (idempotent — safe to retry)', async () => {
        const alice = await loginAsAlice();

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/devices/signout',
            sessionCookie: alice.cookie,
            body: { deviceId: 'dev-not-seen-before' },
        });

        expect(res.status).toBe(200);
    });

    it('rejects unauthenticated requests with 401', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/devices/signout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId: 'dev-x' }),
            }),
        );
        expect(res.status).toBe(401);
    });

    it('returns 400 when deviceId is missing from the body', async () => {
        const alice = await loginAsAlice();

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/devices/signout',
            sessionCookie: alice.cookie,
            body: {},
        });

        expect(res.status).toBe(400);
    });

    it('does not touch rows for other devices when removing one device’s row', async () => {
        const alice = await loginAsAlice();
        await deviceUsersDAO.upsert('dev-phone', alice.userId);
        await deviceUsersDAO.upsert('dev-laptop', alice.userId);

        await authenticatedRequest(app, {
            method: 'POST',
            path: '/devices/signout',
            sessionCookie: alice.cookie,
            body: { deviceId: 'dev-phone' },
        });

        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'dev-phone' })).toBe(0);
        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'dev-laptop' })).toBe(1);
    });
});
