import dayjs, { type Dayjs } from 'dayjs';

/** The year-less date styles the UI shows; `formatDisplayDate` adds the year when it is needed. */
export type DisplayDatePattern = 'MMM D' | 'ddd, MMM D' | 'ddd MMM D' | 'dddd, MMM D';

/**
 * Formats a date for display, appending ", YYYY" only when it is not in the current year — a bare
 * "Oct 27" on a date from last October reads as upcoming, not history. Times are the caller's to append.
 */
export function formatDisplayDate(date: Dayjs, pattern: DisplayDatePattern, now = dayjs()) {
    return date.format(date.isSame(now, 'year') ? pattern : `${pattern}, YYYY`);
}
