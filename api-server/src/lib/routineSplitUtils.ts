import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);

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
 *
 * Mirrors the client-side helper at `client/src/lib/routineSplitUtils.ts:62`. Kept as a thin
 * server copy so the split orchestrator doesn't reach across packages — the function is small
 * and self-contained, the alternative (a shared package) is heavier than the duplication cost.
 */
export function addUntilToRrule(rrule: string, beforeDate: string): string {
    const base = stripEndClauses(rrule);
    const dayBefore = dayjs.utc(beforeDate).subtract(1, 'day').format('YYYYMMDD');
    return `${base};UNTIL=${dayBefore}T235959Z`;
}
