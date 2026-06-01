import dayjs from 'dayjs';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import type { ItemInterface, OperationInterface, RoutineInterface } from '../types/entities.js';
import { isDuplicateKeyError } from './mongoErrors.js';
import { recordOperation } from './operationHelpers.js';
import { regenerateFutureRoutineItems } from './routineItemRegeneration.js';
import { extractUntilFromRrule } from './rruleHelpers.js';
import { hasAtLeastOne } from './typeUtils.js';

/**
 * Per-user, op-recording analogs of the boot migrations + sync repair paths, exposed via the
 * `/maintenance/*` heal endpoints. The boot migrations write directly to Mongo (devices reconcile via
 * the bumped `updatedTs`); these endpoints instead route every change through `recordOperation` so the
 * caller's other devices converge on their next pull. Run them AFTER the sync fixes deploy — otherwise
 * residual churn could re-corrupt a freshly-healed routine schedule.
 */

/** Groups a user's live calendar items by `calendarEventId`, returning only the duplicated groups. */
function groupLiveItemsByEvent(items: ItemInterface[]): ItemInterface[][] {
    const byEvent = new Map<string, ItemInterface[]>();
    for (const item of items) {
        const key = item.calendarEventId;
        if (!key) {
            continue;
        }
        byEvent.set(key, [...(byEvent.get(key) ?? []), item]);
    }
    return [...byEvent.values()].filter((group) => group.length > 1);
}

/** Latest `updatedTs` first, `_id` as a deterministic tie-break — the keeper sits at index 0. */
function keeperFirst<T extends { _id?: string; updatedTs: string }>(a: T, b: T): number {
    const tsDelta = b.updatedTs.localeCompare(a.updatedTs);
    return tsDelta !== 0 ? tsDelta : (b._id ?? '').localeCompare(a._id ?? '');
}

/** Trashes a single item, recording the update op. Returns the op, or null if the item has no id. */
async function trashItemRecordingOp(item: ItemInterface, userId: string, now: string): Promise<OperationInterface | null> {
    const itemId = item._id;
    if (!itemId) {
        return null;
    }
    const snapshot: ItemInterface = { ...item, status: 'trash', updatedTs: now };
    await itemsDAO.replaceById(itemId, snapshot);
    return recordOperation(userId, { entityType: 'item', entityId: itemId, snapshot, opType: 'update', now });
}

/**
 * Collapses the caller's duplicate live calendar items per GCal event, trashing all but the keeper
 * (most-recent `updatedTs`). Returns the recorded ops. Idempotent: a re-run finds no duplicate groups.
 */
export async function healDuplicateCalendarItems(userId: string, now: string): Promise<OperationInterface[]> {
    const live = await itemsDAO.findArray({ user: userId, status: 'calendar', calendarEventId: { $type: 'string' } });
    const losers = groupLiveItemsByEvent(live).flatMap((group) => [...group].sort(keeperFirst).slice(1));
    const ops = await Promise.all(losers.map((item) => trashItemRecordingOp(item, userId, now)));
    return ops.filter((op): op is OperationInterface => op !== null);
}

/** Strips a `UNTIL=...` clause (and any leftover `;;`/trailing `;`) from an rrule string. */
function stripUntil(rrule: string): string {
    return rrule
        .replace(/UNTIL=[^;]+;?/, '')
        .replace(/;;/g, ';')
        .replace(/;$/, '');
}

/** True when the rrule carries a UNTIL that has already passed relative to `now`. */
function hasPastUntil(rrule: string, now: string): boolean {
    const until = extractUntilFromRrule(rrule);
    return until !== null && dayjs(until).isBefore(dayjs(now));
}

/** A GCal-linked routine is "stuck" (generates no future items) when it's inactive or capped in the past. */
function isStuckRoutine(routine: RoutineInterface, now: string): boolean {
    return Boolean(routine.calendarEventId) && (!routine.active || hasPastUntil(routine.rrule, now));
}

/** Reactivates one stuck routine: strips the past UNTIL, sets active, records the op, regenerates items. */
async function reviveRoutine(routine: RoutineInterface, userId: string, now: string): Promise<OperationInterface[]> {
    const revived: RoutineInterface = { ...routine, rrule: stripUntil(routine.rrule), active: true, updatedTs: now };
    await routinesDAO.replaceById(routine._id, revived);
    const updateOp = await recordOperation(userId, { entityType: 'routine', entityId: routine._id, snapshot: revived, opType: 'update', now });
    const itemOps = await regenerateFutureRoutineItems(revived, userId, now);
    return [updateOp, ...itemOps];
}

/** Stable `(calendarEventId, calendarIntegrationId)` series key for grouping routines. */
function seriesKey(routine: RoutineInterface): string {
    return `${routine.calendarEventId}:${routine.calendarIntegrationId ?? ''}`;
}

/**
 * Reactivates the caller's GCal-linked routines that have been stranded with a past `UNTIL` or
 * `active:false` (the stale-UNTIL deadlock). Per `(calendarEventId, calendarIntegrationId)` keeps the
 * most-recent row and revives only that one. CRITICAL: skips a series that ALREADY has a different
 * active routine (the legitimate post-dedupe state: one active + N inactive) — reviving the most-recent
 * INACTIVE row there would create a second active row and E11000 against `uniq_active_routine_per_gcal_series`,
 * 500ing the request and stranding two active rows that crash the next boot's index build. Returns the
 * recorded ops.
 */
