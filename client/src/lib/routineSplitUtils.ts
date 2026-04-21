import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type { IDBPDatabase } from 'idb';
import { RRule } from 'rrule';
import type { MyDB } from '../types/MyDB';

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

/**
 * True if the routine has at least one calendar item whose `timeStart` is before today.
 * Routines without any historical items can be edited in place without losing context.
 * The `timeStart` presence check matters — a `calendar`-status item without a `timeStart`
 * would lexicographically compare less than any YYYY-MM-DD date and incorrectly force a split.
 * The lexicographic `<` is safe because `'YYYY-MM-DDTHH:MM:SS' < 'YYYY-MM-DD'` iff the date
 * portion is strictly earlier (since `'T' > '-'` at position 10).
 */
export async function routineHasPastItems(db: IDBPDatabase<MyDB>, userId: string, routineId: string): Promise<boolean> {
    const todayStr = dayjs().startOf('day').format('YYYY-MM-DD');
    const all = await db.getAllFromIndex('items', 'userId', userId);
    return all.some((i) => i.routineId === routineId && i.status === 'calendar' && i.timeStart !== undefined && i.timeStart < todayStr);
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
