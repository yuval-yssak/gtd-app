import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { RRule } from 'rrule';

dayjs.extend(utc);

/**
 * Build an RRule for a calendar routine anchored at UTC midnight of `createdTs`.
 * Mirrors the `buildCalendarRule` pattern in routineItemHelpers.ts.
 */
function buildCalendarRule(rruleStr: string, createdTs: string): RRule {
    const dtStartStr = `${createdTs.slice(0, 10).replace(/-/g, '')}T000000Z`;
    return RRule.fromString(`DTSTART:${dtStartStr}\nRRULE:${rruleStr}`);
}

/** True if the routine's rrule still has at least one occurrence after today. */
export function routineHasUpcomingOccurrence(rrule: string, createdTs: string): boolean {
    const rule = buildCalendarRule(rrule, createdTs);
    return rule.after(dayjs().toDate(), false) !== null;
}

/**
 * Return the ISO date (YYYY-MM-DD) of the next rrule occurrence after today.
 * This is the first date the new tail routine will own after a split.
 * Returns null if the series is exhausted.
 */
export function computeSplitDate(rrule: string, createdTs: string): string | null {
    const rule = buildCalendarRule(rrule, createdTs);
    const next = rule.after(dayjs().toDate(), false);
    if (!next) return null;
    return next.toISOString().slice(0, 10);
}

/** Strip UNTIL and COUNT clauses from an rrule string, regardless of position. */
export function stripEndClauses(rruleStr: string): string {
    return rruleStr
        .replace(/(^|;)UNTIL=[^;]*/g, '')
        .replace(/(^|;)COUNT=\d+/g, '')
        .replace(/^;/, '');
}

/**
 * Cap an rrule by adding UNTIL for the day before `beforeDate` (at 23:59:59 UTC).
 * Strips any existing UNTIL/COUNT before appending.
 */
export function addUntilToRrule(rrule: string, beforeDate: string): string {
    const base = stripEndClauses(rrule);
    const dayBefore = dayjs.utc(beforeDate).subtract(1, 'day').format('YYYYMMDD');
    return `${base};UNTIL=${dayBefore}T235959Z`;
}
