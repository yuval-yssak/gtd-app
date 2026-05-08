import type { RoutineInterface } from '../../../types/entities.js';

/**
 * Allowlist projection for routine API responses. Mirrors `presentItem`'s pattern: an explicit
 * field list rather than an `Omit` so that future internal sync-anchor fields added to
 * `RoutineInterface` do not silently leak into the public schema.
 *
 * `user` is excluded — bearer auth implies the user, so re-stating it on every row is redundant
 * and would diverge from `presentPerson` / `presentWorkContext`. The internal sync anchors
 * (`lastPushedToGCalTs`, `lastSyncedNotes`) are excluded as server-maintained state. The
 * deprecated `triggerMode`/`afterCompletionDelayDays` are excluded so the public API doesn't
 * advertise the deprecated path. `splitFromRoutineId`, `lastGeneratedDate`, and
 * `routineExceptions` ARE returned in reads (callers genuinely need to see exception state and
 * split-history) but are gated as read-only — see `WRITABLE_FIELDS` in `routines.ts`.
 */
export type PublicRoutine = Pick<
    RoutineInterface,
    | '_id'
    | 'title'
    | 'routineType'
    | 'rrule'
    | 'calendarEventId'
    | 'calendarIntegrationId'
    | 'calendarSyncConfigId'
    | 'splitFromRoutineId'
    | 'template'
    | 'active'
    | 'createdTs'
    | 'updatedTs'
    | 'startDate'
    | 'calendarItemTemplate'
    | 'lastGeneratedDate'
    | 'routineExceptions'
>;

const PUBLIC_FIELDS: ReadonlyArray<keyof PublicRoutine> = [
    '_id',
    'title',
    'routineType',
    'rrule',
    'calendarEventId',
    'calendarIntegrationId',
    'calendarSyncConfigId',
    'splitFromRoutineId',
    'template',
    'active',
    'createdTs',
    'updatedTs',
    'startDate',
    'calendarItemTemplate',
    'lastGeneratedDate',
    'routineExceptions',
];

export function presentRoutine(routine: RoutineInterface): PublicRoutine {
    const out: Partial<PublicRoutine> = {};
    for (const key of PUBLIC_FIELDS) {
        const value = routine[key];
        if (value !== undefined) {
            (out as Record<string, unknown>)[key] = value;
        }
    }
    return out as PublicRoutine;
}
