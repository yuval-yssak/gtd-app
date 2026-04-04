import dayjs from 'dayjs';
import { RRule, type Weekday } from 'rrule';
import { hasAtLeastOne } from './typeUtils';

/**
 * Parse an rrule string (without DTSTART) into an RRule instance anchored to a given date.
 * DTSTART must be supplied separately because next-action routines set it dynamically
 * to the completion date rather than using a fixed start.
 */
function parseRrule(rruleStr: string, dtstart: Date): RRule {
    const rule = RRule.fromString(rruleStr);
    return new RRule({ ...rule.options, dtstart });
}

/**
 * Return the first rrule occurrence that falls strictly after `afterDate`.
 * Used by next-action routines to compute the next due date from the completion date.
 */
export function computeNextOccurrence(rruleStr: string, afterDate: Date): Date {
    const rule = parseRrule(rruleStr, afterDate);
    const next = rule.after(afterDate, false);
    if (!next) throw new Error(`rrule "${rruleStr}" has no occurrence after ${dayjs(afterDate).toISOString()}`);
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
