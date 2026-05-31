import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import { healDuplicateCalendarItems, healStuckGCalRoutines } from '../lib/calendarHeal.js';
import { computePurgeFloor, type PurgeFloor } from '../lib/purgeFloor.js';
import type { AuthVariables } from '../types/authTypes.js';

const DEFAULT_STALE_DEVICE_DAYS = 90;

/**
 * Removes this user's stale (device, user) rows where BOTH lastSeenTs AND lastSyncedTs predate the
 * cutoff, dropping the push subscriptions of any device left with no active sessions. Returns the
 * number of rows removed. Mirrors sync.ts's purgeStaleDevices but with a caller-supplied cutoff.
 */
async function purgeStaleDevices(userId: string, staleDeviceDays: number): Promise<number> {
    const cutoffTs = dayjs().subtract(staleDeviceDays, 'day').toISOString();
    const drainedDeviceIds = await deviceSyncStateDAO.deleteStaleDevices(userId, cutoffTs);
    if (drainedDeviceIds.length) {
        await pushSubscriptionsDAO.deleteByDeviceIds(drainedDeviceIds, userId);
    }
    return drainedDeviceIds.length;
}

/** Recomputes the compound purge floor across the user's remaining device rows, or null if none. */
async function currentPurgeFloor(userId: string): Promise<PurgeFloor | null> {
    const deviceStates = await deviceSyncStateDAO.findArray({ user: userId });
    return computePurgeFloor(deviceStates);
}

function parseStaleDeviceDays(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
        return DEFAULT_STALE_DEVICE_DAYS;
    }
    return value;
}

export const maintenanceRoutes = new Hono<{ Variables: AuthVariables }>()
    // ---------------------------------------------------------------------------
    // POST /maintenance/purge-operations — on-demand op-log purge for the caller
    // ---------------------------------------------------------------------------
    // The /sync/pull fire-and-forget purge only fires on pull with a 90-day stale cutoff. This lets a
    // user dig out a bloated op log on demand and tune the stale-device cutoff down. Scoped to the
    // session user — never accepts a userId in the body.
    .post('/purge-operations', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const body = await c.req.json<{ staleDeviceDays?: number }>().catch(() => ({}) as { staleDeviceDays?: number });
        const staleDeviceDays = parseStaleDeviceDays(body.staleDeviceDays);

        const deletedStaleDevices = await purgeStaleDevices(user.id, staleDeviceDays);
        const floor = await currentPurgeFloor(user.id);
        if (!floor) {
            return c.json({ deletedStaleDevices, deletedOps: 0, floor: null }, 200);
        }

        const deletedOps = await operationsDAO.deleteOlderThan(user.id, floor.ts, floor.id);
        return c.json({ deletedStaleDevices, deletedOps, floor }, 200);
    })

    // ---------------------------------------------------------------------------
    // POST /maintenance/dedup-operations — collapse perpetual-no-op-update bloat
    // ---------------------------------------------------------------------------
    // Calendar-webhook fires can rewrite identical full-snapshot ops for one entity repeatedly. Since
    // ops store full snapshots and client apply is idempotent + last-write-wins, removing intermediate
    // identical snapshots leaves every device converging to the same final state. We only touch ops
    // AT-OR-BELOW the compound purge floor — ops above it may still be in-flight to a device.
    .post('/dedup-operations', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const floor = await currentPurgeFloor(user.id);
        if (!floor) {
            return c.json({ deletedOps: 0, scannedEntities: 0 }, 200);
        }

        const { deletableIds, scannedEntities } = await operationsDAO.findRedundantOpIdsBelowFloor(user.id, floor);
        const deletedOps = await operationsDAO.deleteByIds(deletableIds, user.id);
        return c.json({ deletedOps, scannedEntities }, 200);
    })

    // ---------------------------------------------------------------------------
    // POST /maintenance/heal-duplicate-calendar-items — collapse duplicate live items
    // ---------------------------------------------------------------------------
    // On-demand, op-recording analog of the boot dedupe migration: trashes all but the most-recent
    // live `calendar` item per GCal event for the caller. Idempotent. Scoped to the session user.
    .post('/heal-duplicate-calendar-items', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const ops = await healDuplicateCalendarItems(user.id, dayjs().toISOString());
        return c.json({ trashedItems: ops.length }, 200);
    })

    // ---------------------------------------------------------------------------
    // POST /maintenance/heal-stuck-gcal-routines — revive stranded recurring routines
    // ---------------------------------------------------------------------------
    // Reactivates the caller's GCal-linked routines stranded with a past UNTIL or active:false (the
    // stale-UNTIL deadlock): strips the past UNTIL, sets active:true, regenerates future items. Records
    // ops so other devices converge. Run AFTER the sync fix deploys, else churn could re-corrupt them.
    .post('/heal-stuck-gcal-routines', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const ops = await healStuckGCalRoutines(user.id, dayjs().toISOString());
        const revivedRoutines = ops.filter((op) => op.entityType === 'routine').length;
        return c.json({ revivedRoutines, totalOps: ops.length }, 200);
    });
