import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import { computePurgeFloor, type PurgeFloor } from '../lib/purgeFloor.js';
import type { AuthVariables } from '../types/authTypes.js';
import { type DeviceSyncStateInterface, deviceSyncStateId } from '../types/entities.js';

/**
 * Per-device endpoints: account membership (signout) and the user-facing connected-devices
 * management surface (list / rename / remove).
 *
 * Mounted at `/devices` (not `/auth`) because Better Auth claims the `/auth/*` namespace
 * via a catch-all in index.ts.
 */

interface ConnectedDevice {
    deviceId: string;
    /** User-given name (PATCH /devices/:deviceId). Wins over autoLabel in the UI. */
    name?: string;
    /** Client-derived label captured at bootstrap, e.g. "Chrome on macOS". */
    autoLabel?: string;
    lastSeenTs: string;
    lastSyncedTs: string;
    /** Operations recorded after this device's pull cursor — what it would have to catch up on. */
    opsBehind: number;
    /** True when this row IS the compound purge floor — the device holding back op-log cleanup. */
    holdsPurgeFloor: boolean;
}

function isFloorHolder(row: DeviceSyncStateInterface, floor: PurgeFloor | null): boolean {
    return floor !== null && row.lastSyncedTs === floor.ts && (row.lastSyncedId ?? '') === floor.id;
}

async function presentConnectedDevice(row: DeviceSyncStateInterface, userId: string, floor: PurgeFloor | null): Promise<ConnectedDevice> {
    const opsBehind = await operationsDAO.countOpsAfter(userId, row.lastSyncedTs, row.lastSyncedId ?? '');
    return {
        deviceId: row.deviceId,
        ...(row.name ? { name: row.name } : {}),
        ...(row.autoLabel ? { autoLabel: row.autoLabel } : {}),
        lastSeenTs: row.lastSeenTs,
        lastSyncedTs: row.lastSyncedTs,
        opsBehind,
        holdsPurgeFloor: isFloorHolder(row, floor),
    };
}

/**
 * Post-removal cleanup, matching the stale-device reaper's rules (lib/staleDevices.ts): the
 * deviceUsers join row for this (device, user) pair always goes, and the push subscription goes
 * only when NO other account still has a sync row on the device (a multi-account device must
 * keep receiving pushes).
 */
async function cleanUpRemovedDevice(deviceId: string, userId: string): Promise<void> {
    await deviceUsersDAO.remove(deviceId, userId);
    const remainingRows = await deviceSyncStateDAO.countDocuments({ deviceId });
    if (remainingRows === 0) {
        await pushSubscriptionsDAO.deleteByDeviceIds([deviceId], userId);
    }
}

/**
 * The removed row may have been pinning the purge floor — advance it immediately so the removal's
 * payoff (freed operations) is visible in the response rather than deferred to the next pull.
 */
async function purgeOpsAfterDeviceRemoval(userId: string): Promise<number> {
    const remaining = await deviceSyncStateDAO.findArray({ user: userId });
    const floor = computePurgeFloor(remaining);
    if (!floor) {
        return 0;
    }
    return await operationsDAO.deleteOlderThan(userId, floor.ts, floor.id);
}

export const deviceRoutes = new Hono<{ Variables: AuthVariables }>()
    // ---------------------------------------------------------------------------
    // GET /devices — connected-devices list for the session user
    // ---------------------------------------------------------------------------
    // One entry per (device, THIS user) sync row. `opsBehind`/`holdsPurgeFloor` surface which device
    // is holding back op-log cleanup so the Settings UI can make removal worth explaining. The
    // caller marks its own row via its local deviceId — the server has no notion of "current device".
    .get('/', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const rows = await deviceSyncStateDAO.findArray({ user: user.id });
        const floor = computePurgeFloor(rows);
        const devices = await Promise.all(rows.map((row) => presentConnectedDevice(row, user.id, floor)));
        const totalOps = await operationsDAO.countDocuments({ user: user.id });
        return c.json({ devices, totalOps });
    })

    // ---------------------------------------------------------------------------
    // PATCH /devices/:deviceId — rename a device (session-user's row only)
    // ---------------------------------------------------------------------------
    .patch('/:deviceId', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const deviceId = c.req.param('deviceId');
        const { name } = await c.req.json<{ name?: string }>();
        const trimmedName = name?.trim();
        if (!trimmedName || trimmedName.length > 64) {
            return c.json({ error: 'name must be 1-64 characters' }, 400);
        }
        // upsert: false — renaming must never fabricate a sync row for a device that was reaped or
        // never bootstrapped; a fabricated epoch-cursor row would re-pin the purge floor.
        const result = await deviceSyncStateDAO.updateOne({ _id: deviceSyncStateId(deviceId, user.id) }, { $set: { name: trimmedName } }, { upsert: false });
        if (result.matchedCount === 0) {
            return c.json({ error: 'device not found' }, 404);
        }
        return c.json({ ok: true });
    })

    // ---------------------------------------------------------------------------
    // DELETE /devices/:deviceId — remove a device from sync (session-user's row only)
    // ---------------------------------------------------------------------------
    // The user-initiated analog of the stale-device reaper, and safe for exactly the same reason:
    // a removed device that later reconnects hits the /sync/pull 409 bootstrapRequired guard and is
    // driven through the client's full recovery flow (push/discard/export queued ops, then
    // re-bootstrap) — nothing is silently skipped. Removing a still-active device is allowed and
    // amounts to forcing it through a full resync.
    .delete('/:deviceId', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const deviceId = c.req.param('deviceId');
        const removed = await deviceSyncStateDAO.deleteDeviceRow(deviceId, user.id);
        if (!removed) {
            return c.json({ error: 'device not found' }, 404);
        }
        await cleanUpRemovedDevice(deviceId, user.id);
        const purgedOps = await purgeOpsAfterDeviceRemoval(user.id);
        return c.json({ ok: true, purgedOps });
    })

    // POST /devices/signout — drop the (deviceId, currentUserId) pair. The actual Better Auth
    // signOut still happens client-side; this endpoint just removes the join row first so the
    // device stops receiving pushes meant for the about-to-be-signed-out account.
    .post('/signout', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const { deviceId } = await c.req.json<{ deviceId: string }>();
        if (!deviceId) {
            return c.json({ error: 'deviceId required' }, 400);
        }

        await deviceUsersDAO.remove(deviceId, user.id);
        return c.json({ ok: true }, 200);
    });
