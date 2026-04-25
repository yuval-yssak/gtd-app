import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { RRule, type Weekday } from 'rrule';
import type { StoredRoutine } from '../types/MyDB';
import { hasAtLeastOne } from './typeUtils';

dayjs.extend(utc);

/**
 * Parse an rrule string (without DTSTART) into an RRule instance anchored to a given date.
 * DTSTART must be supplied separately because next-action routines set it dynamically
 * to the completion date rather than using a fixed start.
 */
function parseRrule(rruleStr: string, dtstart: Date): RRule {
    // Embed DTSTART in the rrule string rather than spreading rule.options.
    // RRule.fromString() without a DTSTART inherits byhour/byminute/bysecond from the
    // current clock time, so spreading those options produces occurrences at the wrong
    // time of day (e.g. the test run's clock time instead of the intended anchor time).
    const dtStartStr = `${dayjs(dtstart).utc().format('YYYYMMDDTHHmmss')}Z`;
    return RRule.fromString(`DTSTART:${dtStartStr}\nRRULE:${rruleStr}`);
}

/**
 * Return the first rrule occurrence at or after `afterDate`.
 * - `includeAnchor=false` (default): strictly after — used after item completion so a same-day
 *   completion advances to the next occurrence.
 * - `includeAnchor=true`: the anchor itself counts — used when generating the *first* item for a
 *   brand-new routine so a daily/interval rule lands today rather than tomorrow.
 */
export function computeNextOccurrence(rruleStr: string, afterDate: Date, includeAnchor = false): Date {
    const rule = parseRrule(rruleStr, afterDate);
    const next = rule.after(afterDate, includeAnchor);
    if (!next) {
        throw new Error(`rrule "${rruleStr}" has no occurrence after ${dayjs(afterDate).toISOString()}`);
    }
    return next;
}

const WEEKDAY_NAMES: Record<number, string> = { 0: 'Mon', 1: 'Tue', 2: 'Wed', 3: 'Thu', 4: 'Fri', 5: 'Sat', 6: 'Sun' };

/** Convert an rrule string into a short human-readable label, e.g. "Every 3 days" or "Every Mon & Thu". */
export function formatRrule(rruleStr: string): string {
    try {
        // Provide a dummy DTSTART so RRule.fromString can parse without error
        const rule = RRule.fromString(`DTSTART:20240101T000000Z\nRRULE:${rruleStr}`);
        const { freq, interval = 1, byweekday, bymonthday } = rule.options;

        if (freq === RRule.YEARLY) {
            return 'Every year';
        }

        if (freq === RRule.MONTHLY) {
            const dayArr = Array.isArray(bymonthday) ? bymonthday : null;
            // hasAtLeastOne narrows bymonthday[0] to number — avoids the T | undefined index access type
            const day = dayArr && hasAtLeastOne(dayArr) ? dayArr[0] : typeof bymonthday === 'number' ? bymonthday : null;
            // If BYMONTHDAY is absent, fall through to rule.toText() rather than fabricating a wrong label
            if (day !== null) {
                if (interval > 1) {
                    return `Every ${day}th of every ${interval} months`;
                }
                return `Every ${day}th of the month`;
            }
        }

        if (freq === RRule.WEEKLY) {
            const days = (Array.isArray(byweekday) ? byweekday : [byweekday])
                // Weekday 0 (Monday) is falsy — check != null instead of Boolean() to avoid filtering it out
                .filter((d) => d != null)
                .map((d) => {
                    // rrule byweekday entries are bare numbers (0–6) or Weekday objects with a .weekday property
                    const weekdayNum = typeof d === 'number' ? d : (d as Weekday).weekday;
                    return WEEKDAY_NAMES[weekdayNum] ?? '';
                })
                .join(' & ');
            if (interval > 1) {
                return days ? `Every ${days}, every ${interval} weeks` : `Every ${interval} weeks`;
            }
            return days ? `Every ${days}` : 'Every week';
        }

        if (freq === RRule.DAILY) {
            if (interval === 1) {
                return 'Every day';
            }
            return `Every ${interval} days`;
        }

        return rule.toText();
    } catch {
        return rruleStr;
    }
}

/** Format duration in minutes as a human-readable string, e.g. 90 → "1h 30m", 60 → "1h", 45 → "45m". */
function formatDuration(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
}

/**
 * Format a calendar routine's schedule as a human-readable string combining frequency, time, duration,
 * and date range (for split routines). Examples:
 * - "Every Thu at 18:00 for 3h"
 * - "Every 3 days at 09:00 for 1h, until Apr 14"
 * - "Every 3 days at 09:00 for 1h, from Apr 15"
 */
export function formatCalendarRrule(routine: StoredRoutine): string {
    const freqPart = formatRrule(routine.rrule);
    const { calendarItemTemplate } = routine;
    if (!calendarItemTemplate) {
        return freqPart;
    }
    const timePart = `at ${calendarItemTemplate.timeOfDay}`;
    const durationPart = `for ${formatDuration(calendarItemTemplate.duration)}`;
    const rangePart = formatDateRange(routine);
    return `${freqPart} ${timePart} ${durationPart}${rangePart}`;
}

/** Extracts date range context for split routines (UNTIL for the head, start date for the tail). */
function formatDateRange(routine: StoredRoutine): string {
    const parts: string[] = [];

    if (routine.splitFromRoutineId) {
        parts.push(`from ${dayjs(routine.createdTs).format('MMM D')}`);
    }

    const untilMatch = routine.rrule.match(/UNTIL=(\d{4})(\d{2})(\d{2})/);
    if (untilMatch) {
        const untilDate = dayjs(`${untilMatch[1]}-${untilMatch[2]}-${untilMatch[3]}`);
        parts.push(`until ${untilDate.format('MMM D')}`);
    }

    const countMatch = routine.rrule.match(/COUNT=(\d+)/);
    if (countMatch?.[1]) {
        const count = parseInt(countMatch[1], 10);
        parts.push(`${count} occurrence${count === 1 ? '' : 's'}`);
    }

    if (!hasAtLeastOne(parts)) {
        return '';
    }
    return `, ${parts.join(', ')}`;
}
