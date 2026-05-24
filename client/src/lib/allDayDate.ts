import dayjs from 'dayjs';

/**
 * Inclusive (user-visible) end-date → GCal exclusive end-date. A single-day all-day event on
 * 2026-05-27 has inclusive end 2026-05-27 and GCal-exclusive end 2026-05-28.
 */
export function toGCalExclusive(inclusiveEndDate: string): string {
    return dayjs(inclusiveEndDate).add(1, 'day').format('YYYY-MM-DD');
}

/** GCal exclusive end-date → inclusive (user-visible) end-date. Inverse of toGCalExclusive. */
export function fromGCalExclusive(exclusiveEndDate: string): string {
    return dayjs(exclusiveEndDate).subtract(1, 'day').format('YYYY-MM-DD');
}

/**
 * Renders a YYYY-MM-DD all-day date as `MMM D` (or your chosen short format) WITHOUT applying
 * any timezone adjustment. dayjs(s).tz(...) would shift "May 23" to "May 22" in negative-offset
 * zones — for all-day events the date is the calendar owner's local date, not a tz-anchored
 * moment, so we parse and format in the naive parser to keep the string verbatim.
 */
export function formatAllDayDate(dateStr: string, format = 'MMM D'): string {
    return dayjs(dateStr).format(format);
}

/** True when timeStart looks like a YYYY-MM-DD all-day date (no T component). */
export function isAllDayDateString(s: string | undefined): boolean {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
