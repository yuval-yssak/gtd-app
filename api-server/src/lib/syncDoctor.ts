import dayjs from 'dayjs';
import type AbstractDAO from '../dataAccess/abstractDAO.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import type { EntitySnapshot, EntityType, ItemInterface, OperationInterface, RoutineInterface } from '../types/entities.js';
import { recordOperation } from './operationHelpers.js';
import { extractUntilFromRrule } from './rruleHelpers.js';

/**
 * Read-only invariant sweep over one user's sync-visible state — the "sync doctor". Every check
 * corresponds to a bug class this codebase has actually shipped a fix for; the doctor exists so
 * the NEXT instance of any of them is a report line instead of a phantom meeting the user notices
 * days later. Reporting and healing are deliberately separate: the only write this module offers
 * is the narrowly-scoped poisoned-watermark re-stamp, and callers must opt into it.
 */

/** Mirrors the client's escape-hatch tolerance — ordinary device clock skew is not poisoning. */
const POISONED_WATERMARK_TOLERANCE_MINUTES = 5;

export interface DuplicateActiveSeriesFinding {
    calendarEventId: string;
    calendarIntegrationId: string | null;
    routineIds: string[];
}

export interface PhantomItemsFinding {
    routineId: string;
    itemIds: string[];
}

export interface DuplicateLiveItemsFinding {
    calendarEventId: string;
    itemIds: string[];
}

export interface UnmarkedRetiredRoutineFinding {
    routineId: string;
    rrule: string;
}

export interface PoisonedWatermarkFinding {
    entityType: EntityType;
    entityId: string;
    updatedTs: string;
}

export interface FutureCursorFinding {
    deviceId: string;
    lastSyncedTs: string;
}

export interface DanglingIntegrationRefFinding {
    entityType: 'item' | 'routine';
    entityId: string;
    calendarIntegrationId: string;
}

export interface SyncDoctorReport {
    duplicateActiveRoutineSeries: DuplicateActiveSeriesFinding[];
    phantomItemsOnInactiveRoutines: PhantomItemsFinding[];
    duplicateLiveCalendarItems: DuplicateLiveItemsFinding[];
    unmarkedRetiredRoutines: UnmarkedRetiredRoutineFinding[];
    poisonedWatermarks: PoisonedWatermarkFinding[];
    futureCursors: FutureCursorFinding[];
    danglingIntegrationRefs: DanglingIntegrationRefFinding[];
    healedPoisonedWatermarks: number;
    healthy: boolean;
}

/** One user's sync-visible state, loaded once and shared by every check. */
interface UserSyncState {
    items: ItemInterface[];
    routines: RoutineInterface[];
    people: EntitySnapshot[];
    workContexts: EntitySnapshot[];
    deviceCursors: Array<{ deviceId: string; lastSyncedTs: string }>;
    integrationIds: Set<string>;
}

async function loadUserSyncState(userId: string): Promise<UserSyncState> {
    const [items, routines, people, workContexts, deviceStates, integrations] = await Promise.all([
        itemsDAO.findArray({ user: userId }),
        routinesDAO.findArray({ user: userId }),
        peopleDAO.findArray({ user: userId }),
        workContextsDAO.findArray({ user: userId }),
        deviceSyncStateDAO.findArray({ user: userId }),
        calendarIntegrationsDAO.findArray({ user: userId }),
    ]);
    return {
        items,
        routines,
        people,
        workContexts,
        deviceCursors: deviceStates.map((row) => ({ deviceId: row.deviceId, lastSyncedTs: row.lastSyncedTs })),
        integrationIds: new Set(integrations.map((integration) => integration._id)),
    };
}

/** Groups values by key, returning only groups with more than one member. */
function duplicateGroups<T>(values: T[], keyOf: (value: T) => string | null): Map<string, T[]> {
    const byKey = new Map<string, T[]>();
    for (const value of values) {
        const key = keyOf(value);
        if (key !== null) {
            byKey.set(key, [...(byKey.get(key) ?? []), value]);
        }
    }
    return new Map([...byKey.entries()].filter(([, group]) => group.length > 1));
}

/**
 * More than one ACTIVE routine on a `(calendarEventId, calendarIntegrationId)` series. The partial
 * unique index enforces this at write time, so a finding here means index-bypassing writes (a
 * direct migration/script) or an unmigrated database — either way the next boot's index build crashes.
 */
