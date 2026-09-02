import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { healDuplicateCalendarItems, healSplitSuccessorRoutines, healStuckGCalRoutines } from '../lib/calendarHeal.js';
import { computePurgeFloor, type PurgeFloor, STALE_DEVICE_DAYS } from '../lib/purgeFloor.js';
import { reapStaleDevices } from '../lib/staleDevices.js';
import { runSyncDoctor } from '../lib/syncDoctor.js';
import type { AuthVariables } from '../types/authTypes.js';
import { buildRoutineChainResolver, relinkCalendarMarkersForUser } from './calendar.js';

type SyncDoctorBody = { healPoisonedWatermarks?: boolean; checkCalendarChains?: boolean; chainCheckLimit?: number };

const MIN_CHAIN_CHECK_LIMIT = 1;
const MAX_CHAIN_CHECK_LIMIT = 100;

/** Clamps a caller-supplied chain-check cap into [1, 100]; `undefined` (→ syncDoctor's default) for anything non-numeric. Exported for unit testing. */
export function clampChainCheckLimit(raw: unknown): number | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return undefined;
    }
    return Math.min(Math.max(Math.floor(raw), MIN_CHAIN_CHECK_LIMIT), MAX_CHAIN_CHECK_LIMIT);
}

// Same cutoff as the /sync/pull fire-and-forget reaper — an on-demand purge with the default body
// must not be more (or less) aggressive than what background pulls already do.
const DEFAULT_STALE_DEVICE_DAYS = STALE_DEVICE_DAYS;

/**
 * Removes this user's stale (device, user) rows where BOTH lastSeenTs AND lastSyncedTs predate the
 * cutoff, with the shared cleanup (deviceUsers join rows, push subscriptions of drained devices).
 * Returns the number of devices whose row was removed for this user. Same reap as sync.ts's
 * pull-time purgeStaleDevices, but with a caller-supplied cutoff.
 */
async function purgeStaleDevices(userId: string, staleDeviceDays: number): Promise<number> {
    const cutoffTs = dayjs().subtract(staleDeviceDays, 'day').toISOString();
    const { removedDeviceIds } = await reapStaleDevices(userId, cutoffTs);
    return removedDeviceIds.length;
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
    // The /sync/pull fire-and-forget purge only fires on pull with the shared stale cutoff. This lets a
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
    })

    // ---------------------------------------------------------------------------
    // POST /maintenance/heal-split-successor-routines — recover stranded split tails
    // ---------------------------------------------------------------------------
    // Recovers GCal "this and all following" splits whose open-ended successor routine was stranded
    // active:false (the live tail never went active → the series shows nothing in the app). Per series,
    // reactivates the lone open-rrule paused routine and links it to the capped parent — WITHOUT
    // stripping the parent's UNTIL (the parent stays capped, matching GCal truth). Distinct from
    // heal-stuck-gcal-routines, which is unsafe here because stripping the parent's UNTIL would
    // fabricate a phantom infinite series contradicting GCal. Idempotent; scoped to the session user.
    .post('/heal-split-successor-routines', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const ops = await healSplitSuccessorRoutines(user.id, dayjs().toISOString());
        const revivedSuccessors = ops.filter((op) => op.entityType === 'routine').length;
        return c.json({ revivedSuccessors, totalOps: ops.length }, 200);
    })

    // ---------------------------------------------------------------------------
    // POST /maintenance/sync-doctor — read-only invariant sweep over the caller's sync state
    // ---------------------------------------------------------------------------
    // Reports every known sync-corruption class (duplicate active series, phantom items on inactive
    // routines, duplicate live calendar items, unmarked retirements, poisoned LWW watermarks, future
    // cursors, dangling integration refs) without writing anything. The single opt-in write is
    // `{ healPoisonedWatermarks: true }`, which re-stamps future-dated rows to now and records ops.
    // `{ checkCalendarChains: true }` additionally runs the (read-only but Google-round-trip-costly)
    // split-chain checks: stale anchors on capped/deleted masters, and chains that are over. Capped
    // per call (`chainCheckLimit`, clamped 1..100, default in syncDoctor.ts) so a big account cannot
    // turn one request into an unbounded sequential Google sweep; `chainCheckTruncated` signals more.
    .post('/sync-doctor', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const body = await c.req.json<SyncDoctorBody>().catch(() => ({}) as SyncDoctorBody);
        const now = dayjs().toISOString();
        const resolveRoutineChain = body.checkCalendarChains === true ? await buildRoutineChainResolver(user.id, now) : undefined;
        const chainCheckLimit = clampChainCheckLimit(body.chainCheckLimit);
        const report = await runSyncDoctor(user.id, now, {
            healPoisonedWatermarks: body.healPoisonedWatermarks === true,
            ...(resolveRoutineChain ? { resolveRoutineChain } : {}),
            ...(chainCheckLimit !== undefined ? { chainCheckLimit } : {}),
        });
        return c.json(report, 200);
    })

    // ---------------------------------------------------------------------------
    // POST /maintenance/relink-calendar-markers — resolve stranded lastKnown* markers
    // ---------------------------------------------------------------------------
    // Actively fetches each same-account disconnect marker's event by id and relinks/converges it —
    // the on-demand form of the full-sync relink sweep, healing entities stranded before the sweep
    // shipped without waiting for a disconnect/reconnect cycle. Idempotent. Scoped to the session user.
    .post('/relink-calendar-markers', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const result = await relinkCalendarMarkersForUser(user.id);
        return c.json(result, 200);
    });
