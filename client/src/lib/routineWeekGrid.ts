import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { RRule } from 'rrule';
import type { StoredRoutine } from '../types/MyDB';
import { normalizeByWeekday } from './rruleUtils';
import { hasAtLeastOne } from './typeUtils';

dayjs.extend(utc);

/** Monday-first day labels, matching rrule's weekday numbering (0 = Monday). */
export const WEEK_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

const hasExplicitByDay = (rruleStr: string) => /(^|;)BYDAY=/i.test(rruleStr);
const isCappedSeries = (rruleStr: string) => /(^|;)(UNTIL|COUNT)=/i.test(rruleStr);

/**
 * The fixed weekday indexes (0 = Monday) a routine fires on every single week, or null when it
 * has no such rhythm: interval > 1, monthly and beyond, a plain WEEKLY with no BYDAY (its day
 * floats with the anchor date), an exhausted capped series, or an unparseable rule.
 *
 * Takes the whole routine (not just the rrule) because COUNT/UNTIL exhaustion can only be
 * evaluated against the series' real anchor date — GCal-imported rules carry their own caps.
 */
export function fixedWeekdaysOf(routine: StoredRoutine): number[] | null {
    const rruleStr = routine.rrule;
    try {
        const anchor = dayjs(routine.startDate ?? routine.createdTs);
        const rule = RRule.fromString(`DTSTART:${anchor.utc().format('YYYYMMDDTHHmmss')}Z\nRRULE:${rruleStr}`);
        const { freq, interval = 1, byweekday } = rule.options;
        if (interval !== 1) {
            return null;
        }
        // A capped series (UNTIL/COUNT) that has run out no longer has a weekly rhythm to show.
        if (isCappedSeries(rruleStr) && !rule.after(dayjs().toDate(), true)) {
            return null;
        }
        // rrule backfills options.byweekday from DTSTART on a bare WEEKLY — trust it only when
        // the raw rule states BYDAY explicitly.
        const explicitByDay = hasExplicitByDay(rruleStr) ? [...new Set(normalizeByWeekday(byweekday))].sort((a, b) => a - b) : null;
        if (freq === RRule.DAILY) {
            // GCal's "every weekday" arrives as DAILY;BYDAY=MO,TU,WE,TH,FR — BYDAY limits DAILY.
            return explicitByDay ?? ALL_WEEKDAYS;
        }
        if (freq !== RRule.WEEKLY) {
            return null;
        }
        return explicitByDay && hasAtLeastOne(explicitByDay) ? explicitByDay : null;
    } catch {
        return null;
    }
}

export interface RoutineWeekGridData {
    /** 7 entries, Monday-first — the routines that fire on that weekday every week. */
    days: StoredRoutine[][];
    /** Routines with no fixed weekly slot (every N days/weeks, monthly and beyond) — listed below the grid. */
    lessFrequent: StoredRoutine[];
}

// Timeless routines (next-action, all-day) sort after timed ones within a day.
const timeOfDayKey = (routine: StoredRoutine) => routine.calendarItemTemplate?.timeOfDay ?? '99:99';

/** Place a tab's routines on a Mon–Sun grid; within a day, timed routines sort by time then title. */
export function buildRoutineWeekGrid(routines: StoredRoutine[]): RoutineWeekGridData {
    const placements = routines.map((routine) => ({ routine, weekdays: fixedWeekdaysOf(routine) }));
    return {
        days: ALL_WEEKDAYS.map((day) =>
            placements
                .filter((placement) => placement.weekdays?.includes(day))
                .map((placement) => placement.routine)
                .sort((a, b) => timeOfDayKey(a).localeCompare(timeOfDayKey(b)) || a.title.localeCompare(b.title)),
        ),
        lessFrequent: placements.filter((placement) => placement.weekdays === null).map((placement) => placement.routine),
    };
}