function findDuplicateActiveRoutineSeries(routines: RoutineInterface[]): DuplicateActiveSeriesFinding[] {
    const active = routines.filter((routine) => routine.active && typeof routine.calendarEventId === 'string');
    const groups = duplicateGroups(active, (routine) => `${routine.calendarEventId}:${routine.calendarIntegrationId ?? ''}`);
    return [...groups.values()].map((group) => ({
        calendarEventId: group[0]?.calendarEventId ?? '',
        calendarIntegrationId: group[0]?.calendarIntegrationId ?? null,
        routineIds: group.map((routine) => routine._id),
    }));
}

/**
 * Live FUTURE calendar items whose generating routine is inactive — the "phantom meeting" class:
 * the routine was retired (split, cancellation, reap) but its future occurrences were left live.
 */
function findPhantomItemsOnInactiveRoutines(state: UserSyncState, now: string): PhantomItemsFinding[] {
    const inactiveRoutineIds = new Set(state.routines.filter((routine) => !routine.active).map((routine) => routine._id));
    const phantoms = state.items.filter(
        // dayjs, not string comparison: timeStart carries the event's local offset (+03:00 etc.)
        // while `now` is UTC — lexicographic ordering across offsets misclassifies same-day items.
        (item) =>
            item.status === 'calendar' &&
            item.routineId !== undefined &&
            item.timeStart !== undefined &&
            inactiveRoutineIds.has(item.routineId) &&
            !dayjs(item.timeStart).isBefore(dayjs(now)),
    );
    const byRoutine = phantoms.reduce(
        (groups, item) => groups.set(item.routineId ?? '', [...(groups.get(item.routineId ?? '') ?? []), item._id ?? '']),
        new Map<string, string[]>(),
    );
    return [...byRoutine.entries()].map(([routineId, itemIds]) => ({ routineId, itemIds }));
}

/** More than one live `calendar` item per GCal event — the duplicate-item class the unique index closes. */
function findDuplicateLiveCalendarItems(items: ItemInterface[]): DuplicateLiveItemsFinding[] {
    const live = items.filter((item) => item.status === 'calendar' && typeof item.calendarEventId === 'string');
    const groups = duplicateGroups(live, (item) => item.calendarEventId ?? null);
    return [...groups.entries()].map(([calendarEventId, group]) => ({
        calendarEventId,
        itemIds: group.map((item) => item._id ?? ''),
    }));
}

/**
 * GCal-linked routines shaped exactly like a cancellation retirement (inactive + past UNTIL) but
 * missing `retiredByGCal` — rows retired before the marker shipped. Each one is a "Repair sync"
 * resurrection waiting to happen; the fix is stamping the marker (see retireOrphanedSeriesSuccessor.ts).
 */
function findUnmarkedRetiredRoutines(routines: RoutineInterface[], now: string): UnmarkedRetiredRoutineFinding[] {
    return routines
        .filter((routine) => {
            if (!routine.calendarEventId || routine.active || routine.retiredByGCal) {
                return false;
            }
            const until = extractUntilFromRrule(routine.rrule);
            return until !== null && dayjs(until).isBefore(dayjs(now));
        })
        .map((routine) => ({ routineId: routine._id, rrule: routine.rrule }));
}

/** Entity rows stamped in the future — poisoned LWW watermarks that silently drop later edits. */
function findPoisonedWatermarks(state: UserSyncState, now: string): PoisonedWatermarkFinding[] {
    const horizon = dayjs(now).add(POISONED_WATERMARK_TOLERANCE_MINUTES, 'minute').toISOString();
    const byType: Array<[EntityType, Array<{ _id?: string; updatedTs: string }>]> = [
        ['item', state.items],
        ['routine', state.routines],
        ['person', state.people],
        ['workContext', state.workContexts],
    ];
    return byType.flatMap(([entityType, rows]) =>
        rows.filter((row) => row.updatedTs > horizon).map((row) => ({ entityType, entityId: row._id ?? '', updatedTs: row.updatedTs })),
    );
}

/** Device cursors ahead of the wall clock — a cursor that skips every op until its timestamp passes. */
function findFutureCursors(state: UserSyncState, now: string): FutureCursorFinding[] {
    const horizon = dayjs(now).add(POISONED_WATERMARK_TOLERANCE_MINUTES, 'minute').toISOString();
    return state.deviceCursors.filter((cursor) => cursor.lastSyncedTs > horizon);
}

/**
 * Live entities pointing at a calendar integration that no longer exists — the known
 * disconnect-remove cascade gap. These rows can neither push to GCal nor be repaired by sync.
 */
