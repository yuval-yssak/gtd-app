import type { StoredRoutine } from '../../types/MyDB';

interface RoutineEditIntent {
    routineType: StoredRoutine['routineType'];
    rrule: string;
    timeOfDay: string | undefined;
    duration: number | undefined;
}

/**
 * Canonicalize an rrule string by parsing each clause, normalizing multi-value clauses
 * (sorting BYDAY list, collapsing UNTIL to its UTC calendar date), and re-serializing with a
 * stable clause order. Two rrules with the same schedule compare equal, even if they differ in:
 *  - clause order (stored `FREQ;UNTIL;BYDAY` vs dialog-rebuilt `FREQ;BYDAY;UNTIL`)
 *  - UNTIL time-of-day within the same UTC date (`20:59:59Z` vs `23:59:59Z`)
 *  - BYDAY list order (`MO,WE,FR` vs `FR,MO,WE`)
 *
 * This is a regex-based shape comparator (no rrule.js dep) so corrupted UNTIL values like
 * "Invalid Date" don't bypass canonicalization and trip the schedule-changed check.
 */
function canonicalRruleKey(rruleStr: string) {
    const parts = rruleStr.split(';').filter(Boolean);
    const bag = new Map<string, string>();
    for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq < 0) {
            continue;
        }
        const key = part.slice(0, eq).toUpperCase();
        const value = part.slice(eq + 1);
        if (key === 'BYDAY') {
            bag.set(
                key,
                value
                    .split(',')
                    .map((d) => d.trim().toUpperCase())
                    .sort()
                    .join(','),
            );
        } else if (key === 'UNTIL') {
            // Keep only the calendar date portion: edit round-trips vary time-of-day.
            const dateMatch = value.match(/^(\d{8})/);
            bag.set(key, dateMatch?.[1] ?? value);
        } else {
            bag.set(key, value);
        }
    }
    const stableOrder = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST', 'COUNT', 'UNTIL'];
    const known = stableOrder.filter((k) => bag.has(k)).map((k) => `${k}=${bag.get(k)}`);
    const other = [...bag.keys()]
        .filter((k) => !stableOrder.includes(k))
        .sort()
        .map((k) => `${k}=${bag.get(k)}`);
    return [...known, ...other].join(';');
}

/**
 * Returns true when a calendar routine's schedule (RRULE, start time, or duration) changed.
 * A title- or notes-only edit returns false — the split path is reserved for schedule changes
 * so that past instances keep their original schedule. A non-calendar → calendar type switch
 * introduces a schedule template and also counts as a schedule change.
 */
export function isCalendarScheduleChanged(previous: StoredRoutine, edited: RoutineEditIntent) {
    if (edited.routineType !== 'calendar') {
        return false;
    }
    if (canonicalRruleKey(previous.rrule) !== canonicalRruleKey(edited.rrule)) {
        return true;
    }
    if (previous.calendarItemTemplate?.timeOfDay !== edited.timeOfDay) {
        return true;
    }
    return previous.calendarItemTemplate?.duration !== edited.duration;
}
