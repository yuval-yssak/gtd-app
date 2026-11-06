import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import type { RoutineInterface } from '../types/entities.js';
import { extractUntilFromRrule } from './rruleHelpers.js';
import { effectiveSeriesEndIso } from './splitChainResolution.js';

dayjs.extend(utc);

type RoutineException = NonNullable<RoutineInterface['routineExceptions']>[number];

/**
 * The routine without the per-date exceptions its series no longer reaches (past UNTIL or the last
 * COUNT occurrence). Google drops those instances when the master is capped, but the stored list
 * kept them — one capped daily routine carried 165 dead entries on every op snapshot, forever.
 * Returns the same object when nothing is dropped, so callers can skip a no-op write.
 */
export function withoutExceptionsPastSeriesEnd(routine: RoutineInterface): RoutineInterface {
    const kept = exceptionsWithinSeries(routine, routine.routineExceptions ?? []);
    return kept.length === (routine.routineExceptions ?? []).length ? routine : withExceptions(routine, kept);
}

/** `exceptions` minus those dated after the routine's last occurrence (day granularity, UNTIL day inclusive). */
export function exceptionsWithinSeries(routine: RoutineInterface, exceptions: RoutineException[]): RoutineException[] {
    // Computed once per list: a COUNT end expands the rule, ~1s for 100 per-exception expansions.
    const lastDate = lastSeriesDate(routine);
    return lastDate === null ? exceptions : exceptions.filter((exception) => exception.date <= lastDate);
}

/** The routine without exceptions dated on or after `date` (YYYY-MM-DD) — the pause cutoff. */
export function withoutExceptionsFrom(routine: RoutineInterface, date: string): RoutineInterface {
    const exceptions = routine.routineExceptions ?? [];
    const kept = exceptions.filter((exception) => exception.date < date);
    return kept.length === exceptions.length ? routine : withExceptions(routine, kept);
}

/**
 * YYYY-MM-DD of the series' last occurrence, or null when open-ended. A COUNT series without an
 * explicit startDate counts as open: its createdTs anchor is DTSTART's UTC date, a day early for an
 * early-morning start east of UTC, which would prune the last real occurrence's exception.
 */
function lastSeriesDate(routine: RoutineInterface): string | null {
    if (!routine.startDate && !extractUntilFromRrule(routine.rrule)) {
        return null;
    }
    const endIso = effectiveSeriesEndIso(routine.rrule, (routine.startDate ?? routine.createdTs).slice(0, 10));
    return endIso === null ? null : dayjs.utc(endIso).format('YYYY-MM-DD');
}

/** Omits the key when nothing is left, matching the split composite's head cap. */
function withExceptions(routine: RoutineInterface, kept: RoutineException[]): RoutineInterface {
    const { routineExceptions: _dropped, ...rest } = routine;
    return kept.length > 0 ? { ...rest, routineExceptions: kept } : rest;
}