function findDanglingIntegrationRefs(state: UserSyncState): DanglingIntegrationRefFinding[] {
    const itemRefs = state.items
        .filter((item) => item.status !== 'trash' && item.calendarIntegrationId !== undefined && !state.integrationIds.has(item.calendarIntegrationId))
        .map((item) => ({ entityType: 'item' as const, entityId: item._id ?? '', calendarIntegrationId: item.calendarIntegrationId ?? '' }));
    const routineRefs = state.routines
        .filter((routine) => routine.calendarIntegrationId !== undefined && !state.integrationIds.has(routine.calendarIntegrationId))
        .map((routine) => ({ entityType: 'routine' as const, entityId: routine._id, calendarIntegrationId: routine.calendarIntegrationId ?? '' }));
    return [...itemRefs, ...routineRefs];
}

/**
 * The one write the doctor offers: re-stamp a poisoned row's `updatedTs` to `now` and record the
 * op. Other devices converge on pull — their local copies carry the same poisoned (far-future)
 * watermark, which the client's poisoned-watermark escape hatch lets this corrected snapshot
 * overwrite despite being LWW-older.
 */
/** Exported for unit testing — the guarded re-read below is unreachable through `runSyncDoctor` alone. */
export function healPoisonedWatermark(userId: string, finding: PoisonedWatermarkFinding, now: string): Promise<OperationInterface | null> {
    // Per-type dispatch keeps each restamp call generic over ONE concrete DAO — `AbstractDAO<T>`
    // is invariant in T, so a union-typed DAO would demand the (unsatisfiable) intersection type.
    switch (finding.entityType) {
        case 'item':
            return restampEntity(itemsDAO, userId, finding, now);
        case 'routine':
            return restampEntity(routinesDAO, userId, finding, now);
        case 'person':
            return restampEntity(peopleDAO, userId, finding, now);
        case 'workContext':
            return restampEntity(workContextsDAO, userId, finding, now);
    }
}

async function restampEntity<T extends EntitySnapshot>(
    dao: AbstractDAO<T>,
    userId: string,
    finding: PoisonedWatermarkFinding,
    now: string,
): Promise<OperationInterface | null> {
    const fresh = await dao.findByOwnerAndId(finding.entityId, userId);
    // Guarded re-read: only restamp the exact poisoned state the report saw — a concurrent write
    // that already changed the row supersedes the finding.
    if (!fresh || fresh.updatedTs !== finding.updatedTs) {
        return null;
    }
    // Cast: under an unresolved generic the Mongo driver widens `_id` to `InferIdType<T>`; every
    // concrete instantiation (the four DAOs above) stores string ids, so the spread is a T.
    const restamped = { ...fresh, updatedTs: now } as unknown as T;
    await dao.replaceById(finding.entityId, restamped);
    return recordOperation(userId, { entityType: finding.entityType, entityId: finding.entityId, snapshot: restamped, opType: 'update', now });
}

export interface SyncDoctorOptions {
    /** Opt-in: re-stamp poisoned watermarks to `now` and record ops. Everything else stays read-only. */
    healPoisonedWatermarks?: boolean;
}

export async function runSyncDoctor(userId: string, now: string, options: SyncDoctorOptions = {}): Promise<SyncDoctorReport> {
    const state = await loadUserSyncState(userId);
    const poisonedWatermarks = findPoisonedWatermarks(state, now);

    const healed = options.healPoisonedWatermarks
        ? (await Promise.all(poisonedWatermarks.map((finding) => healPoisonedWatermark(userId, finding, now)))).filter((op) => op !== null)
        : [];

    const report: SyncDoctorReport = {
        duplicateActiveRoutineSeries: findDuplicateActiveRoutineSeries(state.routines),
        phantomItemsOnInactiveRoutines: findPhantomItemsOnInactiveRoutines(state, now),
        duplicateLiveCalendarItems: findDuplicateLiveCalendarItems(state.items),
        unmarkedRetiredRoutines: findUnmarkedRetiredRoutines(state.routines, now),
        poisonedWatermarks,
        futureCursors: findFutureCursors(state, now),
        danglingIntegrationRefs: findDanglingIntegrationRefs(state),
        healedPoisonedWatermarks: healed.length,
        healthy: false,
    };
    report.healthy = isHealthy(report);
    return report;
}

function isHealthy(report: SyncDoctorReport): boolean {
    return (
        report.duplicateActiveRoutineSeries.length === 0 &&
        report.phantomItemsOnInactiveRoutines.length === 0 &&
        report.duplicateLiveCalendarItems.length === 0 &&
        report.unmarkedRetiredRoutines.length === 0 &&
        report.poisonedWatermarks.length === 0 &&
        report.futureCursors.length === 0 &&
        report.danglingIntegrationRefs.length === 0
    );
}