export async function healStuckGCalRoutines(userId: string, now: string): Promise<OperationInterface[]> {
    const linked = await routinesDAO.findArray({ user: userId, calendarEventId: { $type: 'string' } });
    const seriesWithActive = new Set(linked.filter((routine) => routine.active).map(seriesKey));
    const keepersToRevive = mostRecentPerSeries(linked)
        .filter((routine) => isStuckRoutine(routine, now))
        // An inactive keeper whose series already has an active sibling would double-activate it — skip.
        .filter((routine) => routine.active || !seriesWithActive.has(seriesKey(routine)));
    const ops = await Promise.all(keepersToRevive.map((routine) => reviveRoutine(routine, userId, now)));
    return ops.flat();
}

/** Reduces routines to the most-recent row per `(calendarEventId, calendarIntegrationId)` series. */
function mostRecentPerSeries(routines: RoutineInterface[]): RoutineInterface[] {
    const bySeries = new Map<string, RoutineInterface[]>();
    for (const routine of routines) {
        bySeries.set(seriesKey(routine), [...(bySeries.get(seriesKey(routine)) ?? []), routine]);
    }
    return [...bySeries.values()].map((group) => [...group].sort(keeperFirst)[0]).filter((r): r is RoutineInterface => Boolean(r));
}

/** Groups GCal-linked routines into `(calendarEventId, calendarIntegrationId)` series buckets. */
function groupBySeries(routines: RoutineInterface[]): RoutineInterface[][] {
    const bySeries = new Map<string, RoutineInterface[]>();
    for (const routine of routines) {
        bySeries.set(seriesKey(routine), [...(bySeries.get(seriesKey(routine)) ?? []), routine]);
    }
    return [...bySeries.values()];
}

/** True when a routine is the stranded live tail of a GCal split: paused with an OPEN (no-UNTIL) rrule. */
function isStrandedSuccessor(routine: RoutineInterface): boolean {
    return !routine.active && !routine.rrule.includes('UNTIL=');
}

/**
 * Reactivates one stranded split-successor routine WITHOUT touching its rrule (it's already open),
 * linking it to the capped parent if not already linked. Records the op + regenerates future items.
 */
async function reviveSuccessor(successor: RoutineInterface, parentId: string | undefined, userId: string, now: string): Promise<OperationInterface[]> {
    const revived: RoutineInterface = {
        ...successor,
        active: true,
        ...(parentId && !successor.splitFromRoutineId ? { splitFromRoutineId: parentId } : {}),
        updatedTs: now,
    };
    try {
        await routinesDAO.replaceById(successor._id, revived);
    } catch (err) {
        // A concurrent heal run for the same user could have already activated a sibling on this series,
        // making this write violate uniq_active_routine_per_gcal_series. Treat the race loser as a no-op
        // (the series is already healed) rather than 500ing the request. Mirrors createRoutineFromGCal.
        if (isDuplicateKeyError(err)) {
            return [];
        }
        throw err;
    }
    const updateOp = await recordOperation(userId, { entityType: 'routine', entityId: successor._id, snapshot: revived, opType: 'update', now });
    const itemOps = await regenerateFutureRoutineItems(revived, userId, now);
    return [updateOp, ...itemOps];
}

/**
 * Recovers the caller's GCal "this and all following" splits whose open-ended successor routine was
 * stranded `active:false` — the failure mode where the live tail of a split never went active, so the
 * series shows nothing in the app even though GCal still produces occurrences.
 *
 * Per series (one `(calendarEventId, integration)` bucket): if there is NO active routine AND exactly
 * one stranded successor (open rrule, paused) AND at least one capped sibling (the parent), revive that
 * successor and link it to the most-recent capped sibling. UNLIKE `healStuckGCalRoutines`, this never
 * strips a UNTIL — the parent stays correctly capped (GCal truth) and only the already-open successor
 * is reactivated. CRITICAL: skips any series that already has an active routine so we never create a
 * second active row (E11000 against `uniq_active_routine_per_gcal_series`). Returns recorded ops.
 */
export async function healSplitSuccessorRoutines(userId: string, now: string): Promise<OperationInterface[]> {
    const linked = await routinesDAO.findArray({ user: userId, calendarEventId: { $type: 'string' } });
    const revivable = groupBySeries(linked).flatMap((series) => {
        if (series.some((r) => r.active)) {
            return [];
        }
        const successors = series.filter(isStrandedSuccessor);
        const cappedSiblings = series.filter((r) => r.rrule.includes('UNTIL='));
        // Need exactly one stranded successor to revive (ambiguous otherwise) plus a capped parent to
        // confirm this is a split, not a single paused routine the user deliberately stopped.
        if (successors.length !== 1 || !hasAtLeastOne(cappedSiblings)) {
            return [];
        }
        const [successor] = successors;
        const parent = [...cappedSiblings].sort(keeperFirst)[0];
        return successor ? [{ successor, parentId: parent?._id }] : [];
    });
    const ops = await Promise.all(revivable.map(({ successor, parentId }) => reviveSuccessor(successor, parentId, userId, now)));
    return ops.flat();
}
